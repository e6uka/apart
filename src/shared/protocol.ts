export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 27170;
export const EXTENSION_ID = "omkiljjaphabkenjdljjaopfdfadjgab";
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
export const STORE_EXTENSION_IDS: readonly string[] = [];

const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;

export function allowedExtensionIds(extra: string | undefined = process.env.APART_EXTENSION_IDS): string[] {
  const fromEnv = (extra ?? "").split(",").map((id) => id.trim()).filter((id) => EXTENSION_ID_PATTERN.test(id));
  return Array.from(new Set([EXTENSION_ID, ...STORE_EXTENSION_IDS, ...fromEnv]));
}

export function allowedExtensionOrigins(extra?: string): string[] {
  return allowedExtensionIds(extra).map((id) => `chrome-extension://${id}`);
}

export type ExtRequestMethod =
  | "tabs.list"
  | "tabs.create"
  | "tabs.close"
  | "tabs.active"
  | "tabs.activate"
  | "tabs.release"
  | "debugger.attach"
  | "debugger.detach"
  | "debugger.send"
  | "downloads.enable"
  | "downloads.expect";

export interface ExtRequest {
  id: number;
  method: ExtRequestMethod;
  params?: Record<string, unknown>;
}

export interface ExtResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface ExtHello {
  type: "hello";
  version: number;
  extensionVersion: string;
  historyClearedAt?: number;
}

export interface ExtEvent {
  type: "event";
  tabId: number;
  sessionId?: string;
  method: string;
  params: unknown;
}

export interface CompletedDownload {
  path: string;
  url: string;
  mimeType?: string;
  bytes?: number;
}

export interface ExtDetached {
  type: "detached";
  tabId: number;
  reason: string;
}

export interface DaemonInfo {
  version: string;
  pid: number;
  port: number;
}

export type RunBrowser = "chrome" | "headless";

export interface RunRecord {
  id: string;
  browser?: RunBrowser;
  startedAt: number;
  elapsedMs: number;
  ok: boolean;
  error?: string;
  urls: string[];
  tabsOpened: number;
}

export interface RunStarted {
  id: string;
  startedAt: number;
}

export type ExtToDaemon =
  | ExtHello
  | ExtResponse
  | ExtEvent
  | ExtDetached
  | { type: "pong" }
  | { type: "clear-history"; before: number }
  | { type: "set-default-browser"; browser: RunBrowser }
  | { type: "set-keep-tabs"; keep: boolean };
export type DaemonToExt =
  | ExtRequest
  | { type: "ping" }
  | { type: "welcome"; daemon: DaemonInfo }
  | { type: "run-started"; run: RunStarted }
  | { type: "run-finished"; run: RunRecord }
  | { type: "run-ended"; id: string }
  | { type: "history"; runs: RunRecord[] }
  | { type: "config"; defaultBrowser: RunBrowser; keepTabs: boolean };

export const RUN_HISTORY_LIMIT = 200;
export const MAX_URLS_PER_RUN = 20;

export function mergeRuns(current: readonly RunRecord[], incoming: readonly RunRecord[], clearedAt = 0, limit = RUN_HISTORY_LIMIT): RunRecord[] {
  const byId = new Map<string, RunRecord>();
  for (const run of [...current, ...incoming]) {
    if (run && typeof run.id === "string" && typeof run.startedAt === "number" && run.startedAt >= clearedAt) byId.set(run.id, run);
  }
  return Array.from(byId.values())
    .sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id))
    .slice(0, limit);
}

export function sanitizeUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return `${url.origin}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return null;
  }
}

export interface TabInfo {
  tabId: number;
  url: string;
  title: string;
  active: boolean;
  windowId: number;
}

export type CliRequest =
  | { type: "run"; code: string; timeoutMs?: number; browser?: RunBrowser }
  | { type: "status" }
  | { type: "stop" }
  | { type: "config-changed" };

export interface DaemonStatus {
  type: "status";
  pid: number;
  port: number;
  uptimeMs: number;
  extensionConnected: boolean;
  extensionVersion: string | null;
  running: boolean;
  headlessRunning: boolean;
  defaultBrowser: RunBrowser;
  keepTabs: boolean;
}

export type CliMessage =
  | { type: "out"; text: string }
  | { type: "done"; ok: boolean; error?: string; elapsedMs: number; runDir: string }
  | DaemonStatus
  | { type: "stopping" }
  | { type: "ok" };
