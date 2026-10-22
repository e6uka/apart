import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { BrowserBackend } from "./backend";
import { ExtensionBridge, type ExtensionConnection } from "./bridge";
import { HeadlessBrowser } from "./headless";
import { RunHistory } from "./history";
import { runScript } from "./runner";
import { browserLabel } from "../shared/browsers";
import { isBrowser, isHeadless, readConfig, writeConfig } from "../shared/config";
import { APART_HOME, HEADLESS_PROFILE_DIR, HISTORY_PATH, LOG_DIR, PID_PATH, RUNS_DIR, SOCKET_DIR, SOCKET_PATH } from "../shared/paths";
import { allowedExtensionOrigins, cleanAgent, type CliMessage, type CliRequest, type DaemonStatus, type ExtHello, type RunRecord } from "../shared/protocol";

const EXTENSION_WAIT_MS = 20000;
const DEFAULT_SCRIPT_TIMEOUT_MS = 120000;
const MAX_SCRIPT_TIMEOUT_MS = 10 * 60 * 1000;
const KEEP_RUNS = 50;

function log(message: string): void {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

function socketIsLive(): Promise<boolean> {
  return new Promise((resolve) => {
    const client = net.connect(SOCKET_PATH);
    client.once("connect", () => {
      client.end();
      resolve(true);
    });
    client.once("error", () => resolve(false));
  });
}

async function pruneRuns(): Promise<void> {
  const entries = await fs.readdir(RUNS_DIR).catch(() => [] as string[]);
  const stale = entries.sort().slice(0, Math.max(0, entries.length - KEEP_RUNS));
  await Promise.allSettled(stale.map((name) => fs.rm(path.join(RUNS_DIR, name), { recursive: true, force: true })));
}

async function prepareSocketDir(): Promise<void> {
  await fs.mkdir(SOCKET_DIR, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(SOCKET_DIR);
  const uid = process.getuid?.();
  if (!info.isDirectory() || (uid !== undefined && info.uid !== uid) || (info.mode & 0o077) !== 0) {
    throw new Error(`${SOCKET_DIR} must be a directory owned by you with mode 0700`);
  }
}

function write(socket: net.Socket, message: CliMessage): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}

export async function runDaemon(options: { port: number; version: string }): Promise<void> {
  const startedAt = Date.now();
  await fs.mkdir(APART_HOME, { recursive: true, mode: 0o700 });
  await fs.mkdir(LOG_DIR, { recursive: true });
  await fs.mkdir(RUNS_DIR, { recursive: true });
  await fs.chmod(APART_HOME, 0o700);
  await prepareSocketDir();
  if (await socketIsLive()) {
    log("another daemon already owns the socket; exiting");
    return;
  }
  await fs.rm(SOCKET_PATH, { force: true });

  const bridge = new ExtensionBridge(options.port, allowedExtensionOrigins(), { version: options.version, pid: process.pid, port: options.port });
  const history = new RunHistory(HISTORY_PATH);
  let config = await readConfig();
  const headless = new HeadlessBrowser({ profileDir: HEADLESS_PROFILE_DIR, log });
  const configMessage = () => ({ type: "config" as const, defaultBrowser: config.defaultBrowser, keepTabs: config.keepTabs, browsers: bridge.browsers().map((item) => item.name) });
  const announceConfig = async (): Promise<void> => {
    config = await readConfig();
    bridge.notify(configMessage());
  };
  bridge.on("connected", (connection: ExtensionConnection, hello: ExtHello) => {
    log(`${browserLabel(connection.name)} connected (extension ${connection.version})`);
    void (async () => {
      await announceConfig();
      if (typeof hello.historyClearedAt === "number") await history.clearBefore(hello.historyClearedAt);
      connection.send({ type: "history", runs: await history.list() });
    })().catch((error) => log(`could not send run history: ${error instanceof Error ? error.message : String(error)}`));
  });
  bridge.on("disconnected", (connection: ExtensionConnection) => {
    log(`${browserLabel(connection.name)} disconnected`);
    bridge.notify(configMessage());
  });
  bridge.on("set-keep-tabs", (keep: unknown) => {
    if (typeof keep !== "boolean") return;
    void writeConfig({ keepTabs: keep })
      .then(announceConfig)
      .then(() => log(`keep tabs open set to ${keep} from the extension`))
      .catch((error) => log(`could not save the tab setting: ${error instanceof Error ? error.message : String(error)}`));
  });
  bridge.on("set-default-browser", (browser: unknown) => {
    if (!isBrowser(browser)) return;
    void writeConfig({ defaultBrowser: browser })
      .then(announceConfig)
      .then(() => log(`default browser set to ${browser} from the extension`))
      .catch((error) => log(`could not save the default browser: ${error instanceof Error ? error.message : String(error)}`));
  });
  bridge.on("clear-history", (before: number) => {
    void history.clearBefore(before).then(() => log("run history cleared from the extension"), () => undefined);
  });
  try {
    await bridge.listen();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const reason = code === "EADDRINUSE"
      ? `port ${options.port} is already in use, by another apart daemon or another program; stop it or start this one with --port <number>`
      : `could not listen on port ${options.port}: ${error instanceof Error ? error.message : String(error)}`;
    log(`startup failed: ${reason}`);
    process.exit(1);
  }
  log(`listening for the extension on ws://127.0.0.1:${options.port}/ext`);

  let admission: Promise<void> = Promise.resolve();
  const queues = new Map<string, Promise<void>>();
  let running = 0;

  const status = (): DaemonStatus => ({
    type: "status",
    pid: process.pid,
    port: options.port,
    uptimeMs: Date.now() - startedAt,
    extensionConnected: bridge.connected,
    extensionVersion: bridge.extensionVersion,
    browsers: bridge.browsers(),
    running: running > 0,
    headlessRunning: headless.connected,
    defaultBrowser: config.defaultBrowser,
    keepTabs: config.keepTabs,
  });

  const handleRun = async (socket: net.Socket, request: Extract<CliRequest, { type: "run" }>, browser: string): Promise<void> => {
    const runDir = path.join(RUNS_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`);
    await fs.mkdir(runDir, { recursive: true });
    config = await readConfig();
    let backend: BrowserBackend;
    let target: ExtensionConnection | undefined;
    if (isHeadless(browser)) {
      try {
        await headless.acquire();
      } catch (error) {
        write(socket, { type: "done", ok: false, error: error instanceof Error ? error.message : String(error), elapsedMs: 0, runDir });
        return;
      }
      backend = headless;
    } else {
      target = (await bridge.waitForConnection(EXTENSION_WAIT_MS, browser)) ? bridge.connection(browser) : undefined;
      if (!target) {
        const others = bridge.browsers().map((item) => item.name);
        const hint = others.length
          ? ` Connected: ${others.join(", ")}. Run with --browser ${others[0]}, or make it the default with apart config default-browser ${others[0]}.`
          : " Load dist/extension in it and keep it open (`apart doctor` explains the steps), or run with --headless.";
        write(socket, { type: "done", ok: false, error: `${browserLabel(browser)} is not connected.${hint}`, elapsedMs: 0, runDir });
        return;
      }
      backend = target;
    }
    running += 1;
    const runId = path.basename(runDir);
    const startedAt = Date.now();
    target?.send({ type: "run-started", run: { id: runId, startedAt } });
    const timeoutMs = Math.min(Math.max(request.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS, 1000), MAX_SCRIPT_TIMEOUT_MS);
    log(`${browser} run started (${request.code.length} chars, ${timeoutMs}ms budget) in ${runDir}`);
    try {
      const result = await runScript({
        code: request.code,
        runDir,
        timeoutMs,
        bridge: backend,
        keepTabs: Boolean(target) && config.keepTabs,
        agent: cleanAgent(request.agent),
        emit: (text) => write(socket, { type: "out", text }),
      });
      write(socket, { type: "done", ok: result.ok, error: result.error, elapsedMs: result.elapsedMs, runDir });
      const trivial = result.ok && result.urls.length === 0 && result.tabsOpened === 0;
      if (!trivial) {
        const record: RunRecord = { id: runId, browser, startedAt, elapsedMs: result.elapsedMs, ok: result.ok, error: result.error, urls: result.urls, tabsOpened: result.tabsOpened };
        await history.add(record).catch((error) => log(`could not save run history: ${error instanceof Error ? error.message : String(error)}`));
        bridge.notify({ type: "run-finished", run: record });
      } else target?.send({ type: "run-ended", id: runId });
      log(`run finished ok=${result.ok} in ${result.elapsedMs}ms${result.error ? `: ${result.error}` : ""}`);
    } finally {
      running -= 1;
      if (isHeadless(browser)) headless.release();
      void pruneRuns();
    }
  };

  const shutdown = async (): Promise<void> => {
    log("shutting down");
    bridge.close();
    await headless.close().catch(() => undefined);
    server.close();
    await fs.rm(SOCKET_PATH, { force: true });
    await fs.rm(PID_PATH, { force: true });
    process.exit(0);
  };

  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line.trim()) continue;
        let request: CliRequest;
        try {
          request = JSON.parse(line) as CliRequest;
        } catch {
          socket.destroy();
          return;
        }
        if (request.type === "status") write(socket, status());
        else if (request.type === "config-changed") {
          void announceConfig().then(() => write(socket, { type: "ok" }), () => write(socket, { type: "ok" }));
        }
        else if (request.type === "stop") {
          write(socket, { type: "stopping" });
          socket.end();
          void shutdown();
        } else if (request.type === "run") {
          admission = admission.then(async () => {
            const browser = isBrowser(request.browser) ? request.browser : (await readConfig()).defaultBrowser;
            const next = (queues.get(browser) ?? Promise.resolve())
              .then(() => handleRun(socket, request, browser))
              .catch((error) => {
                write(socket, { type: "done", ok: false, error: error instanceof Error ? error.message : String(error), elapsedMs: 0, runDir: "" });
              });
            queues.set(browser, next);
            void next.then(() => {
              if (queues.get(browser) === next) queues.delete(browser);
            });
          });
        }
      }
    });
    socket.on("error", () => undefined);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(SOCKET_PATH, () => resolve());
  });
  await fs.chmod(SOCKET_PATH, 0o600);
  await fs.writeFile(PID_PATH, String(process.pid));
  log(`accepting CLI connections on ${SOCKET_PATH}`);

  process.on("exit", () => headless.kill());
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  void pruneRuns();
}
