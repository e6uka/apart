import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { BrowserBackend, TabEvent } from "./backend";
import {
  PROTOCOL_VERSION,
  type DaemonInfo,
  type DaemonToExt,
  type ExtRequestMethod,
  type ExtToDaemon,
  type TabInfo,
} from "../shared/protocol";

const HELLO_TIMEOUT_MS = 5000;
const PING_INTERVAL_MS = 20000;
const REQUEST_TIMEOUT_MS = 60000;

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export type { TabEvent } from "./backend";

export class ExtensionNotConnectedError extends Error {
  constructor() {
    super("Chrome extension is not connected. Load dist/extension in Chrome, then run `apart doctor`.");
    this.name = "ExtensionNotConnectedError";
  }
}

export class ExtensionBridge extends EventEmitter implements BrowserBackend {
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private pingTimer: NodeJS.Timeout | null = null;
  extensionVersion: string | null = null;

  private readonly allowedOrigins: Set<string>;

  constructor(readonly port: number, allowedOrigins: string | string[], private readonly info: DaemonInfo = { version: "dev", pid: process.pid, port }) {
    super();
    this.allowedOrigins = new Set(Array.isArray(allowedOrigins) ? allowedOrigins : [allowedOrigins]);
  }

  notify(message: DaemonToExt): void {
    this.send(message);
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN && this.extensionVersion !== null;
  }

  async listen(): Promise<void> {
    this.http = createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    this.wss = new WebSocketServer({ server: this.http, path: "/ext" });
    this.wss.on("connection", (ws, req) => this.accept(ws, req));
    this.wss.on("error", () => undefined);
    await new Promise<void>((resolve, reject) => {
      this.http!.once("error", reject);
      this.http!.listen(this.port, "127.0.0.1", () => resolve());
    });
    this.pingTimer = setInterval(() => this.send({ type: "ping" }), PING_INTERVAL_MS);
  }

  async waitForConnection(timeoutMs: number): Promise<boolean> {
    if (this.connected) return true;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.off("connected", onConnected);
        resolve(false);
      }, timeoutMs);
      const onConnected = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.once("connected", onConnected);
    });
  }

  async request<T = unknown>(method: ExtRequestMethod, params?: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    if (!this.connected) throw new ExtensionNotConnectedError();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Extension request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.send({ id, method, params });
    });
  }

  listTabs(): Promise<TabInfo[]> {
    return this.request<TabInfo[]>("tabs.list");
  }

  onTab(tabId: number, listener: (event: TabEvent) => void): () => void {
    const name = `tab:${tabId}`;
    this.on(name, listener);
    return () => this.off(name, listener);
  }

  close(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.failAll(new Error("daemon shutting down"));
    this.socket?.close(1001, "daemon shutting down");
    this.wss?.close();
    this.http?.close();
  }

  private send(message: DaemonToExt): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private accept(ws: WebSocket, req: IncomingMessage): void {
    if (!req.headers.origin || !this.allowedOrigins.has(req.headers.origin)) {
      ws.close(4003, "origin not allowed");
      return;
    }
    let greeted = false;
    const helloTimer = setTimeout(() => {
      if (!greeted) ws.close(4001, "hello timeout");
    }, HELLO_TIMEOUT_MS);
    ws.on("message", (data) => {
      let message: ExtToDaemon;
      try {
        message = JSON.parse(String(data)) as ExtToDaemon;
      } catch {
        return;
      }
      if (!greeted) {
        if (!("type" in message) || message.type !== "hello" || message.version !== PROTOCOL_VERSION) {
          ws.close(4001, "bad hello");
          return;
        }
        greeted = true;
        clearTimeout(helloTimer);
        if (this.socket && this.socket !== ws) this.socket.close(1012, "replaced by newer connection");
        this.socket = ws;
        this.extensionVersion = message.extensionVersion;
        ws.send(JSON.stringify({ type: "welcome", daemon: this.info }));
        this.emit("connected", message);
        return;
      }
      this.handle(message);
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (this.socket !== ws) return;
      this.socket = null;
      this.extensionVersion = null;
      this.failAll(new Error("Chrome extension disconnected"));
      this.emit("disconnected");
    });
    ws.on("error", () => {});
  }

  private handle(message: ExtToDaemon): void {
    if ("id" in message) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error ?? "extension request failed"));
      return;
    }
    if (message.type === "clear-history") this.emit("clear-history", message.before);
    else if (message.type === "set-default-browser") this.emit("set-default-browser", message.browser);
    else if (message.type === "event") this.emit(`tab:${message.tabId}`, { method: message.method, params: message.params });
    else if (message.type === "detached") this.emit(`tab:${message.tabId}`, { method: "__detached", params: { reason: message.reason } });
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
