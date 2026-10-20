import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import type { BrowserBackend, TabEvent } from "./backend";
import type { ExtRequestMethod, TabInfo } from "../shared/protocol";

const REQUEST_TIMEOUT_MS = 60000;
const LAUNCH_TIMEOUT_MS = 20000;
const CLOSE_GRACE_MS = 3000;
const DEFAULT_IDLE_MS = 5 * 60 * 1000;
const STDERR_TAIL_BYTES = 4000;

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

interface Target {
  tabId: number;
  targetId: string;
  sessionId: string | null;
  url: string;
  title: string;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, any>;
  result?: unknown;
  error?: { message: string };
  sessionId?: string;
}

export class HeadlessUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeadlessUnavailableError";
  }
}

function linuxCandidates(env: NodeJS.ProcessEnv): string[] {
  const names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
  const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  return dirs.flatMap((dir) => names.map((name) => path.join(dir, name)));
}

export function findChrome(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.APART_CHROME) return existsSync(env.APART_CHROME) ? env.APART_CHROME : null;
  const candidates = process.platform === "darwin"
    ? [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    ]
    : process.platform === "linux" ? linuxCandidates(env) : [];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export interface HeadlessOptions {
  profileDir: string;
  executable?: string | null;
  idleMs?: number;
  log?: (message: string) => void;
}

export class HeadlessBrowser extends EventEmitter implements BrowserBackend {
  private child: ChildProcess | null = null;
  private input: Writable | null = null;
  private starting: Promise<void> | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private nextTabId = 1;
  private byTarget = new Map<string, Target>();
  private byTab = new Map<number, Target>();
  private bySession = new Map<string, Target>();
  private childSessions = new Map<string, Target>();
  private downloadDir: string | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private users = 0;
  private stderrTail = "";

  constructor(private readonly options: HeadlessOptions) {
    super();
  }

  get connected(): boolean {
    return this.child !== null && this.input !== null;
  }

  async acquire(): Promise<void> {
    this.users += 1;
    this.cancelIdle();
    try {
      if (!this.connected) {
        this.starting ??= this.launch().finally(() => {
          this.starting = null;
        });
        await this.starting;
      }
    } catch (error) {
      this.users -= 1;
      throw error;
    }
  }

  release(): void {
    this.users = Math.max(0, this.users - 1);
    if (this.users > 0 || !this.connected) return;
    this.cancelIdle();
    this.idleTimer = setTimeout(() => void this.close(), this.options.idleMs ?? DEFAULT_IDLE_MS);
    this.idleTimer.unref();
  }

  async request<T = unknown>(method: ExtRequestMethod, params: Record<string, unknown> = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    if (!this.connected) throw new Error("Headless Chrome is not running");
    switch (method) {
      case "tabs.list":
        return (await this.listTabs()) as T;
      case "tabs.create": {
        const url = String(params.url ?? "about:blank");
        const { targetId } = await this.call<{ targetId: string }>("Target.createTarget", { url });
        return this.info(this.track(targetId, url, "")) as T;
      }
      case "tabs.close": {
        const target = this.byTab.get(Number(params.tabId));
        if (target) await this.call("Target.closeTarget", { targetId: target.targetId }).catch(() => undefined);
        return true as T;
      }
      case "tabs.active":
        return null as T;
      case "tabs.activate": {
        await this.call("Target.activateTarget", { targetId: this.require(params.tabId).targetId });
        return true as T;
      }
      case "debugger.attach": {
        const target = this.require(params.tabId);
        if (!target.sessionId) {
          const { sessionId } = await this.call<{ sessionId: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true });
          target.sessionId = sessionId;
          this.bySession.set(sessionId, target);
        }
        return true as T;
      }
      case "debugger.detach": {
        const target = this.byTab.get(Number(params.tabId));
        if (target?.sessionId) {
          const sessionId = target.sessionId;
          for (const [child, owner] of this.childSessions) if (owner === target) this.childSessions.delete(child);
          this.bySession.delete(sessionId);
          target.sessionId = null;
          await this.call("Target.detachFromTarget", { sessionId }).catch(() => undefined);
        }
        return true as T;
      }
      case "debugger.send": {
        const target = this.require(params.tabId);
        if (!target.sessionId) throw new Error(`Tab ${target.tabId} is not attached`);
        const child = typeof params.sessionId === "string" ? params.sessionId : null;
        if (child && this.childSessions.get(child) !== target) throw new Error(`Frame session ${child} is gone`);
        return this.call<T>(String(params.method), (params.params ?? {}) as Record<string, unknown>, child ?? target.sessionId, timeoutMs);
      }
      case "downloads.enable": {
        const downloadPath = String(params.downloadPath);
        if (this.downloadDir !== downloadPath) {
          await this.call("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath, eventsEnabled: true });
          this.downloadDir = downloadPath;
        }
        return { mode: "direct", downloadPath } as T;
      }
      case "downloads.expect":
        throw new Error("Headless downloads are saved directly; downloads.expect is only for the extension");
      default:
        throw new Error(`Unsupported method: ${String(method)}`);
    }
  }

  async listTabs(): Promise<TabInfo[]> {
    const { targetInfos } = await this.call<{ targetInfos: { targetId: string; type: string; url: string; title: string }[] }>("Target.getTargets");
    return targetInfos
      .filter((info) => info.type === "page")
      .map((info) => this.info(this.track(info.targetId, info.url, info.title)));
  }

  onTab(tabId: number, listener: (event: TabEvent) => void): () => void {
    const name = `tab:${tabId}`;
    this.on(name, listener);
    return () => this.off(name, listener);
  }

  async close(): Promise<void> {
    this.cancelIdle();
    const child = this.child;
    if (!child) return;
    this.options.log?.("closing headless Chrome");
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await this.call("Browser.close", {}, undefined, CLOSE_GRACE_MS).catch(() => undefined);
    const timer = setTimeout(() => child.kill("SIGKILL"), CLOSE_GRACE_MS);
    await exited;
    clearTimeout(timer);
  }

  kill(): void {
    this.child?.kill("SIGKILL");
  }

  private async launch(): Promise<void> {
    const executable = this.options.executable === undefined ? findChrome() : this.options.executable;
    if (!executable) {
      throw new HeadlessUnavailableError(process.env.APART_CHROME
        ? `APART_CHROME points to ${process.env.APART_CHROME}, which does not exist.`
        : "No Chrome or Chromium found for headless runs. Install Google Chrome, or set APART_CHROME to a Chrome or Chromium executable.");
    }
    await fs.mkdir(this.options.profileDir, { recursive: true, mode: 0o700 });
    this.stderrTail = "";
    const child = spawn(executable, [
      "--headless=new",
      "--remote-debugging-pipe",
      `--user-data-dir=${this.options.profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1280,800",
      "--hide-scrollbars",
      "--mute-audio",
      "about:blank",
    ], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
    const input = child.stdio[3] as Writable;
    const output = child.stdio[4] as Readable;
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });
    input.on("error", () => undefined);
    output.on("error", () => undefined);

    let buffer = Buffer.alloc(0);
    output.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      let end = buffer.indexOf(0);
      while (end >= 0) {
        const raw = buffer.subarray(0, end).toString("utf8");
        buffer = buffer.subarray(end + 1);
        end = buffer.indexOf(0);
        try {
          this.onMessage(JSON.parse(raw) as CdpMessage);
        } catch {
          continue;
        }
      }
    });

    const failure = new Promise<never>((_, reject) => {
      child.once("error", (error) => reject(new HeadlessUnavailableError(`Could not start headless Chrome at ${executable}: ${error.message}`)));
      child.once("exit", (code, signal) => reject(new HeadlessUnavailableError(`Headless Chrome exited during startup (${signal ?? `code ${code}`}).${this.lastStderrLine()}`)));
    });
    failure.catch(() => undefined);
    child.once("exit", () => this.onExit(child));

    this.child = child;
    this.input = input;
    try {
      await Promise.race([this.call("Target.setDiscoverTargets", { discover: true }, undefined, LAUNCH_TIMEOUT_MS), failure]);
    } catch (error) {
      child.kill("SIGKILL");
      this.child = null;
      this.input = null;
      throw error instanceof HeadlessUnavailableError ? error : new HeadlessUnavailableError(`Headless Chrome did not respond: ${error instanceof Error ? error.message : String(error)}.${this.lastStderrLine()}`);
    }
    this.options.log?.(`headless Chrome started (pid ${child.pid}, ${executable})`);
  }

  private lastStderrLine(): string {
    const line = this.stderrTail.trim().split("\n").filter(Boolean).pop();
    return line ? ` Last message: ${line.slice(0, 300)}` : "";
  }

  private call<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    const input = this.input;
    if (!input) return Promise.reject(new Error("Headless Chrome is not running"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Headless Chrome did not answer ${method} within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      input.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
  }

  private onMessage(message: CdpMessage): void {
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }
    if (message.sessionId) {
      const top = this.bySession.get(message.sessionId);
      const target = top ?? this.childSessions.get(message.sessionId);
      if (!target || !message.method) return;
      const params = message.params ?? {};
      if (message.method === "Target.attachedToTarget" && typeof params.sessionId === "string") this.childSessions.set(params.sessionId, target);
      else if (message.method === "Target.detachedFromTarget" && typeof params.sessionId === "string") this.childSessions.delete(params.sessionId);
      this.emit(`tab:${target.tabId}`, { method: message.method, params: message.params, ...(top ? {} : { sessionId: message.sessionId }) });
      return;
    }
    const params = message.params ?? {};
    if (message.method === "Browser.downloadWillBegin" || message.method === "Browser.downloadProgress") {
      const owner = typeof params.frameId === "string" ? this.byTarget.get(params.frameId) : undefined;
      const receivers = owner?.sessionId ? [owner] : Array.from(this.byTarget.values()).filter((target) => target.sessionId);
      for (const target of receivers) this.emit(`tab:${target.tabId}`, { method: message.method, params });
      return;
    }
    if (message.method === "Target.targetInfoChanged") {
      const target = this.byTarget.get(params.targetInfo?.targetId);
      if (target) {
        target.url = params.targetInfo.url;
        target.title = params.targetInfo.title;
      }
    } else if (message.method === "Target.detachedFromTarget") {
      const target = this.bySession.get(params.sessionId);
      if (!target) return;
      this.bySession.delete(params.sessionId);
      target.sessionId = null;
      this.emit(`tab:${target.tabId}`, { method: "__detached", params: { reason: "target_closed" } });
    } else if (message.method === "Target.targetDestroyed") {
      const target = this.byTarget.get(params.targetId);
      if (!target) return;
      this.forget(target);
    }
  }

  private onExit(child: ChildProcess): void {
    if (this.child !== child) return;
    this.child = null;
    this.input = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Headless Chrome exited"));
    }
    this.pending.clear();
    this.childSessions.clear();
    this.downloadDir = null;
    for (const target of Array.from(this.byTarget.values())) this.forget(target);
    this.nextTabId = 1;
    this.options.log?.("headless Chrome stopped");
  }

  private forget(target: Target): void {
    for (const [sessionId, owner] of this.childSessions) if (owner === target) this.childSessions.delete(sessionId);
    this.byTarget.delete(target.targetId);
    this.byTab.delete(target.tabId);
    if (target.sessionId) {
      this.bySession.delete(target.sessionId);
      target.sessionId = null;
      this.emit(`tab:${target.tabId}`, { method: "__detached", params: { reason: "target_closed" } });
    }
  }

  private track(targetId: string, url: string, title: string): Target {
    const existing = this.byTarget.get(targetId);
    if (existing) {
      if (url) existing.url = url;
      if (title) existing.title = title;
      return existing;
    }
    const target: Target = { tabId: this.nextTabId++, targetId, sessionId: null, url, title };
    this.byTarget.set(targetId, target);
    this.byTab.set(target.tabId, target);
    return target;
  }

  private require(tabId: unknown): Target {
    const target = this.byTab.get(Number(tabId));
    if (!target) throw new Error(`No headless tab with id ${String(tabId)}`);
    return target;
  }

  private info(target: Target): TabInfo {
    return { tabId: target.tabId, url: target.url, title: target.title, active: false, windowId: 0 };
  }

  private cancelIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}
