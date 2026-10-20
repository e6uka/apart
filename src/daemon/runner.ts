import path from "node:path";
import util from "node:util";
import vm from "node:vm";
import type { BrowserBackend } from "./backend";
import { createConfinedFs, resolveInside } from "./confined-fs";
import { Page, type Ownership } from "./page";
import { MAX_URLS_PER_RUN, sanitizeUrl, type TabInfo } from "../shared/protocol";

export interface RunOptions {
  code: string;
  runDir: string;
  timeoutMs: number;
  bridge: BrowserBackend;
  keepTabs?: boolean;
  emit: (text: string) => void;
}

export interface RunResult {
  ok: boolean;
  error?: string;
  elapsedMs: number;
  urls: string[];
  tabsOpened: number;
}

export interface BrowserTab {
  targetId: string;
  url: string;
  title: string;
  active: boolean;
}

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const IMAGE_SIGNATURES: [number[], string][] = [
  [[0x89, 0x50, 0x4e, 0x47], "png"],
  [[0xff, 0xd8, 0xff], "jpg"],
  [[0x47, 0x49, 0x46, 0x38], "gif"],
  [[0x52, 0x49, 0x46, 0x46], "webp"],
];

function isErrorLike(value: unknown): value is { name: string; message: string } {
  return typeof value === "object" && value !== null && typeof (value as { message?: unknown }).message === "string" && typeof (value as { name?: unknown }).name === "string";
}

function toTab(info: TabInfo): BrowserTab {
  return { targetId: String(info.tabId), url: info.url, title: info.title, active: info.active };
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (isErrorLike(value)) return `${value.name}: ${value.message}`;
  if (Buffer.isBuffer(value)) return `<Buffer ${value.length} bytes>`;
  return util.inspect(value, { depth: 6, breakLength: 120, maxArrayLength: 200, maxStringLength: 20000 });
}

function formatError(error: unknown): string {
  const message = isErrorLike(error) ? `${error.name}: ${error.message}` : String(error);
  return message.replace(/\s*\n\s*/g, " | ").trim();
}

function imageExtension(bytes: Uint8Array): string {
  for (const [signature, extension] of IMAGE_SIGNATURES) {
    if (signature.every((byte, i) => bytes[i] === byte)) return extension;
  }
  return "bin";
}

class Session {
  readonly tabs: Page[] = [];
  readonly visited = new Set<string>();
  tabsOpened = 0;
  page: Page | null = null;
  aborted = false;

  constructor(private readonly bridge: BrowserBackend, private readonly runDir: string, private readonly log: (text: string) => void = () => undefined) {}

  async openTab(url = "about:blank"): Promise<Page> {
    this.assertActive();
    const info = await this.bridge.request<TabInfo>("tabs.create", { url: "about:blank" });
    this.tabsOpened += 1;
    const page = await this.attach(info.tabId, "owned", "about:blank");
    if (url !== "about:blank") {
      await page.goto(url).catch((error) => {
        if (!isErrorLike(error) || error.name !== "TimeoutError") throw error;
      });
    }
    return page;
  }

  async closeTab(page: Page): Promise<void> {
    await page.close();
    const index = this.tabs.indexOf(page);
    if (index >= 0) this.tabs.splice(index, 1);
    if (this.page === page) this.page = this.tabs[this.tabs.length - 1] ?? null;
  }

  async listBrowserTabs(): Promise<BrowserTab[]> {
    return (await this.bridge.listTabs()).map(toTab);
  }

  async attachBrowserTab(targetId: string): Promise<Page> {
    this.assertActive();
    const existing = this.getTabByTargetId(targetId);
    if (existing) {
      this.page = existing;
      return existing;
    }
    const info = (await this.bridge.listTabs()).find((tab) => String(tab.tabId) === String(targetId));
    if (!info) throw new Error(`No open browser tab found for targetId ${targetId}`);
    return this.attach(info.tabId, "borrowed", info.url);
  }

  async attachActiveBrowserTab(): Promise<Page> {
    this.assertActive();
    const info = await this.bridge.request<TabInfo | null>("tabs.active");
    if (!info) throw new Error("No active browser tab");
    return this.attachBrowserTab(String(info.tabId));
  }

  getTabByTargetId(targetId: string): Page | undefined {
    return this.tabs.find((tab) => tab.targetId === String(targetId));
  }

  async cleanup(keepTabs = false): Promise<void> {
    this.aborted = true;
    await Promise.allSettled(this.tabs.map((tab) => (keepTabs && tab.ownership === "owned" ? tab.leaveOpen() : tab.close())));
    this.tabs.length = 0;
    this.page = null;
  }

  private async attach(tabId: number, ownership: Ownership, url: string): Promise<Page> {
    const page = await Page.attach(this.bridge, tabId, ownership, this.runDir, url, (visited) => this.recordVisit(visited), this.log);
    this.tabs.push(page);
    this.page = page;
    return page;
  }

  private recordVisit(raw: string): void {
    const url = sanitizeUrl(raw);
    if (url && this.visited.size < MAX_URLS_PER_RUN) this.visited.add(url);
  }

  private assertActive(): void {
    if (this.aborted) throw new Error("Script was aborted");
  }
}

export async function runScript(options: RunOptions): Promise<RunResult> {
  const started = Date.now();
  let emitLine: (text: string) => void = () => undefined;
  const session = new Session(options.bridge, options.runDir, (text) => emitLine(text));
  const confinedFs = createConfinedFs(options.runDir);
  const timers = new Set<NodeJS.Timeout>();
  const abort = new AbortController();
  let written = 0;
  let truncatedNotice = false;

  const print = (...args: unknown[]) => {
    if (abort.signal.aborted) return;
    const text = args.map(formatValue).join(" ");
    written += Buffer.byteLength(text) + 1;
    if (written > MAX_OUTPUT_BYTES) {
      if (!truncatedNotice) {
        truncatedNotice = true;
        options.emit("[output truncated: 2 MB limit reached]");
      }
      return;
    }
    options.emit(text);
  };
  emitLine = (text) => print(text);

  const trackedTimer = <F extends typeof setTimeout | typeof setInterval>(factory: F) =>
    (handler: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      const timer = factory(() => {
        if (abort.signal.aborted) return;
        try {
          handler(...args);
        } catch (error) {
          print(formatError(error));
        }
      }, ms);
      timers.add(timer);
      return timer;
    };

  const display = async (input: string | Uint8Array) => {
    let bytes: Buffer;
    if (typeof input === "string") {
      const match = input.match(/^data:[^;,]+;base64,(.*)$/s);
      bytes = Buffer.from(match ? match[1] : input, "base64");
    } else {
      bytes = Buffer.from(input);
    }
    const name = `display-${Date.now()}.${imageExtension(bytes)}`;
    const target = resolveInside(options.runDir, name);
    await confinedFs.writeFile(name, bytes);
    print(`[image saved: ${target}]`);
  };

  const sandbox: Record<string, unknown> = {
    console: { log: print, info: print, warn: print, error: print, debug: print },
    display,
    tabs: session.tabs,
    openTab: (url?: string) => session.openTab(url),
    closeTab: (page: Page) => session.closeTab(page),
    listBrowserTabs: () => session.listBrowserTabs(),
    attachBrowserTab: (targetId: string) => session.attachBrowserTab(targetId),
    attachActiveBrowserTab: () => session.attachActiveBrowserTab(),
    getTabByTargetId: (targetId: string) => session.getTabByTargetId(targetId),
    snapshot: (page: Page, snapshotOptions?: Parameters<Page["snapshot"]>[0]) => page.snapshot(snapshotOptions),
    annotatedScreenshot: (page: Page) => page.annotatedScreenshot(),
    installPageScript: (page: Page, source: string) => page.addInitScript(source),
    fs: confinedFs,
    path: { ...path, resolve: (...segments: string[]) => path.resolve(options.runDir, ...segments) },
    pwd: options.runDir,
    Buffer,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    atob,
    btoa,
    structuredClone,
    queueMicrotask,
    crypto,
    performance,
    setTimeout: trackedTimer(setTimeout),
    setInterval: trackedTimer(setInterval),
    clearTimeout: (timer: NodeJS.Timeout) => { timers.delete(timer); clearTimeout(timer); },
    clearInterval: (timer: NodeJS.Timeout) => { timers.delete(timer); clearInterval(timer); },
    sleep: (ms: number) => new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      timers.add(timer);
      abort.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    }),
    fetch: (url: string | URL, init?: Record<string, unknown>) =>
      session.page ? session.page.fetchInPage(String(url), init) : fetch(url, { ...init, signal: abort.signal } as RequestInit),
  };
  Object.defineProperty(sandbox, "page", {
    get: () => session.page,
    set: (page: Page | null) => { session.page = page; },
    enumerable: true,
    configurable: true,
  });

  let error: string | undefined;
  let timer: NodeJS.Timeout | null = null;
  try {
    const script = new vm.Script(`(async () => {\n${options.code}\n})()`, { filename: "repl.js" });
    const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(new Error(`Script exceeded the ${Math.round(options.timeoutMs / 1000)}s time limit`));
      }, options.timeoutMs);
    });
    await Promise.race([script.runInContext(context) as Promise<unknown>, timeout]);
  } catch (caught) {
    error = formatError(caught);
  } finally {
    if (timer) clearTimeout(timer);
    abort.abort();
    for (const pending of timers) clearTimeout(pending);
    await session.cleanup(options.keepTabs);
  }
  return { ok: error === undefined, error, elapsedMs: Date.now() - started, urls: Array.from(session.visited), tabsOpened: session.tabsOpened };
}
