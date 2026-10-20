import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { BrowserBackend, TabEvent } from "./backend";
import { resolveInside } from "./confined-fs";
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

const DEFAULT_TIMEOUT_MS = 30000;
const LOCATOR_TIMEOUT_MS = 3000;
const POLL_INTERVALS_MS = [0, 20, 50, 100, 100, 250, 500];
const PAPER_SIZES: Record<string, [number, number]> = {
  letter: [8.5, 11], legal: [8.5, 14], tabloid: [11, 17], ledger: [17, 11],
  a0: [33.1, 46.8], a1: [23.4, 33.1], a2: [16.54, 23.4], a3: [11.7, 16.54], a4: [8.27, 11.7], a5: [5.83, 8.27], a6: [4.13, 5.83],
};
const UNFILLABLE_INPUTS = ["checkbox", "radio", "file", "button", "submit", "reset", "image"];
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
  private world: { contextId: number } | null = null;
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

  static async attach(bridge: BrowserBackend, tabId: number, ownership: Ownership, runDir: string, initialUrl: string, onVisit?: (url: string) => void): Promise<Page> {
    const page = new Page(bridge, tabId, ownership, runDir, initialUrl, onVisit);
    onVisit?.(initialUrl);
    await bridge.request("debugger.attach", { tabId });
    await page.send("Page.enable");
    await page.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => undefined);
    return page;
  }

  url(): string {
    return this.currentUrl;
  }

  isClosed(): boolean {
    return this.detached;
  }

  async send<T = Record<string, any>>(method: string, params: CdpParams = {}): Promise<T> {
    if (this.detached) throw new Error(`Tab ${this.targetId} is closed`);
    return this.bridge.request<T>("debugger.send", { tabId: this.tabId, method, params });
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
    this.world = null;
    if (options.waitUntil === "commit") {
      load.cancel();
      return;
    }
    await load.promise;
  }

  async reload(options: { timeout?: number } = {}): Promise<void> {
    const load = this.waitForLoad(options.timeout ?? DEFAULT_TIMEOUT_MS, "reload");
    await this.send("Page.reload");
    this.world = null;
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
    return new Locator(this, { kind: "css", arg: { selector } });
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
    const result = (await this.evalInWorld(`__apart.snapshot(${JSON.stringify(options)})`, true)) as { tree: string; fullTree: string };
    const diff = diffTrees(this.lastTree, result.fullTree);
    this.lastTree = result.fullTree;
    return { tree: result.tree, diff };
  }

  async annotatedScreenshot(options: { path?: string } = {}): Promise<{ base64Image: string; refCount: number }> {
    const refCount = (await this.evalInWorld("__apart.refCount()", true)) as number;
    if (refCount === 0) await this.snapshot({ interactive: true });
    await this.evalInWorld("__apart.annotate()", true);
    try {
      const buffer = await this.screenshot({ type: "png", path: options.path });
      return { base64Image: buffer.toString("base64"), refCount: (await this.evalInWorld("__apart.refCount()", true)) as number };
    } finally {
      await this.evalInWorld("__apart.unannotate()", true).catch(() => undefined);
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
    if (this.ownership === "owned") await this.bridge.request("tabs.close", { tabId: this.tabId }).catch(() => undefined);
    else await this.bridge.request("debugger.detach", { tabId: this.tabId }).catch(() => undefined);
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

  async mouseClick(x: number, y: number, options: { button?: "left" | "right" | "middle"; clickCount?: number; modifiers?: number } = {}): Promise<void> {
    const button = options.button ?? "left";
    const clicks = options.clickCount ?? 1;
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers: options.modifiers ?? 0 });
    for (let count = 1; count <= clicks; count++) {
      await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: count, modifiers: options.modifiers ?? 0 });
      await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: count, modifiers: options.modifiers ?? 0 });
    }
  }

  async saveArtifact(target: string, data: Buffer): Promise<string> {
    const resolved = resolveInside(this.runDir, target);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, data);
    return resolved;
  }

  async evalInWorld(expression: string, returnByValue: boolean): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const contextId = await this.ensureWorld();
      try {
        const result = await this.send<EvalResult>("Runtime.evaluate", { expression, contextId, returnByValue, awaitPromise: true });
        if (result.exceptionDetails) throw new Error(formatException(result.exceptionDetails));
        return returnByValue ? result.result.value : result.result;
      } catch (error) {
        if (attempt === 0 && isContextError(error)) {
          this.world = null;
          continue;
        }
        throw error;
      }
    }
    throw new Error("Isolated world unavailable");
  }

  async callOn(objectId: string, functionDeclaration: string, args: unknown[] = [], returnByValue = true): Promise<unknown> {
    const result = await this.send<EvalResult>("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration,
      arguments: args.map((value) => ({ value })),
      returnByValue,
      awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error(formatException(result.exceptionDetails));
    return returnByValue ? result.result.value : result.result;
  }

  async release(objectId: string): Promise<void> {
    await this.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
  }

  private async ensureWorld(): Promise<number> {
    if (this.world) return this.world.contextId;
    const { frameTree } = await this.send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree");
    const { executionContextId } = await this.send<{ executionContextId: number }>("Page.createIsolatedWorld", {
      frameId: frameTree.frame.id,
      worldName: "__apart",
      grantUniveralAccess: false,
    });
    const probe = await this.send<EvalResult>("Runtime.evaluate", { expression: "typeof __apart", contextId: executionContextId, returnByValue: true });
    if (probe.result.value !== "object") {
      await this.send("Runtime.evaluate", { expression: injectedSource(), contextId: executionContextId });
    }
    this.world = { contextId: executionContextId };
    return executionContextId;
  }

  private async navigateHistory(delta: number, timeout: number): Promise<void> {
    const history = await this.send<{ currentIndex: number; entries: { id: number }[] }>("Page.getNavigationHistory");
    const entry = history.entries[history.currentIndex + delta];
    if (!entry) return;
    const load = this.waitForLoad(timeout, "history navigation");
    await this.send("Page.navigateToHistoryEntry", { entryId: entry.id });
    this.world = null;
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

  private onEvent(event: TabEvent): void {
    const params = (event.params ?? {}) as Record<string, any>;
    switch (event.method) {
      case "Page.frameNavigated":
        if (!params.frame?.parentId) {
          this.currentUrl = params.frame.url;
          this.world = null;
          this.onVisit(params.frame.url);
        }
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
        void this.send("Page.handleJavaScriptDialog", { accept: params.type === "beforeunload" }).catch(() => undefined);
        break;
      case "__detached":
        this.detached = true;
        this.unsubscribe();
        this.failLoadWaiters();
        break;
    }
  }
}

export class Locator {
  constructor(private readonly page: Page, private readonly selector: Selector, private readonly index = 0) {}

  first(): Locator { return new Locator(this.page, this.selector, 0); }
  last(): Locator { return new Locator(this.page, this.selector, -1); }
  nth(index: number): Locator { return new Locator(this.page, this.selector, index); }

  async all(): Promise<Locator[]> {
    const total = await this.count();
    return Array.from({ length: total }, (_, i) => this.nth(i));
  }

  async count(): Promise<number> {
    return (await this.page.evalInWorld(`__apart.countOf(${JSON.stringify(this.selector.kind)}, ${JSON.stringify(this.selector.arg)})`, true)) as number;
  }

  async waitFor(options: { state?: WaitState; timeout?: number } = {}): Promise<void> {
    const state = options.state ?? "visible";
    const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    if (state === "attached" || state === "visible") {
      await this.release(await this.resolve({ timeout, visible: state === "visible" }));
      return;
    }
    const deadline = Date.now() + timeout;
    for (let attempt = 0; ; attempt++) {
      const objectId = await this.query();
      if (!objectId) return;
      const visible = state === "hidden" ? await this.page.callOn(objectId, "function(){ return __apart.visible(this) }") : true;
      await this.release(objectId);
      if (state === "hidden" && !visible) return;
      if (Date.now() > deadline) throw new TimeoutError(`Timeout ${timeout}ms exceeded waiting for ${this.describe()} to be ${state}`);
      await sleep(POLL_INTERVALS_MS[Math.min(attempt, POLL_INTERVALS_MS.length - 1)]);
    }
  }

  async click(options: { button?: "left" | "right" | "middle"; clickCount?: number; timeout?: number; position?: { x: number; y: number }; modifiers?: string[] } = {}): Promise<void> {
    await this.withElement(async (objectId) => {
      const point = await this.clickPoint(objectId, options.position);
      const modifiers = (options.modifiers ?? []).reduce((bits, name) => bits | keyDescriptor(`${name}+a`).modifiers & ~8, 0);
      await this.page.mouseClick(point.x, point.y, { button: options.button, clickCount: options.clickCount, modifiers });
    }, options.timeout);
  }

  async dblclick(options: { timeout?: number } = {}): Promise<void> {
    await this.click({ ...options, clickCount: 2 });
  }

  async hover(options: { timeout?: number } = {}): Promise<void> {
    await this.withElement(async (objectId) => {
      const point = await this.clickPoint(objectId);
      await this.page.mouse.move(point.x, point.y);
    }, options.timeout);
  }

  async focus(options: { timeout?: number } = {}): Promise<void> {
    await this.withElement((objectId) => this.page.callOn(objectId, "function(){ this.focus(); }"), options.timeout);
  }

  async scrollIntoViewIfNeeded(options: { timeout?: number } = {}): Promise<void> {
    await this.withElement((objectId) => this.scrollIntoView(objectId), options.timeout);
  }

  async fill(value: string, options: { timeout?: number } = {}): Promise<void> {
    await this.withElement(async (objectId) => {
      await this.scrollIntoView(objectId);
      const mode = (await this.page.callOn(objectId, `function(value, unfillable, viaSetter){
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
    await this.withElement(async (objectId) => {
      await this.page.callOn(objectId, "function(){ this.focus(); }");
      await this.page.insertText(text);
    }, options.timeout);
  }

  async press(key: string, options: { timeout?: number } = {}): Promise<void> {
    await this.withElement(async (objectId) => {
      await this.page.callOn(objectId, "function(){ this.focus(); }");
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
    return (await this.withElement((objectId) => this.page.callOn(objectId, `function(wanted){
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
    const objectId = await this.query();
    if (!objectId) return false;
    try {
      return (await this.page.callOn(objectId, "function(){ return __apart.visible(this) }")) as boolean;
    } finally {
      await this.release(objectId);
    }
  }

  async isHidden(): Promise<boolean> {
    return !(await this.isVisible());
  }

  async boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null> {
    const objectId = await this.query();
    if (!objectId) return null;
    try {
      return await this.box(objectId);
    } finally {
      await this.release(objectId);
    }
  }

  async evaluate(fn: string | ((element: any, ...args: any[]) => unknown), ...args: unknown[]): Promise<unknown> {
    const body = typeof fn === "function" ? fn.toString() : `function(element){ return (${fn}); }`;
    return this.withElement((objectId) => this.page.callOn(objectId, `function(...args){ return (${body}).call(null, this, ...args); }`, args));
  }

  async screenshot(options: ScreenshotOptions & { margin?: number } = {}): Promise<Buffer> {
    return this.withElement(async (objectId) => {
      await this.scrollIntoView(objectId);
      const box = await this.box(objectId);
      if (!box) throw new Error(`${this.describe()} has no layout box`);
      const margin = options.margin ?? 8;
      const { margin: _margin, ...rest } = options;
      return this.page.screenshot({
        ...rest,
        clip: { x: Math.max(0, box.x - margin), y: Math.max(0, box.y - margin), width: box.width + margin * 2, height: box.height + margin * 2 },
      });
    });
  }

  describe(): string {
    const { kind, arg } = this.selector;
    const detail = kind === "css" ? String(arg.selector) : kind === "role" ? `${arg.role}${arg.name ? ` "${arg.name}"` : ""}` : String(arg.text ?? arg.ref);
    return `locator(${kind}=${detail})${this.index ? `.nth(${this.index})` : ""}`;
  }

  private async read(functionDeclaration: string, args: unknown[] = []): Promise<unknown> {
    return this.withElement((objectId) => this.page.callOn(objectId, functionDeclaration, args), LOCATOR_TIMEOUT_MS, false);
  }

  private async withElement<T>(action: (objectId: string) => Promise<T>, timeout = LOCATOR_TIMEOUT_MS, visible = true): Promise<T> {
    const objectId = await this.resolve({ timeout, visible });
    try {
      return await action(objectId);
    } finally {
      await this.release(objectId);
    }
  }

  private async resolve(options: { timeout: number; visible: boolean }): Promise<string> {
    const deadline = Date.now() + options.timeout;
    for (let attempt = 0; ; attempt++) {
      const objectId = await this.query();
      if (objectId) {
        if (!options.visible) return objectId;
        if (await this.page.callOn(objectId, "function(){ return __apart.visible(this) }")) return objectId;
        await this.release(objectId);
      }
      if (Date.now() > deadline) {
        throw new TimeoutError(`Timeout ${options.timeout}ms exceeded waiting for ${this.describe()}${objectId ? " to be visible" : ""}`);
      }
      await sleep(POLL_INTERVALS_MS[Math.min(attempt, POLL_INTERVALS_MS.length - 1)]);
    }
  }

  private async query(): Promise<string | null> {
    const result = (await this.page.evalInWorld(
      `__apart.find(${JSON.stringify(this.selector.kind)}, ${JSON.stringify(this.selector.arg)}, ${this.index})`,
      false,
    )) as RemoteObject;
    return result.subtype === "null" || !result.objectId ? null : result.objectId;
  }

  private async release(objectId: string): Promise<void> {
    await this.page.release(objectId);
  }

  private async scrollIntoView(objectId: string): Promise<void> {
    await this.page.send("DOM.scrollIntoViewIfNeeded", { objectId }).catch(() =>
      this.page.callOn(objectId, "function(){ this.scrollIntoView({ block: 'center', inline: 'center' }); }"),
    );
  }

  private async box(objectId: string): Promise<{ x: number; y: number; width: number; height: number } | null> {
    const quads = await this.page.send<{ quads: number[][] }>("DOM.getContentQuads", { objectId }).catch(() => null);
    const quad = quads?.quads?.[0];
    if (!quad) return null;
    const xs = [quad[0], quad[2], quad[4], quad[6]];
    const ys = [quad[1], quad[3], quad[5], quad[7]];
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  }

  private async clickPoint(objectId: string, position?: { x: number; y: number }): Promise<{ x: number; y: number }> {
    await this.scrollIntoView(objectId);
    const box = await this.box(objectId);
    if (!box || (box.width === 0 && box.height === 0)) throw new Error(`${this.describe()} is not visible or has no size`);
    if (position) return { x: box.x + position.x, y: box.y + position.y };
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }
}
