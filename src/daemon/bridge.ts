import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { BrowserBackend, TabEvent } from "./backend";
import { browserLabel, isExtensionBrowserName, nameFromBrands, nameFromProcess } from "../shared/browsers";
import {
  PROTOCOL_VERSION,
  type DaemonInfo,
  type DaemonToExt,
  type ExtHello,
  type ExtRequestMethod,
  type ExtToDaemon,
  type TabInfo,
} from "../shared/protocol";

const HELLO_TIMEOUT_MS = 5000;
const PING_INTERVAL_MS = 20000;
const REQUEST_TIMEOUT_MS = 60000;
const IDENTIFY_TIMEOUT_MS = 2000;

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export type { TabEvent } from "./backend";

export class ExtensionNotConnectedError extends Error {
  constructor(name?: string) {
    super(name
      ? `${browserLabel(name)} is not connected. Open it with the apart extension loaded, then run \`apart doctor\`.`
      : "No browser is connected. Load dist/extension in Chrome or Arc, then run `apart doctor`.");
    this.name = "ExtensionNotConnectedError";
  }
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: IDENTIFY_TIMEOUT_MS }, (_error, stdout) => resolve(String(stdout ?? "")));
  });
}

export async function identifyPeer(remotePort: number | undefined): Promise<string | null> {
  if (!remotePort) return null;
  const listing = await run("lsof", ["-nP", `-iTCP:${remotePort}`, "-sTCP:ESTABLISHED", "-Fp"]);
  const pids = listing.split("\n").filter((line) => line.startsWith("p")).map((line) => Number(line.slice(1))).filter((pid) => pid && pid !== process.pid);
  for (const pid of pids) {
    const executable = (await run("ps", ["-p", String(pid), "-o", "comm="])).trim();
    const name = executable ? nameFromProcess(executable) : null;
    if (name) return name;
  }
  return null;
}

export class ExtensionConnection extends EventEmitter implements BrowserBackend {
  private pending = new Map<number, Pending>();
  private nextId = 1;

  constructor(readonly name: string, readonly version: string, private readonly ws: WebSocket) {
    super();
  }

  get connected(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  send(message: DaemonToExt): void {
    if (this.connected) this.ws.send(JSON.stringify(message));
  }

  async request<T = unknown>(method: ExtRequestMethod, params?: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    if (!this.connected) throw new ExtensionNotConnectedError(this.name);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${browserLabel(this.name)} did not answer ${method} in time`));
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

  handle(message: ExtToDaemon): void {
    if ("id" in message) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error ?? "extension request failed"));
      return;
    }
    if (message.type === "event") this.emit(`tab:${message.tabId}`, { method: message.method, params: message.params, sessionId: message.sessionId });
    else if (message.type === "detached") this.emit(`tab:${message.tabId}`, { method: "__detached", params: { reason: message.reason } });
  }

  close(code: number, reason: string): void {
    this.ws.close(code, reason);
  }

  fail(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export interface BridgeOptions {
  identify?: (remotePort: number | undefined) => Promise<string | null>;
}

export class ExtensionBridge extends EventEmitter implements BrowserBackend {
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private connections = new Map<string, ExtensionConnection>();
  private pingTimer: NodeJS.Timeout | null = null;
  private readonly allowedOrigins: Set<string>;
  private readonly identify: (remotePort: number | undefined) => Promise<string | null>;

  constructor(
    readonly port: number,
    allowedOrigins: string | string[],
    private readonly info: DaemonInfo = { version: "dev", pid: process.pid, port },
    options: BridgeOptions = {},
  ) {
    super();
    this.allowedOrigins = new Set(Array.isArray(allowedOrigins) ? allowedOrigins : [allowedOrigins]);
    this.identify = options.identify ?? identifyPeer;
  }

  get connected(): boolean {
    return this.connections.size > 0;
  }

  get extensionVersion(): string | null {
    return this.latest()?.version ?? null;
  }

  browsers(): { name: string; version: string }[] {
    return Array.from(this.connections.values()).map((connection) => ({ name: connection.name, version: connection.version }));
  }

  connection(name?: string): ExtensionConnection | undefined {
    return name ? this.connections.get(name) : this.latest();
  }

  notify(message: DaemonToExt): void {
    for (const connection of this.connections.values()) connection.send(message);
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
    this.pingTimer = setInterval(() => this.notify({ type: "ping" }), PING_INTERVAL_MS);
  }

  async waitForConnection(timeoutMs: number, name?: string): Promise<boolean> {
    if (this.connection(name)) return true;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.off("connected", onConnected);
        resolve(false);
      }, timeoutMs);
      const onConnected = (connection: ExtensionConnection) => {
        if (name && connection.name !== name) return;
        clearTimeout(timer);
        this.off("connected", onConnected);
        resolve(true);
      };
      this.on("connected", onConnected);
    });
  }

  request<T = unknown>(method: ExtRequestMethod, params?: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    const connection = this.latest();
    if (!connection) return Promise.reject(new ExtensionNotConnectedError());
    return connection.request<T>(method, params, timeoutMs);
  }

  listTabs(): Promise<TabInfo[]> {
    return this.request<TabInfo[]>("tabs.list");
  }

  onTab(tabId: number, listener: (event: TabEvent) => void): () => void {
    const connection = this.latest();
    if (!connection) return () => undefined;
    return connection.onTab(tabId, listener);
  }

  close(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    for (const connection of this.connections.values()) {
      connection.fail(new Error("daemon shutting down"));
      connection.close(1001, "daemon shutting down");
    }
    this.connections.clear();
    this.wss?.close();
    this.http?.close();
  }

  private latest(): ExtensionConnection | undefined {
    return Array.from(this.connections.values()).pop();
  }

  private accept(ws: WebSocket, req: IncomingMessage): void {
    if (!req.headers.origin || !this.allowedOrigins.has(req.headers.origin)) {
      ws.close(4003, "origin not allowed");
      return;
    }
    let ready: Promise<ExtensionConnection | null> | null = null;
    const helloTimer = setTimeout(() => {
      if (!ready) ws.close(4001, "hello timeout");
    }, HELLO_TIMEOUT_MS);
    ws.on("message", (data) => {
      let message: ExtToDaemon;
      try {
        message = JSON.parse(String(data)) as ExtToDaemon;
      } catch {
        return;
      }
      if (!ready) {
        if (!("type" in message) || message.type !== "hello" || message.version !== PROTOCOL_VERSION) {
          ws.close(4001, "bad hello");
          return;
        }
        clearTimeout(helloTimer);
        ready = this.register(ws, req, message);
        return;
      }
      void ready.then((connection) => connection && this.dispatch(connection, message));
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      void ready?.then((connection) => {
        if (!connection) return;
        connection.fail(new Error(`${browserLabel(connection.name)} disconnected`));
        if (this.connections.get(connection.name) !== connection) return;
        this.connections.delete(connection.name);
        this.emit("disconnected", connection);
      });
    });
    ws.on("error", () => {});
  }

  private async register(ws: WebSocket, req: IncomingMessage, hello: ExtHello): Promise<ExtensionConnection | null> {
    const name = isExtensionBrowserName(hello.name)
      ? hello.name
      : (await this.identify(req.socket.remotePort).catch(() => null)) ?? nameFromBrands(hello.brands);
    if (ws.readyState !== WebSocket.OPEN) return null;
    const previous = this.connections.get(name);
    if (previous) {
      this.connections.delete(name);
      previous.close(1012, "replaced by newer connection");
    }
    const connection = new ExtensionConnection(name, hello.extensionVersion, ws);
    this.connections.set(name, connection);
    ws.send(JSON.stringify({ type: "welcome", daemon: this.info, browser: name }));
    this.emit("connected", connection, hello);
    return connection;
  }

  private dispatch(connection: ExtensionConnection, message: ExtToDaemon): void {
    if ("type" in message && !("id" in message)) {
      if (message.type === "clear-history") {
        this.emit("clear-history", message.before);
        return;
      }
      if (message.type === "set-default-browser") {
        this.emit("set-default-browser", message.browser);
        return;
      }
      if (message.type === "set-keep-tabs") {
        this.emit("set-keep-tabs", message.keep);
        return;
      }
    }
    connection.handle(message);
  }
}
