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
  | "debugger.attach"
  | "debugger.detach"
  | "debugger.send";

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
}

export interface ExtEvent {
  type: "event";
  tabId: number;
  method: string;
  params: unknown;
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

export interface RunRecord {
  id: string;
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

export type ExtToDaemon = ExtHello | ExtResponse | ExtEvent | ExtDetached | { type: "pong" };
export type DaemonToExt =
  | ExtRequest
  | { type: "ping" }
  | { type: "welcome"; daemon: DaemonInfo }
  | { type: "run-started"; run: RunStarted }
  | { type: "run-finished"; run: RunRecord }
  | { type: "run-ended"; id: string };

export const RUN_HISTORY_LIMIT = 200;
export const MAX_URLS_PER_RUN = 20;

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
  | { type: "run"; code: string; timeoutMs?: number }
  | { type: "status" }
  | { type: "stop" };

export interface DaemonStatus {
  type: "status";
  pid: number;
  port: number;
  uptimeMs: number;
  extensionConnected: boolean;
  extensionVersion: string | null;
  running: boolean;
}

export type CliMessage =
  | { type: "out"; text: string }
  | { type: "done"; ok: boolean; error?: string; elapsedMs: number; runDir: string }
  | DaemonStatus
  | { type: "stopping" };
