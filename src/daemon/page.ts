import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BrowserBackend, TabEvent } from "./backend";
import { resolveInside } from "./confined-fs";
import type { CompletedDownload } from "../shared/protocol";
import { diffTrees } from "./diff";
import { keyDescriptor } from "./keys";

export type Ownership = "owned" | "borrowed";
export interface SnapshotOptions { interactive?: boolean; maxTextLength?: number; maxEntries?: number }
export interface SnapshotResult { tree: string; diff: string }
export interface ScreenshotOptions {
  path?: string;
  type?: "png" | "jpeg" | "webp";
  quality?: number;
  fullPage?: boolean;
  clip?: { x: number; y: number; width: number; height: number };
}
export interface PdfOptions {
  path?: string;
  format?: string;
  width?: string | number;
  height?: string | number;
  landscape?: boolean;
  printBackground?: boolean;
  margin?: { top?: string | number; right?: string | number; bottom?: string | number; left?: string | number };
  pageRanges?: string;
  preferCSSPageSize?: boolean;
  scale?: number;
}
type FindKind = "css" | "ref" | "role" | "label" | "text" | "placeholder";
type Selector = { kind: FindKind; arg: Record<string, unknown> };
type RemoteObject = { type: string; subtype?: string; objectId?: string; value?: unknown; description?: string };
type EvalResult = { result: RemoteObject; exceptionDetails?: { text: string; exception?: RemoteObject } };
type CdpParams = Record<string, unknown>;
type WaitState = "attached" | "detached" | "visible" | "hidden";
type PageEvent = "dialog" | "download";
type Listener = (value: any) => unknown;
type DownloadMode = "direct" | "relay" | null;
export interface FrameContext { frameId: string; sessionId?: string }
interface FrameInfo { id: string; parentId: string | null; sessionId?: string; url: string; name: string }
interface FrameNode { frame: { id: string; parentId?: string; url: string; name?: string }; childFrames?: FrameNode[] }
export interface FilePayload { name: string; mimeType?: string; buffer: Uint8Array | ArrayBuffer | string }

const DEFAULT_TIMEOUT_MS = 30000;
const LOCATOR_TIMEOUT_MS = 3000;
const POLL_INTERVALS_MS = [0, 20, 50, 100, 100, 250, 500];
const PAPER_SIZES: Record<string, [number, number]> = {
  letter: [8.5, 11], legal: [8.5, 14], tabloid: [11, 17], ledger: [17, 11],
  a0: [33.1, 46.8], a1: [23.4, 33.1], a2: [16.54, 23.4], a3: [11.7, 16.54], a4: [8.27, 11.7], a5: [5.83, 8.27], a6: [4.13, 5.83],
};
const UNFILLABLE_INPUTS = ["checkbox", "radio", "file", "button", "submit", "reset", "image"];
const PAGE_EVENTS: PageEvent[] = ["dialog", "download"];
const HIT_TEST = `function(px, py) {
  const rect = this.getBoundingClientRect();
  const x = px == null ? rect.left + rect.width / 2 : rect.left + px;
  const y = py == null ? rect.top + rect.height / 2 : rect.top + py;
  let hit = this.ownerDocument.elementFromPoint(x, y);
  while (hit && hit.shadowRoot) {
    const inner = hit.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  if (!hit) return "nothing (the point is outside the page)";
  for (let node = hit; node; node = node.parentNode || node.host) if (node === this) return "";
  return "<" + __apart.describe(hit) + ">";
}`;
const MAX_FRAMES_PER_SNAPSHOT = 20;
const MAX_FRAME_DEPTH = 4;
const CHILD_FRAME_MAX_ENTRIES = 500;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const FRAME_MARKER = /^(\s*)- @@frame:(f\d+)@@$/;
const REF_IN_FRAME = /^(?:\[ref=)?(f\d+)e\d+\]?$/;
const MIME_TYPES: Record<string, string> = {
  ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".txt": "text/plain", ".csv": "text/csv", ".json": "application/json",
  ".html": "text/html", ".xml": "application/xml", ".zip": "application/zip", ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".mp4": "video/mp4", ".mp3": "audio/mpeg",
};
const SETTER_INPUTS = ["color", "date", "datetime-local", "month", "range", "time", "week", "number"];

let injectedCache: string | null = null;

function injectedSource(): string {
  if (injectedCache) return injectedCache;
  const candidates = [
    new URL("./injected/snapshot.js", import.meta.url),
    new URL("../../dist/injected/snapshot.js", import.meta.url),
  ];
  for (const url of candidates) {
    if (existsSync(url)) {
      injectedCache = readFileSync(url, "utf8");
      return injectedCache;
    }
  }
  throw new Error("Injected snapshot bundle is missing. Run `yarn build`.");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function toInches(value: string | number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value === "number") return value / 96;
  const match = value.trim().match(/^([\d.]+)\s*(px|in|cm|mm)?$/);
  if (!match) throw new Error(`Invalid length: ${value}`);
  const amount = Number(match[1]);
  switch (match[2] ?? "px") {
    case "in": return amount;
    case "cm": return amount / 2.54;
    case "mm": return amount / 25.4;
    default: return amount / 96;
  }
}

function serializeArgs(args: unknown[]): string {
  return args.map((arg) => (arg === undefined ? "undefined" : JSON.stringify(arg))).join(",");
}

function formatException(details: { text: string; exception?: RemoteObject }): string {
  return details.exception?.description?.split("\n")[0] ?? details.exception?.value?.toString() ?? details.text;
}

export function isRegExp(value: unknown): value is RegExp {
  return Object.prototype.toString.call(value) === "[object RegExp]";
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

function isContextError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Cannot find context|Execution context was destroyed|Inspected target navigated/i.test(message);
}

function spliceFrame(tree: string, key: string | null, inner: string): string {
  const out: string[] = [];
  for (const line of tree.split("\n")) {
    const match = line.match(FRAME_MARKER);
    if (!match || (key !== null && match[2] !== key)) {
      out.push(line);
      continue;
    }
    if (!inner.trim()) {
      if (out.length) out[out.length - 1] = out[out.length - 1].replace(/:$/, "");
      continue;
    }
    for (const innerLine of inner.split("\n")) out.push(`${match[1]}${innerLine}`);
  }
  return out.join("\n");
}

function safeFileName(name: string): string {
  const base = path.basename(name.replace(/\\/g, "/")).replace(/[\u0000-\u001f]/g, "").trim();
  return base && base !== "." && base !== ".." ? base : "download";
}

async function uniquePath(dir: string, name: string): Promise<string> {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 0; ; i++) {
    const candidate = path.join(dir, i === 0 ? name : `${stem} (${i})${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
}

async function moveFile(from: string, to: string): Promise<void> {
  try {
    await fs.rename(from, to);
  } catch {
    await fs.copyFile(from, to);
    await fs.rm(from, { force: true });
  }
}

function mimeFor(name: string): string {
  return MIME_TYPES[path.extname(name).toLowerCase()] ?? "application/octet-stream";
}

export class Dialog {
  private handled = false;

  constructor(
    private readonly info: { type: string; message: string; defaultPrompt?: string },
    private readonly respond: (accept: boolean, promptText?: string) => Promise<unknown>,
  ) {}

  type(): string { return this.info.type; }
  message(): string { return this.info.message; }
  defaultValue(): string { return this.info.defaultPrompt ?? ""; }
  isHandled(): boolean { return this.handled; }

  async accept(promptText?: string): Promise<void> {
    if (this.handled) return;
    this.handled = true;
    await this.respond(true, promptText ?? (this.info.type === "prompt" ? this.defaultValue() : undefined));
  }

  async dismiss(): Promise<void> {
    if (this.handled) return;
    this.handled = true;
    await this.respond(false);
  }

  async settleByDefault(): Promise<void> {
    if (this.info.type === "beforeunload") await this.accept();
    else await this.dismiss();
  }
}

export class Download {
  private readonly saved: Promise<string>;

  constructor(private readonly info: { url: string; suggestedFilename: string }, saved: Promise<string>, private readonly runDir: string) {
    this.saved = saved;
    this.saved.catch(() => undefined);
  }

  url(): string { return this.info.url; }
  suggestedFilename(): string { return this.info.suggestedFilename; }
  path(): Promise<string> { return this.saved; }

  async failure(): Promise<string | null> {
    return this.saved.then(() => null, (error) => (error instanceof Error ? error.message : String(error)));
  }

  async saveAs(target: string): Promise<string> {
    const source = await this.saved;
    const destination = resolveInside(this.runDir, target);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
    return destination;
  }
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export class Page {
  readonly targetId: string;
  readonly keyboard: { press: (key: string) => Promise<void>; type: (text: string) => Promise<void> };
  readonly mouse: {
    click: (x: number, y: number, options?: { button?: "left" | "right" | "middle"; clickCount?: number }) => Promise<void>;
    move: (x: number, y: number) => Promise<void>;
    wheel: (deltaX: number, deltaY: number) => Promise<void>;
  };
  private currentUrl: string;
  private mainFrameId: string | null = null;
  private frameMap = new Map<string, FrameInfo>();
  private frameRefs = new Map<string, string>();
  private frameByRef = new Map<string, string>();
  private nextFrameRef = 1;
  private worlds = new Map<string, number>();
  private childSessions = new Map<string, string>();
  private listeners = new Map<PageEvent, Set<Listener>>();
  private downloadMode: DownloadMode = null;
  private downloadStaging: string | null = null;
  private downloads = new Map<string, { settle: (source: string | Error) => void }>();
  private lastTree: string | null = null;
  private loadWaiters = new Set<() => void>();
  private detached = false;
  private readonly unsubscribe: () => void;

  private constructor(
    private readonly bridge: BrowserBackend,
    readonly tabId: number,
    readonly ownership: Ownership,
    private readonly runDir: string,
    initialUrl: string,
    private readonly onVisit: (url: string) => void = () => undefined,
    private readonly log: (text: string) => void = () => undefined,
  ) {
    this.targetId = String(tabId);
    this.currentUrl = initialUrl;
    this.unsubscribe = bridge.onTab(tabId, (event) => this.onEvent(event));
    this.keyboard = { press: (key) => this.pressKey(key), type: (text) => this.insertText(text) };
    this.mouse = {
      click: (x, y, options) => this.mouseClick(x, y, options),
      move: (x, y) => this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }),
      wheel: (deltaX, deltaY) => this.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 0, y: 0, deltaX, deltaY }),
    };
  }

  static async attach(bridge: BrowserBackend, tabId: number, ownership: Ownership, runDir: string, initialUrl: string, onVisit?: (url: string) => void, log?: (text: string) => void): Promise<Page> {
    const page = new Page(bridge, tabId, ownership, runDir, initialUrl, onVisit, log);
    onVisit?.(initialUrl);
    await bridge.request("debugger.attach", { tabId });
    await page.send("Page.enable");
    await page.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => undefined);
    await page.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => undefined);
    await page.enableDownloads();
    return page;
  }

  on(event: PageEvent, listener: Listener): this {
    this.listenersFor(event).add(listener);
    return this;
  }

  once(event: PageEvent, listener: Listener): this {
    const wrapper: Listener = (value) => {
      this.off(event, wrapper);
      return listener(value);
    };
    return this.on(event, wrapper);
  }

  off(event: PageEvent, listener: Listener): this {
    this.listenersFor(event).delete(listener);
    return this;
  }

  waitForEvent(event: PageEvent, options: number | ((value: any) => unknown) | { timeout?: number; predicate?: (value: any) => unknown } = {}): Promise<any> {
    const opts = typeof options === "number" ? { timeout: options } : typeof options === "function" ? { predicate: options } : options;
    const timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;
    this.listenersFor(event);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(event, listener);
        reject(new TimeoutError(`Timeout ${timeout}ms exceeded waiting for a ${event}`));
      }, timeout);
      const listener: Listener = async (value) => {
        if (opts.predicate && !(await opts.predicate(value))) return;
        clearTimeout(timer);
        this.off(event, listener);
        resolve(value);
      };
      (listener as Listener & { passive?: boolean }).passive = true;
      this.on(event, listener);
    });
  }

  waitForDownload(options: { timeout?: number } = {}): Promise<Download> {
    return this.waitForEvent("download", options);
  }

  async frames(): Promise<{ ref: string; name: string; url: string }[]> {
    await this.refreshFrames();
    return Array.from(this.frameMap.values())
      .filter((frame) => frame.id !== this.mainFrameId)
      .map((frame) => ({ ref: this.frameRef(frame.id), name: frame.name, url: frame.url }));
  }

  frameLocator(selector: string): FrameLocator {
    return new FrameLocator(this, this.locator(selector));
  }

  url(): string {
    return this.currentUrl;
  }

  isClosed(): boolean {
    return this.detached;
  }

  async send<T = Record<string, any>>(method: string, params: CdpParams = {}, sessionId?: string): Promise<T> {
    if (this.detached) throw new Error(`Tab ${this.targetId} is closed`);
    return this.bridge.request<T>("debugger.send", { tabId: this.tabId, method, params, ...(sessionId ? { sessionId } : {}) });
  }

  _sendToTarget<T = Record<string, any>>(method: string, params: CdpParams = {}): Promise<T> {
    return this.send<T>(method, params);
  }

  async goto(url: string, options: { timeout?: number; waitUntil?: "load" | "commit" | "domcontentloaded" | "networkidle" } = {}): Promise<void> {
    const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    const load = this.waitForLoad(timeout, `navigation to ${url}`);
    const result = await this.send<{ errorText?: string }>("Page.navigate", { url }).catch((error) => {
      load.cancel();
      throw error;
    });
    if (result.errorText) {
      load.cancel();
      throw new Error(`Navigation to ${url} failed: ${result.errorText}`);
    }
    this.currentUrl = url;
    this.worlds.clear();
    if (options.waitUntil === "commit") {
      load.cancel();
      return;
    }
    await load.promise;
  }

  async reload(options: { timeout?: number } = {}): Promise<void> {
    const load = this.waitForLoad(options.timeout ?? DEFAULT_TIMEOUT_MS, "reload");
    await this.send("Page.reload");
    this.worlds.clear();
    await load.promise;
  }

  async goBack(options: { timeout?: number } = {}): Promise<void> {
    await this.navigateHistory(-1, options.timeout ?? DEFAULT_TIMEOUT_MS);
  }

  async goForward(options: { timeout?: number } = {}): Promise<void> {
    await this.navigateHistory(1, options.timeout ?? DEFAULT_TIMEOUT_MS);
  }

  async title(): Promise<string> {
    return this.evaluate("document.title") as Promise<string>;
  }

  async content(): Promise<string> {
    return this.evaluate("document.documentElement.outerHTML") as Promise<string>;
  }

  async evaluate(fn: string | ((...args: any[]) => unknown), ...args: unknown[]): Promise<unknown> {
    const expression = typeof fn === "function" ? `(${fn.toString()})(${serializeArgs(args)})` : String(fn);
    const result = await this.send<EvalResult>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) throw new Error(formatException(result.exceptionDetails));
    return result.result.value;
  }

  async addInitScript(source: string | (() => void)): Promise<void> {
    const script = typeof source === "function" ? `(${source.toString()})()` : source;
    await this.send("Page.addScriptToEvaluateOnNewDocument", { source: script });
  }

  async setViewportSize(size: { width: number; height: number }): Promise<void> {
    await this.send("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 1, mobile: false });
  }

  async bringToFront(): Promise<void> {
    await this.bridge.request("tabs.activate", { tabId: this.tabId });
  }

  async waitForTimeout(ms: number): Promise<void> {
    await sleep(ms);
  }

  async waitForLoadState(state: "load" | "domcontentloaded" | "networkidle" = "load", options: { timeout?: number } = {}): Promise<void> {
    const ready = (await this.evaluate("document.readyState")) as string;
    if (ready === "complete" || (state === "domcontentloaded" && ready === "interactive")) return;
    await this.waitForLoad(options.timeout ?? DEFAULT_TIMEOUT_MS, "load state").promise;
  }

  async waitForURL(pattern: string | RegExp | ((url: string) => boolean), options: { timeout?: number } = {}): Promise<void> {
    const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    const matcher = typeof pattern === "function" ? pattern
      : isRegExp(pattern) ? (url: string) => { pattern.lastIndex = 0; return pattern.test(url); }
      : (url: string) => url === pattern || globToRegExp(String(pattern)).test(url);
    const deadline = Date.now() + timeout;
    while (!matcher(this.currentUrl)) {
      if (Date.now() > deadline) throw new TimeoutError(`Timeout ${timeout}ms exceeded waiting for URL ${String(pattern)} (current: ${this.currentUrl})`);
      await sleep(100);
    }
  }

  async waitForFunction(fn: string | ((...args: any[]) => unknown), arg?: unknown, options: { timeout?: number; polling?: number } = {}): Promise<unknown> {
    const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    const deadline = Date.now() + timeout;
    for (;;) {
      const value = arg === undefined ? await this.evaluate(fn) : await this.evaluate(fn, arg);
      if (value) return value;
      if (Date.now() > deadline) throw new TimeoutError(`Timeout ${timeout}ms exceeded waiting for function`);
      await sleep(options.polling ?? 100);
    }
  }

  async waitForSelector(selector: string, options: { timeout?: number; state?: WaitState } = {}): Promise<Locator> {
    const locator = this.locator(selector);
    await locator.waitFor({ state: options.state ?? "visible", timeout: options.timeout ?? DEFAULT_TIMEOUT_MS });
    return locator;
  }

  locator(selector: string): Locator {
    const frameRef = selector.trim().match(REF_IN_FRAME)?.[1];
    return new Locator(this, { kind: "css", arg: { selector } }, 0, frameRef ? () => this.contextForRef(frameRef) : undefined);
  }

  getByRole(role: string, options: { name?: string | RegExp; exact?: boolean } = {}): Locator {
    const name = isRegExp(options.name) ? { regex: options.name.source, flags: options.name.flags.replace(/[gy]/g, "") } : options.name ?? null;
    return new Locator(this, { kind: "role", arg: { role, name, exact: options.exact ?? false } });
  }

  getByLabel(text: string, options: { exact?: boolean } = {}): Locator {
    return new Locator(this, { kind: "label", arg: { text, exact: options.exact ?? false } });
  }

  getByText(text: string | RegExp, options: { exact?: boolean } = {}): Locator {
    const value = isRegExp(text) ? { regex: text.source, flags: text.flags.replace(/[gy]/g, "") } : text;
    return new Locator(this, { kind: "text", arg: { text: value, exact: options.exact ?? false } });
  }

  getByPlaceholder(text: string, options: { exact?: boolean } = {}): Locator {
    return new Locator(this, { kind: "placeholder", arg: { text, exact: options.exact ?? false } });
  }

  getByTestId(id: string): Locator {
    return this.locator(`[data-testid=${JSON.stringify(id)}]`);
  }

  click(selector: string, options?: Parameters<Locator["click"]>[0]): Promise<void> { return this.locator(selector).click(options); }
  dblclick(selector: string): Promise<void> { return this.locator(selector).dblclick(); }
  fill(selector: string, value: string): Promise<void> { return this.locator(selector).fill(value); }
  type(selector: string, text: string): Promise<void> { return this.locator(selector).type(text); }
  press(selector: string, key: string): Promise<void> { return this.locator(selector).press(key); }
  check(selector: string): Promise<void> { return this.locator(selector).check(); }
  uncheck(selector: string): Promise<void> { return this.locator(selector).uncheck(); }
  hover(selector: string): Promise<void> { return this.locator(selector).hover(); }
  focus(selector: string): Promise<void> { return this.locator(selector).focus(); }
  selectOption(selector: string, values: Parameters<Locator["selectOption"]>[0]): Promise<number> { return this.locator(selector).selectOption(values); }
  textContent(selector: string): Promise<string | null> { return this.locator(selector).textContent(); }
  innerText(selector: string): Promise<string> { return this.locator(selector).innerText(); }
  innerHTML(selector: string): Promise<string> { return this.locator(selector).innerHTML(); }
  inputValue(selector: string): Promise<string> { return this.locator(selector).inputValue(); }
  getAttribute(selector: string, name: string): Promise<string | null> { return this.locator(selector).getAttribute(name); }
  isVisible(selector: string): Promise<boolean> { return this.locator(selector).isVisible(); }
  setInputFiles(selector: string, files: Parameters<Locator["setInputFiles"]>[0]): Promise<number> { return this.locator(selector).setInputFiles(files); }

  async screenshot(options: ScreenshotOptions = {}): Promise<Buffer> {
    const inferred = options.path?.match(/\.jpe?g$/i) ? "jpeg" : options.path?.match(/\.webp$/i) ? "webp" : "png";
    const format = options.type ?? inferred;
    const params: CdpParams = { format, captureBeyondViewport: Boolean(options.fullPage || options.clip) };
    if (format !== "png") params.quality = options.quality ?? 80;
    if (options.clip) {
      params.clip = { ...options.clip, scale: 1 };
    } else if (options.fullPage) {
      const metrics = await this.send<{ cssContentSize?: { width: number; height: number }; contentSize: { width: number; height: number } }>("Page.getLayoutMetrics");
      const size = metrics.cssContentSize ?? metrics.contentSize;
      params.clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.min(Math.ceil(size.height), 16384), scale: 1 };
    }
    const { data } = await this.send<{ data: string }>("Page.captureScreenshot", params);
    const buffer = Buffer.from(data, "base64");
    if (options.path) await this.saveArtifact(options.path, buffer);
    return buffer;
  }

  async pdf(options: PdfOptions = {}): Promise<Buffer> {
    const paper = options.format ? PAPER_SIZES[options.format.toLowerCase()] : undefined;
    if (options.format && !paper) throw new Error(`Unknown paper format: ${options.format}`);
    const params: CdpParams = {
      landscape: options.landscape ?? false,
      printBackground: options.printBackground ?? false,
      preferCSSPageSize: options.preferCSSPageSize ?? false,
      scale: options.scale ?? 1,
      paperWidth: toInches(options.width, paper?.[0] ?? 8.5),
      paperHeight: toInches(options.height, paper?.[1] ?? 11),
      marginTop: toInches(options.margin?.top, 0.4),
      marginBottom: toInches(options.margin?.bottom, 0.4),
      marginLeft: toInches(options.margin?.left, 0.4),
      marginRight: toInches(options.margin?.right, 0.4),
      transferMode: "ReturnAsBase64",
    };
    if (options.pageRanges) params.pageRanges = options.pageRanges;
    const { data } = await this.send<{ data: string }>("Page.printToPDF", params);
    const buffer = Buffer.from(data, "base64");
    if (options.path) await this.saveArtifact(options.path, buffer);
    return buffer;
  }

  async snapshot(options: SnapshotOptions = {}): Promise<SnapshotResult> {
    await this.refreshFrames().catch(() => undefined);
    const result = await this.snapshotFrame(this.mainContext(), options, 0, { frames: 0 });
    const diff = diffTrees(this.lastTree, result.fullTree);
    this.lastTree = result.fullTree;
    return { tree: result.tree, diff };
  }

  async annotatedScreenshot(options: { path?: string } = {}): Promise<{ base64Image: string; refCount: number }> {
    const refCount = (await this.evalInWorld("__apart.refCount()", true)) as number;
    if (refCount === 0) await this.snapshot({ interactive: true });
    const contexts = this.annotatableContexts();
    for (const ctx of contexts) await this.evalInWorld("__apart.annotate()", true, ctx).catch(() => undefined);
    try {
      const buffer = await this.screenshot({ type: "png", path: options.path });
      let total = 0;
      for (const ctx of contexts) total += ((await this.evalInWorld("__apart.refCount()", true, ctx).catch(() => 0)) as number);
      return { base64Image: buffer.toString("base64"), refCount: total };
    } finally {
      for (const ctx of contexts) await this.evalInWorld("__apart.unannotate()", true, ctx).catch(() => undefined);
    }
  }

  async fetchInPage(url: string, init: Record<string, unknown> = {}): Promise<Response> {
    const { signal: _signal, ...rest } = init;
    const payload = (await this.evaluate(
      async (target: string, options: Record<string, unknown>) => {
        const response = await fetch(target, options as RequestInit);
        const bytes = new Uint8Array(await response.arrayBuffer());
        let binary = "";
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
        return { status: response.status, statusText: response.statusText, url: response.url, headers: Array.from(response.headers.entries()), body: btoa(binary) };
      },
      url,
      rest,
    )) as { status: number; statusText: string; url: string; headers: [string, string][]; body: string };
    const body = [101, 204, 205, 304].includes(payload.status) ? null : Buffer.from(payload.body, "base64");
    const response = new Response(body, { status: payload.status || 200, statusText: payload.statusText, headers: payload.headers });
    Object.defineProperty(response, "url", { value: payload.url });
    return response;
  }

  async close(): Promise<void> {
    if (this.detached) return;
    this.detached = true;
    this.unsubscribe();
    this.failLoadWaiters();
    this.failDownloads(new Error("The tab closed before the download finished"));
    if (this.ownership === "owned") await this.bridge.request("tabs.close", { tabId: this.tabId }).catch(() => undefined);
    else await this.bridge.request("debugger.detach", { tabId: this.tabId }).catch(() => undefined);
  }

  async leaveOpen(): Promise<void> {
    if (this.detached) return;
    this.detached = true;
    this.unsubscribe();
    this.failLoadWaiters();
    this.failDownloads(new Error("The script ended before the download finished"));
    await this.bridge.request("tabs.release", { tabId: this.tabId }).catch(() => undefined);
  }

  async pressKey(key: string): Promise<void> {
    const descriptor = keyDescriptor(key);
    const base = { key: descriptor.key, code: descriptor.code, windowsVirtualKeyCode: descriptor.keyCode, nativeVirtualKeyCode: descriptor.keyCode, modifiers: descriptor.modifiers };
    await this.send("Input.dispatchKeyEvent", { ...base, type: descriptor.text ? "keyDown" : "rawKeyDown", text: descriptor.text, unmodifiedText: descriptor.text });
    await this.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  }

  async insertText(text: string): Promise<void> {
    await this.send("Input.insertText", { text });
  }

  async mouseClick(x: number, y: number, options: { button?: "left" | "right" | "middle"; clickCount?: number; modifiers?: number } = {}, sessionId?: string): Promise<void> {
    const button = options.button ?? "left";
    const clicks = options.clickCount ?? 1;
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers: options.modifiers ?? 0 }, sessionId);
    for (let count = 1; count <= clicks; count++) {
      await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: count, modifiers: options.modifiers ?? 0 }, sessionId);
      await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: count, modifiers: options.modifiers ?? 0 }, sessionId);
    }
  }

  async mouseMove(x: number, y: number, sessionId?: string): Promise<void> {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, sessionId);
  }

  resolveArtifact(target: string): string {
    return resolveInside(this.runDir, target);
  }

  async saveArtifact(target: string, data: Buffer): Promise<string> {
    const resolved = resolveInside(this.runDir, target);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, data);
    return resolved;
  }

  async evalInWorld(expression: string, returnByValue: boolean, ctx?: FrameContext): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const frame = ctx ?? (await this.ensureMainContext());
      const contextId = await this.ensureWorld(frame);
      try {
        const result = await this.send<EvalResult>("Runtime.evaluate", { expression, contextId, returnByValue, awaitPromise: true }, frame.sessionId);
        if (result.exceptionDetails) throw new Error(formatException(result.exceptionDetails));
        return returnByValue ? result.result.value : result.result;
      } catch (error) {
        if (attempt === 0 && isContextError(error)) {
          this.worlds.delete(frame.frameId);
          continue;
        }
        throw error;
      }
    }
    throw new Error("Isolated world unavailable");
  }

  async callOn(objectId: string, functionDeclaration: string, args: unknown[] = [], returnByValue = true, sessionId?: string): Promise<unknown> {
    const result = await this.send<EvalResult>("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration,
      arguments: args.map((value) => ({ value })),
      returnByValue,
      awaitPromise: true,
    }, sessionId);
    if (result.exceptionDetails) throw new Error(formatException(result.exceptionDetails));
    return returnByValue ? result.result.value : result.result;
  }

  async release(objectId: string, sessionId?: string): Promise<void> {
    await this.send("Runtime.releaseObject", { objectId }, sessionId).catch(() => undefined);
  }

  async ensureMainContext(): Promise<FrameContext> {
    if (!this.mainFrameId) {
      const { frameTree } = await this.send<{ frameTree: FrameNode }>("Page.getFrameTree");
      this.mainFrameId = frameTree.frame.id;
    }
    return { frameId: this.mainFrameId };
  }

  mainContext(): FrameContext {
    return { frameId: this.mainFrameId ?? "" };
  }

  async contextForRef(frameRef: string): Promise<FrameContext> {
    const frameId = this.frameByRef.get(frameRef);
    if (!frameId) throw new Error(`Unknown frame ${frameRef}; take a new snapshot first`);
    let frame = this.frameMap.get(frameId);
    if (!frame) {
      await this.refreshFrames();
      frame = this.frameMap.get(frameId);
    }
    if (!frame) throw new Error(`Frame ${frameRef} is gone; take a new snapshot`);
    return { frameId, sessionId: frame.sessionId };
  }

  async contextForOwner(owner: Locator, timeout = LOCATOR_TIMEOUT_MS): Promise<FrameContext> {
    const deadline = Date.now() + timeout;
    for (let attempt = 0; ; attempt++) {
      const frameId = await owner.childFrameId();
      if (frameId) {
        let frame = this.frameMap.get(frameId);
        if (!frame) {
          await this.refreshFrames();
          frame = this.frameMap.get(frameId);
        }
        if (frame) return { frameId, sessionId: frame.sessionId };
      }
      if (Date.now() > deadline) throw new TimeoutError(`Timeout ${timeout}ms exceeded waiting for ${owner.describe()} to be a loaded frame`);
      await sleep(POLL_INTERVALS_MS[Math.min(attempt, POLL_INTERVALS_MS.length - 1)]);
    }
  }

  async frameOffset(ctx: FrameContext): Promise<{ x: number; y: number }> {
    let x = 0;
    let y = 0;
    let frame = this.frameMap.get(ctx.frameId);
    while (frame?.parentId) {
      const parent = this.frameMap.get(frame.parentId);
      if (!parent) break;
      if (frame.sessionId !== parent.sessionId) {
        const { backendNodeId } = await this.send<{ backendNodeId: number }>("DOM.getFrameOwner", { frameId: frame.id }, parent.sessionId);
        const { model } = await this.send<{ model: { content: number[] } }>("DOM.getBoxModel", { backendNodeId }, parent.sessionId);
        x += model.content[0];
        y += model.content[1];
      }
      frame = parent;
    }
    return { x, y };
  }

  async revealFrame(ctx: FrameContext): Promise<void> {
    const chain: FrameInfo[] = [];
    let frame = this.frameMap.get(ctx.frameId);
    while (frame?.parentId) {
      chain.unshift(frame);
      frame = this.frameMap.get(frame.parentId);
    }
    for (const child of chain) {
      const parent = child.parentId ? this.frameMap.get(child.parentId) : undefined;
      if (!parent) continue;
      const owner = await this.send<{ backendNodeId: number }>("DOM.getFrameOwner", { frameId: child.id }, parent.sessionId).catch(() => null);
      if (owner) await this.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: owner.backendNodeId }, parent.sessionId).catch(() => undefined);
    }
  }

  private listenersFor(event: PageEvent): Set<Listener> {
    if (!PAGE_EVENTS.includes(event)) throw new Error(`Unsupported page event: ${String(event)}. Supported: ${PAGE_EVENTS.join(", ")}`);
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    return set;
  }

  private async emitEvent(event: PageEvent, value: unknown): Promise<void> {
    for (const listener of Array.from(this.listenersFor(event))) {
      try {
        await listener(value);
      } catch (error) {
        this.log(`[${event} handler failed: ${error instanceof Error ? error.message : String(error)}]`);
      }
    }
  }

  private hasActiveListener(event: PageEvent): boolean {
    return Array.from(this.listenersFor(event)).some((listener) => !(listener as Listener & { passive?: boolean }).passive);
  }

  private onDialog(params: Record<string, any>, sessionId?: string): void {
    const dialog = new Dialog(
      { type: String(params.type), message: String(params.message ?? ""), defaultPrompt: params.defaultPrompt },
      (accept, promptText) => this.send("Page.handleJavaScriptDialog", { accept, ...(promptText !== undefined ? { promptText } : {}) }, sessionId).catch(() => undefined),
    );
    if (!this.hasActiveListener("dialog")) {
      void dialog.settleByDefault().then(() => this.emitEvent("dialog", dialog));
      return;
    }
    void this.emitEvent("dialog", dialog).then(() => (dialog.isHandled() ? undefined : dialog.settleByDefault()));
  }

  private async enableDownloads(): Promise<void> {
    const staging = path.join(os.tmpdir(), `apart-downloads-${process.getuid?.() ?? "user"}`, path.basename(this.runDir));
    const result = await this.bridge.request<{ mode: "direct" | "relay"; downloadPath?: string }>("downloads.enable", { tabId: this.tabId, downloadPath: staging }).catch(() => null);
    this.downloadMode = result?.mode ?? null;
    if (this.downloadMode === "direct") {
      await fs.mkdir(staging, { recursive: true, mode: 0o700 });
      this.downloadStaging = staging;
    }
  }

  private onDownloadStart(params: Record<string, any>): void {
    const guid = String(params.guid ?? "");
    if (!guid || this.downloads.has(guid)) return;
    if (params.frameId && this.mainFrameId && params.frameId !== this.mainFrameId && !this.frameMap.has(params.frameId)) return;
    const url = String(params.url ?? "");
    const suggestedFilename = safeFileName(String(params.suggestedFilename ?? "download"));
    let settle: (source: string | Error) => void = () => undefined;
    const source = new Promise<string>((resolve, reject) => {
      settle = (value) => (value instanceof Error ? reject(value) : resolve(value));
    });
    this.downloads.set(guid, { settle });
    if (this.downloadMode === "relay") {
      this.bridge.request<CompletedDownload>("downloads.expect", { url, timeoutMs: DOWNLOAD_TIMEOUT_MS }, DOWNLOAD_TIMEOUT_MS + 5000)
        .then((done) => settle(done.path), (error) => settle(error instanceof Error ? error : new Error(String(error))));
    } else if (this.downloadMode === null) {
      settle(new Error("Downloads are not available here. Reload the apart extension in chrome://extensions, then run apart daemon restart."));
    }
    const saved = source.then(async (from) => {
      const dir = path.join(this.runDir, "downloads");
      await fs.mkdir(dir, { recursive: true });
      const destination = await uniquePath(dir, suggestedFilename);
      if (this.downloadMode === "direct") await moveFile(from, destination);
      else await fs.copyFile(from, destination);
      return destination;
    }).finally(() => this.downloads.delete(guid));
    void this.emitEvent("download", new Download({ url, suggestedFilename }, saved, this.runDir));
  }

  private onDownloadProgress(params: Record<string, any>): void {
    const download = this.downloads.get(String(params.guid ?? ""));
    if (!download || this.downloadMode !== "direct") return;
    if (params.state === "completed") download.settle(typeof params.filePath === "string" && params.filePath ? params.filePath : path.join(this.downloadStaging ?? "", String(params.guid)));
    else if (params.state === "canceled") download.settle(new Error("The download was canceled"));
  }

  private failDownloads(error: Error): void {
    for (const download of this.downloads.values()) download.settle(error);
    this.downloads.clear();
  }

  private frameRef(frameId: string): string {
    if (frameId === this.mainFrameId) return "";
    let ref = this.frameRefs.get(frameId);
    if (!ref) {
      ref = `f${this.nextFrameRef++}`;
      this.frameRefs.set(frameId, ref);
      this.frameByRef.set(ref, frameId);
    }
    return ref;
  }

  private async refreshFrames(): Promise<void> {
    const next = new Map<string, FrameInfo>();
    const walk = (node: FrameNode, sessionId: string | undefined, parentOverride?: string) => {
      const { frame } = node;
      next.set(frame.id, { id: frame.id, parentId: frame.parentId ?? parentOverride ?? null, sessionId, url: frame.url, name: frame.name ?? "" });
      for (const child of node.childFrames ?? []) walk(child, sessionId);
    };
    const { frameTree } = await this.send<{ frameTree: FrameNode }>("Page.getFrameTree");
    this.mainFrameId = frameTree.frame.id;
    walk(frameTree, undefined);
    for (const [sessionId, rootId] of this.childSessions) {
      const tree = await this.send<{ frameTree: FrameNode }>("Page.getFrameTree", {}, sessionId).catch(() => null);
      if (!tree) continue;
      walk(tree.frameTree, sessionId, this.frameMap.get(rootId)?.parentId ?? next.get(rootId)?.parentId ?? undefined);
    }
    for (const [sessionId, rootId] of this.childSessions) {
      const root = next.get(rootId);
      if (!root || root.parentId) continue;
      root.parentId = await this.findParentFrame(rootId, sessionId, next);
    }
    this.frameMap = next;
  }

  private async findParentFrame(frameId: string, sessionId: string, frames: Map<string, FrameInfo>): Promise<string | null> {
    const sessions = new Set<string | undefined>([undefined, ...this.childSessions.keys()]);
    sessions.delete(sessionId);
    for (const candidate of sessions) {
      const owner = await this.send<{ backendNodeId: number }>("DOM.getFrameOwner", { frameId }, candidate).catch(() => null);
      if (!owner) continue;
      const described = await this.send<{ node: { frameId?: string } }>("DOM.describeNode", { backendNodeId: owner.backendNodeId }, candidate).catch(() => null);
      const ownerFrame = described?.node.frameId;
      if (ownerFrame && frames.has(ownerFrame)) return ownerFrame;
      const inSession = Array.from(frames.values()).find((frame) => frame.sessionId === candidate && !frame.parentId);
      if (inSession) return inSession.id;
    }
    return null;
  }

  private annotatableContexts(): FrameContext[] {
    return Array.from(this.worlds.keys())
      .map((frameId) => this.frameMap.get(frameId) ?? (frameId === this.mainFrameId ? { id: frameId, sessionId: undefined } : undefined))
      .filter((frame): frame is FrameInfo | { id: string; sessionId: undefined } => Boolean(frame))
      .map((frame) => ({ frameId: frame.id, sessionId: frame.sessionId }));
  }

  private async snapshotFrame(ctx: FrameContext, options: SnapshotOptions, depth: number, budget: { frames: number }): Promise<{ tree: string; fullTree: string }> {
    const frame = ctx.frameId ? ctx : await this.ensureMainContext();
    const children = depth >= MAX_FRAME_DEPTH ? [] : Array.from(this.frameMap.values()).filter((child) => child.parentId === frame.frameId);
    const marked: { key: string; ctx: FrameContext }[] = [];
    for (const child of children) {
      if (budget.frames >= MAX_FRAMES_PER_SNAPSHOT) break;
      const key = this.frameRef(child.id);
      if (await this.markOwner(frame, child.id, key)) {
        budget.frames += 1;
        marked.push({ key, ctx: { frameId: child.id, sessionId: child.sessionId } });
      }
    }
    const prefix = depth === 0 ? "e" : `${this.frameRef(frame.frameId)}e`;
    const frameOptions = { ...options, refPrefix: prefix, ...(depth > 0 ? { maxEntries: Math.min(options.maxEntries ?? CHILD_FRAME_MAX_ENTRIES, CHILD_FRAME_MAX_ENTRIES) } : {}) };
    let { tree, fullTree } = (await this.evalInWorld(`__apart.snapshot(${JSON.stringify(frameOptions)})`, true, frame)) as { tree: string; fullTree: string };
    for (const { key, ctx: childCtx } of marked) {
      if (!fullTree.includes(`@@frame:${key}@@`)) continue;
      const inner = await this.snapshotFrame(childCtx, options, depth + 1, budget).catch(() => {
        const unreadable = '- text: "(this frame could not be read)"';
        return { tree: unreadable, fullTree: unreadable };
      });
      tree = spliceFrame(tree, key, inner.tree);
      fullTree = spliceFrame(fullTree, key, inner.fullTree);
    }
    return { tree: spliceFrame(tree, null, ""), fullTree: spliceFrame(fullTree, null, "") };
  }

  private async markOwner(parent: FrameContext, childFrameId: string, key: string): Promise<boolean> {
    try {
      const { backendNodeId } = await this.send<{ backendNodeId: number }>("DOM.getFrameOwner", { frameId: childFrameId }, parent.sessionId);
      const executionContextId = await this.ensureWorld(parent);
      const { object } = await this.send<{ object: RemoteObject }>("DOM.resolveNode", { backendNodeId, executionContextId }, parent.sessionId);
      if (!object.objectId) return false;
      await this.callOn(object.objectId, "function(key){ __apart.markFrame(this, key); }", [key], true, parent.sessionId);
      await this.release(object.objectId, parent.sessionId);
      return true;
    } catch {
      return false;
    }
  }

  private async ensureWorld(ctx: FrameContext): Promise<number> {
    const existing = this.worlds.get(ctx.frameId);
    if (existing !== undefined) return existing;
    const { executionContextId } = await this.send<{ executionContextId: number }>("Page.createIsolatedWorld", {
      frameId: ctx.frameId,
      worldName: "__apart",
      grantUniveralAccess: false,
    }, ctx.sessionId);
    const probe = await this.send<EvalResult>("Runtime.evaluate", { expression: "typeof __apart", contextId: executionContextId, returnByValue: true }, ctx.sessionId);
    if (probe.result.value !== "object") {
      await this.send("Runtime.evaluate", { expression: injectedSource(), contextId: executionContextId }, ctx.sessionId);
    }
    this.worlds.set(ctx.frameId, executionContextId);
    return executionContextId;
  }

  private async navigateHistory(delta: number, timeout: number): Promise<void> {
    const history = await this.send<{ currentIndex: number; entries: { id: number }[] }>("Page.getNavigationHistory");
    const entry = history.entries[history.currentIndex + delta];
    if (!entry) return;
    const load = this.waitForLoad(timeout, "history navigation");
    await this.send("Page.navigateToHistoryEntry", { entryId: entry.id });
    this.worlds.clear();
    await load.promise;
  }

  private waitForLoad(timeout: number, what: string): { promise: Promise<void>; cancel: () => void } {
    let settle: () => void = () => undefined;
    let timer: NodeJS.Timeout;
    const promise = new Promise<void>((resolve, reject) => {
      settle = () => {
        clearTimeout(timer);
        this.loadWaiters.delete(settle);
        resolve();
      };
      timer = setTimeout(() => {
        this.loadWaiters.delete(settle);
        reject(new TimeoutError(`Timeout ${timeout}ms exceeded waiting for ${what}`));
      }, timeout);
      this.loadWaiters.add(settle);
    });
    promise.catch(() => undefined);
    return { promise, cancel: settle };
  }

  private failLoadWaiters(): void {
    for (const waiter of this.loadWaiters) waiter();
    this.loadWaiters.clear();
  }

  private onChildAttached(params: Record<string, any>): void {
    if (params.targetInfo?.type !== "iframe" || typeof params.sessionId !== "string") return;
    const sessionId = params.sessionId;
    this.childSessions.set(sessionId, String(params.targetInfo.targetId));
    void this.send("Page.enable", {}, sessionId).catch(() => undefined);
    void this.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId).catch(() => undefined);
  }

  private onChildDetached(sessionId: string): void {
    this.childSessions.delete(sessionId);
    for (const frame of this.frameMap.values()) if (frame.sessionId === sessionId) this.worlds.delete(frame.id);
  }

  private onEvent(event: TabEvent): void {
    const params = (event.params ?? {}) as Record<string, any>;
    if (event.sessionId) {
      switch (event.method) {
        case "Target.attachedToTarget":
          this.onChildAttached(params);
          break;
        case "Target.detachedFromTarget":
          this.onChildDetached(String(params.sessionId));
          break;
        case "Page.frameNavigated":
        case "Page.frameDetached":
          this.worlds.delete(String(params.frame?.id ?? params.frameId));
          break;
        case "Page.javascriptDialogOpening":
          this.onDialog(params, event.sessionId);
          break;
        case "Page.downloadWillBegin":
          this.onDownloadStart(params);
          break;
      }
      return;
    }
    switch (event.method) {
      case "Target.attachedToTarget":
        this.onChildAttached(params);
        break;
      case "Target.detachedFromTarget":
        this.onChildDetached(String(params.sessionId));
        break;
      case "Page.frameNavigated":
        if (!params.frame?.parentId) {
          this.currentUrl = params.frame.url;
          this.mainFrameId = params.frame.id;
          this.worlds.clear();
          this.onVisit(params.frame.url);
        } else {
          this.worlds.delete(params.frame.id);
        }
        break;
      case "Page.frameDetached":
        this.worlds.delete(String(params.frameId));
        break;
      case "Page.downloadWillBegin":
      case "Browser.downloadWillBegin":
        this.onDownloadStart(params);
        break;
      case "Browser.downloadProgress":
        this.onDownloadProgress(params);
        break;
      case "Page.navigatedWithinDocument":
        this.currentUrl = params.url ?? this.currentUrl;
        this.onVisit(this.currentUrl);
        this.failLoadWaiters();
        break;
      case "Page.loadEventFired":
        this.failLoadWaiters();
        break;
      case "Page.javascriptDialogOpening":
        this.onDialog(params);
        break;
      case "__detached":
        this.detached = true;
        this.unsubscribe();
        this.failLoadWaiters();
        this.failDownloads(new Error("The tab closed before the download finished"));
        break;
    }
  }
}

type Handle = { objectId: string; ctx?: FrameContext };
type FrameResolver = () => Promise<FrameContext>;

export class FrameLocator {
  constructor(private readonly page: Page, private readonly owner: Locator) {}

  locator(selector: string): Locator { return new Locator(this.page, { kind: "css", arg: { selector } }, 0, () => this.resolve()); }
  getByRole(role: string, options: { name?: string | RegExp; exact?: boolean } = {}): Locator { return this.scoped(this.page.getByRole(role, options)); }
  getByLabel(text: string, options: { exact?: boolean } = {}): Locator { return this.scoped(this.page.getByLabel(text, options)); }
  getByText(text: string | RegExp, options: { exact?: boolean } = {}): Locator { return this.scoped(this.page.getByText(text, options)); }
  getByPlaceholder(text: string, options: { exact?: boolean } = {}): Locator { return this.scoped(this.page.getByPlaceholder(text, options)); }
  getByTestId(id: string): Locator { return this.locator(`[data-testid=${JSON.stringify(id)}]`); }
  frameLocator(selector: string): FrameLocator { return new FrameLocator(this.page, this.locator(selector)); }
  first(): FrameLocator { return new FrameLocator(this.page, this.owner.first()); }
  last(): FrameLocator { return new FrameLocator(this.page, this.owner.last()); }
  nth(index: number): FrameLocator { return new FrameLocator(this.page, this.owner.nth(index)); }

  private scoped(locator: Locator): Locator {
    return locator.inFrame(() => this.resolve());
  }

  private resolve(): Promise<FrameContext> {
    return this.page.contextForOwner(this.owner);
  }
}

export class Locator {
  constructor(private readonly page: Page, private readonly selector: Selector, private readonly index = 0, private readonly frame?: FrameResolver) {}

  first(): Locator { return new Locator(this.page, this.selector, 0, this.frame); }
  last(): Locator { return new Locator(this.page, this.selector, -1, this.frame); }
  nth(index: number): Locator { return new Locator(this.page, this.selector, index, this.frame); }
  inFrame(frame: FrameResolver): Locator { return new Locator(this.page, this.selector, this.index, frame); }

  async all(): Promise<Locator[]> {
    const total = await this.count();
    return Array.from({ length: total }, (_, i) => this.nth(i));
  }

  async count(): Promise<number> {
    const ctx = await this.context();
    return (await this.page.evalInWorld(`__apart.countOf(${JSON.stringify(this.selector.kind)}, ${JSON.stringify(this.selector.arg)})`, true, ctx)) as number;
  }

  async waitFor(options: { state?: WaitState; timeout?: number } = {}): Promise<void> {
    const state = options.state ?? "visible";
    const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    if (state === "attached" || state === "visible") {
      await this.releaseHandle(await this.resolve({ timeout, visible: state === "visible" }));
      return;
    }
    const deadline = Date.now() + timeout;
    for (let attempt = 0; ; attempt++) {
      const handle = await this.query().catch(() => null);
      if (!handle) return;
      const visible = state === "hidden" ? await this.call(handle, "function(){ return __apart.visible(this) }") : true;
      await this.releaseHandle(handle);
      if (state === "hidden" && !visible) return;
      if (Date.now() > deadline) throw new TimeoutError(`Timeout ${timeout}ms exceeded waiting for ${this.describe()} to be ${state}`);
      await sleep(POLL_INTERVALS_MS[Math.min(attempt, POLL_INTERVALS_MS.length - 1)]);
    }
  }

  async click(options: { button?: "left" | "right" | "middle"; clickCount?: number; timeout?: number; position?: { x: number; y: number }; modifiers?: string[]; force?: boolean } = {}): Promise<void> {
    const timeout = options.timeout ?? LOCATOR_TIMEOUT_MS;
    const deadline = Date.now() + timeout;
    await this.withElement(async (handle) => {
      let point = await this.clickPoint(handle, options.position, true);
      for (let attempt = 0; !options.force; attempt++) {
        const covering = (await this.call(handle, HIT_TEST, [options.position?.x ?? null, options.position?.y ?? null])) as string;
        if (!covering) break;
        if (Date.now() > deadline) {
          throw new Error(`${this.describe()} is covered by ${covering} at the point apart would click, so the click would not reach it. Scroll or close what covers it, or pass { force: true }.`);
        }
        await sleep(POLL_INTERVALS_MS[Math.min(attempt, POLL_INTERVALS_MS.length - 1)]);
        point = await this.clickPoint(handle, options.position, true);
      }
      const modifiers = (options.modifiers ?? []).reduce((bits, name) => bits | keyDescriptor(`${name}+a`).modifiers & ~8, 0);
      await this.page.mouseClick(point.x, point.y, { button: options.button, clickCount: options.clickCount, modifiers }, handle.ctx?.sessionId);
    }, options.timeout);
  }

  async dblclick(options: { timeout?: number } = {}): Promise<void> {
    await this.click({ ...options, clickCount: 2 });
  }

  async hover(options: { timeout?: number } = {}): Promise<void> {
    await this.withElement(async (handle) => {
      const point = await this.clickPoint(handle, undefined, true);
      await this.page.mouseMove(point.x, point.y, handle.ctx?.sessionId);
    }, options.timeout);
  }

  async focus(options: { timeout?: number } = {}): Promise<void> {
    await this.withElement((handle) => this.call(handle, "function(){ this.focus(); }"), options.timeout);
  }

  async scrollIntoViewIfNeeded(options: { timeout?: number } = {}): Promise<void> {
    await this.withElement((handle) => this.scrollIntoView(handle), options.timeout);
  }

  async fill(value: string, options: { timeout?: number } = {}): Promise<void> {
    await this.withElement(async (handle) => {
      await this.scrollIntoView(handle);
      const mode = (await this.call(handle, `function(value, unfillable, viaSetter){
        const tag = this.tagName.toLowerCase();
        if (tag === "input" || tag === "textarea") {
          const type = (this.type || "text").toLowerCase();
          if (unfillable.includes(type)) return "unfillable";
          if (viaSetter.includes(type)) {
            const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(this), "value")?.set;
            if (setter) setter.call(this, value); else this.value = value;
            this.dispatchEvent(new Event("input", { bubbles: true }));
            this.dispatchEvent(new Event("change", { bubbles: true }));
            return "set";
          }
          this.focus();
          this.select();
          return "text";
        }
        if (this.isContentEditable) {
          this.focus();
          const range = document.createRange();
          range.selectNodeContents(this);
          const selection = getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          return "text";
        }
        return "unfillable";
      }`, [value, UNFILLABLE_INPUTS, SETTER_INPUTS])) as string;
      if (mode === "unfillable") throw new Error(`${this.describe()} is not an input, textarea or contenteditable element`);
      if (mode !== "text") return;
      if (value === "") await this.page.pressKey("Delete");
      else await this.page.insertText(value);
    }, options.timeout);
  }

  async clear(options: { timeout?: number } = {}): Promise<void> {
    await this.fill("", options);
  }

  async type(text: string, options: { timeout?: number } = {}): Promise<void> {
    await this.withElement(async (handle) => {
      await this.call(handle, "function(){ this.focus(); }");
      await this.page.insertText(text);
    }, options.timeout);
  }

  async press(key: string, options: { timeout?: number } = {}): Promise<void> {
    await this.withElement(async (handle) => {
      await this.call(handle, "function(){ this.focus(); }");
      await this.page.pressKey(key);
    }, options.timeout);
  }

  async check(options: { timeout?: number } = {}): Promise<void> {
    if (!(await this.isChecked())) await this.click(options);
  }

  async uncheck(options: { timeout?: number } = {}): Promise<void> {
    if (await this.isChecked()) await this.click(options);
  }

  async selectOption(values: string | string[] | { value?: string; label?: string; index?: number } | { value?: string; label?: string; index?: number }[], options: { timeout?: number } = {}): Promise<number> {
    const wanted = (Array.isArray(values) ? values : [values]).map((item) => (typeof item === "string" ? { value: item, label: item } : item));
    return (await this.withElement((handle) => this.call(handle, `function(wanted){
      if (this.tagName.toLowerCase() !== "select") throw new Error("Element is not a <select>");
      let hits = 0;
      for (const option of this.options) {
        const match = wanted.some((w) => (w.value !== undefined && option.value === w.value) || (w.label !== undefined && option.label === w.label) || (w.index !== undefined && option.index === w.index));
        if (this.multiple) option.selected = match;
        else if (match && hits === 0) this.value = option.value;
        if (match) hits += 1;
      }
      if (hits === 0) throw new Error("No option matched " + JSON.stringify(wanted));
      this.dispatchEvent(new Event("input", { bubbles: true }));
      this.dispatchEvent(new Event("change", { bubbles: true }));
      return hits;
    }`, [wanted]), options.timeout)) as number;
  }

  async setInputFiles(files: string | FilePayload | (string | FilePayload)[], options: { timeout?: number } = {}): Promise<number> {
    const list = Array.isArray(files) ? files : [files];
    const payloads: { name: string; mimeType: string; base64: string }[] = [];
    let total = 0;
    for (const item of list) {
      let name: string;
      let bytes: Buffer;
      let mimeType: string | undefined;
      if (typeof item === "string") {
        const resolved = this.page.resolveArtifact(item);
        bytes = await fs.readFile(resolved);
        name = path.basename(resolved);
      } else {
        name = safeFileName(String(item.name ?? "file"));
        mimeType = item.mimeType;
        bytes = typeof item.buffer === "string" ? Buffer.from(item.buffer) : Buffer.from(item.buffer as ArrayBuffer);
      }
      total += bytes.length;
      if (total > MAX_UPLOAD_BYTES) throw new Error(`Files for one upload must total ${MAX_UPLOAD_BYTES / 1024 / 1024} MB or less`);
      payloads.push({ name, mimeType: mimeType ?? mimeFor(name), base64: bytes.toString("base64") });
    }
    return (await this.withElement((handle) => this.call(handle, `function(files){
      if (this.tagName.toLowerCase() !== "input" || String(this.type).toLowerCase() !== "file") throw new Error("Element is not an <input type=file>");
      if (files.length > 1 && !this.multiple) throw new Error("This file input takes one file; it has no multiple attribute");
      const transfer = new DataTransfer();
      for (const file of files) {
        const binary = atob(file.base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        transfer.items.add(new File([bytes], file.name, { type: file.mimeType }));
      }
      this.files = transfer.files;
      this.dispatchEvent(new Event("input", { bubbles: true }));
      this.dispatchEvent(new Event("change", { bubbles: true }));
      return this.files.length;
    }`, [payloads]), options.timeout, false)) as number;
  }

  async textContent(): Promise<string | null> {
    return (await this.read("function(){ return this.textContent; }")) as string | null;
  }

  async innerText(): Promise<string> {
    return (await this.read("function(){ return this.innerText; }")) as string;
  }

  async innerHTML(): Promise<string> {
    return (await this.read("function(){ return this.innerHTML; }")) as string;
  }

  async inputValue(): Promise<string> {
    return (await this.read("function(){ return this.value ?? ''; }")) as string;
  }

  async getAttribute(name: string): Promise<string | null> {
    return (await this.read("function(name){ return this.getAttribute(name); }", [name])) as string | null;
  }

  async isChecked(): Promise<boolean> {
    return (await this.read("function(){ return this.checked ?? this.getAttribute('aria-checked') === 'true'; }")) as boolean;
  }

  async isEnabled(): Promise<boolean> {
    return (await this.read("function(){ return !this.disabled && this.getAttribute('aria-disabled') !== 'true'; }")) as boolean;
  }

  async isDisabled(): Promise<boolean> {
    return !(await this.isEnabled());
  }

  async isVisible(): Promise<boolean> {
    const handle = await this.query().catch(() => null);
    if (!handle) return false;
    try {
      return (await this.call(handle, "function(){ return __apart.visible(this) }")) as boolean;
    } finally {
      await this.releaseHandle(handle);
    }
  }

  async isHidden(): Promise<boolean> {
    return !(await this.isVisible());
  }

  async boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null> {
    const handle = await this.query();
    if (!handle) return null;
    try {
      return await this.box(handle);
    } finally {
      await this.releaseHandle(handle);
    }
  }

  async evaluate(fn: string | ((element: any, ...args: any[]) => unknown), ...args: unknown[]): Promise<unknown> {
    const body = typeof fn === "function" ? fn.toString() : `function(element){ return (${fn}); }`;
    return this.withElement((handle) => this.call(handle, `function(...args){ return (${body}).call(null, this, ...args); }`, args));
  }

  async screenshot(options: ScreenshotOptions & { margin?: number } = {}): Promise<Buffer> {
    return this.withElement(async (handle) => {
      await this.scrollIntoView(handle);
      const box = await this.box(handle);
      if (!box) throw new Error(`${this.describe()} has no layout box`);
      const margin = options.margin ?? 8;
      const { margin: _margin, ...rest } = options;
      return this.page.screenshot({
        ...rest,
        clip: { x: Math.max(0, box.x - margin), y: Math.max(0, box.y - margin), width: box.width + margin * 2, height: box.height + margin * 2 },
      });
    });
  }

  async childFrameId(): Promise<string | null> {
    const handle = await this.query().catch(() => null);
    if (!handle) return null;
    try {
      const { node } = await this.page.send<{ node: { nodeName: string; frameId?: string } }>("DOM.describeNode", { objectId: handle.objectId }, handle.ctx?.sessionId);
      if (!["IFRAME", "FRAME"].includes(node.nodeName)) throw new Error(`${this.describe()} is a <${node.nodeName.toLowerCase()}>, not an <iframe>`);
      return node.frameId ?? null;
    } finally {
      await this.releaseHandle(handle);
    }
  }

  describe(): string {
    const { kind, arg } = this.selector;
    const detail = kind === "css" ? String(arg.selector) : kind === "role" ? `${arg.role}${arg.name ? ` "${arg.name}"` : ""}` : String(arg.text ?? arg.ref);
    return `locator(${kind}=${detail})${this.index ? `.nth(${this.index})` : ""}`;
  }

  private context(): Promise<FrameContext | undefined> {
    return this.frame ? this.frame() : Promise.resolve(undefined);
  }

  private call(handle: Handle, functionDeclaration: string, args: unknown[] = []): Promise<unknown> {
    return this.page.callOn(handle.objectId, functionDeclaration, args, true, handle.ctx?.sessionId);
  }

  private async read(functionDeclaration: string, args: unknown[] = []): Promise<unknown> {
    return this.withElement((handle) => this.call(handle, functionDeclaration, args), LOCATOR_TIMEOUT_MS, false);
  }

  private async withElement<T>(action: (handle: Handle) => Promise<T>, timeout = LOCATOR_TIMEOUT_MS, visible = true): Promise<T> {
    const handle = await this.resolve({ timeout, visible });
    try {
      return await action(handle);
    } finally {
      await this.releaseHandle(handle);
    }
  }

  private async resolve(options: { timeout: number; visible: boolean }): Promise<Handle> {
    const deadline = Date.now() + options.timeout;
    for (let attempt = 0; ; attempt++) {
      const handle = await this.query().catch((error) => {
        if (Date.now() > deadline) throw error;
        return null;
      });
      if (handle) {
        if (!options.visible) return handle;
        if (await this.call(handle, "function(){ return __apart.visible(this) }")) return handle;
        await this.releaseHandle(handle);
      }
      if (Date.now() > deadline) {
        throw new TimeoutError(`Timeout ${options.timeout}ms exceeded waiting for ${this.describe()}${handle ? " to be visible" : ""}`);
      }
      await sleep(POLL_INTERVALS_MS[Math.min(attempt, POLL_INTERVALS_MS.length - 1)]);
    }
  }

  private async query(): Promise<Handle | null> {
    const ctx = await this.context();
    const result = (await this.page.evalInWorld(
      `__apart.find(${JSON.stringify(this.selector.kind)}, ${JSON.stringify(this.selector.arg)}, ${this.index})`,
      false,
      ctx,
    )) as RemoteObject;
    return result.subtype === "null" || !result.objectId ? null : { objectId: result.objectId, ctx };
  }

  private async releaseHandle(handle: Handle): Promise<void> {
    await this.page.release(handle.objectId, handle.ctx?.sessionId);
  }

  private async scrollIntoView(handle: Handle): Promise<void> {
    if (handle.ctx) await this.page.revealFrame(handle.ctx);
    await this.page.send("DOM.scrollIntoViewIfNeeded", { objectId: handle.objectId }, handle.ctx?.sessionId).catch(() =>
      this.call(handle, "function(){ this.scrollIntoView({ block: 'center', inline: 'center' }); }"),
    );
  }

  private async box(handle: Handle, local = false): Promise<{ x: number; y: number; width: number; height: number } | null> {
    const quads = await this.page.send<{ quads: number[][] }>("DOM.getContentQuads", { objectId: handle.objectId }, handle.ctx?.sessionId).catch(() => null);
    const quad = quads?.quads?.[0];
    if (!quad) return null;
    const offset = handle.ctx && !local ? await this.page.frameOffset(handle.ctx) : { x: 0, y: 0 };
    const xs = [quad[0], quad[2], quad[4], quad[6]];
    const ys = [quad[1], quad[3], quad[5], quad[7]];
    const x = Math.min(...xs) + offset.x;
    const y = Math.min(...ys) + offset.y;
    return { x, y, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  }

  private async clickPoint(handle: Handle, position?: { x: number; y: number }, local = false): Promise<{ x: number; y: number }> {
    await this.scrollIntoView(handle);
    const box = await this.box(handle, local);
    if (!box || (box.width === 0 && box.height === 0)) throw new Error(`${this.describe()} is not visible or has no size`);
    if (position) return { x: box.x + position.x, y: box.y + position.y };
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }
}
