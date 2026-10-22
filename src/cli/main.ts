import { spawn } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome } from "../daemon/headless";
import { browserLabel, HEADLESS } from "../shared/browsers";
import { isBrowser, readConfig, writeConfig } from "../shared/config";
import { APART_HOME, HEADLESS_PROFILE_DIR, LOG_DIR, SOCKET_PATH } from "../shared/paths";
import { DEFAULT_PORT, allowedExtensionIds, cleanAgent, cleanPid, type CliMessage, type CliRequest, type DaemonStatus } from "../shared/protocol";

declare const __APART_VERSION__: string;

const VERSION = typeof __APART_VERSION__ === "string" ? __APART_VERSION__ : "dev";
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DIST_DIR = path.dirname(SCRIPT_PATH);
const EXTENSION_DIR = path.join(DIST_DIR, "extension");
const DAEMON_START_TIMEOUT_MS = 8000;

const HELP = `apart ${VERSION} — drive your real, signed-in Chrome from the terminal

Agents: run "apart guide" first. It explains the rules of using apart.

Usage:
  apart guide                      How to use apart from a coding agent, and its rules
  apart repl '<javascript>'       Run a Playwright-style script against Chrome (exit code is always 0)
  apart repl --file script.js      Read the script from a file ("-" reads stdin)
  apart repl ... --timeout <ms>    Script time budget (default 120000, max 600000)
  apart repl ... --browser <name>  Use a connected browser (chrome, arc, ...) or headless for this run
  apart repl ... --headless        Same as --browser headless: a hidden Chrome apart starts itself
  apart repl ... --chrome          Same as --browser chrome
  apart repl ... --agent <name>    Name the agent running this script; tabs it leaves open are its own
                                   (default: $APART_AGENT, or the Claude Code session)
  apart config default-browser <name>
                                   Which one repl uses without a flag (also in the extension's settings)
  apart config keep-tabs on|off    Leave tabs in your Chrome open when a script ends
  apart daemon start|stop|status   Manage the background daemon (started on demand by repl)
  apart doctor                     Check Node, the build, the daemon, the extension and the shims
  apart extension-path             Print the unpacked extension directory to load in Chrome
  apart skills list                Lists skills (apart ships none)
  apart exec '<task>'              Not supported: apart has no autonomous agent, use repl

Script globals:
  page, tabs, openTab(url, { newTab }), closeTab(page), listBrowserTabs(), attachBrowserTab(targetId),
  attachActiveBrowserTab(), getTabByTargetId(id), snapshot(page, { interactive }) -> { tree, diff },
  annotatedScreenshot(page) -> { base64Image }, page.screenshot({ path, type, quality, fullPage }),
  page.pdf({ path, format }), page.locator(sel) / getByRole / getByLabel / getByText, page.evaluate(fn),
  page.frameLocator(sel), page.frames(), page.setInputFiles(sel, files), page.on("dialog", fn),
  page.waitForEvent("download") -> { path(), saveAs(p) }, page._sendToTarget(method, params),
  fetch(url) (with the page's cookies), fs, path, pwd, Buffer, sleep(ms), console.log(...)

Relative artifact paths resolve inside the per-run directory printed by console.log(pwd).
Output ends with "[ok <seconds>s]" or "[error <message>]".`;

const GUIDE = `apart guide — how to use apart from a coding agent

apart runs a Playwright-style script in the user's real, signed-in browser (or a hidden
headless one) and prints what happened. Run it as a shell command:

  apart repl '<javascript>'             or   apart repl --file script.js

The last line is always "[ok <seconds>s]" or "[error <message>]"; the exit code is always 0.

Every run
  - Is a fresh session. Variables and handles do not carry over to the next run.
  - Opens tabs with openTab(url) and reads them with snapshot(pg, { interactive: true }),
    which prints the page with refs like [ref=e12] you can click or fill:
      const pg = await openTab("https://example.com");
      console.log((await snapshot(pg, { interactive: true })).tree);
      await pg.locator("e12").click();
      await closeTab(pg);
  - Closes its tabs when it ends, unless the user turned keep-tabs on (headless tabs
    always close).
  - Has a 120 s budget by default (--timeout <ms>, up to 600000).
  - Writes files only inside its run directory (console.log(pwd) prints it).

Tabs belong to agents
  - Each run belongs to an agent: --agent <name>, else $APART_AGENT, else the Claude Code
    session. Inside Claude Code, an --agent name is scoped to the session, so two sessions
    using the same name stay apart. $APART_AGENT is shared: every session with the same
    value is the same agent, which lets one session hand its tabs to the next. Tabs a run
    leaves open belong to that agent.
  - openTab does not reuse another agent's tab, and attachBrowserTab or
    attachActiveBrowserTab refuse it with an error naming the owner. Do not work around
    that error; open your own tab instead.
  - listBrowserTabs() shows the owner of a kept tab as "agent".
  - When apart knows the agent's process ($APART_AGENT_PID, or the Claude Code process
    for names that are not shared), its tabs are freed for others after that process
    ends. Otherwise they stay its own until the tab closes or the browser restarts.
  - Subagents share their parent session. If you are a subagent, or one of several agents
    in the same session, pass your own name on every run: --agent <short-task-name>.
  - Ownership needs the browser extension to match this version of apart. If apart doctor
    says the extension is older, tell the user to reload it.

Choosing the browser
  - Without a flag, runs use the user's default browser. --headless runs signed out in a
    hidden Chrome; --browser <name> picks a connected one (chrome, arc, ...).
  - Use the user's browser only for pages that need their sign-in. Do not submit forms,
    send messages, buy or delete anything there unless the user asked for it.

When something fails
  - "[error ... is not connected]": the extension is not reachable. Tell the user; run
    apart doctor for the steps. Do not silently switch to headless for signed-in pages.
  - A click that "would land on" something else means an overlay is in the way: take a
    new snapshot and deal with it, or click({ force: true }) if you are sure.

Full API: apart --help, or https://github.com/e6uka/apart#script-api`;

function guide(): string {
  const { agent } = detectAgent();
  return `${GUIDE}\n\nIn this shell, runs belong to: ${agent ? `agent "${agent}"` : "no agent (pass --agent <name> to keep your tabs to yourself)"}`;
}

function parseFlags(args: string[]): { positional: string[]; flags: Map<string, string | true> } {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const [name, inline] = arg.slice(2).split("=", 2);
      if (inline !== undefined) flags.set(name, inline);
      else if (["file", "timeout", "port", "browser", "agent"].includes(name) && i + 1 < args.length) flags.set(name, args[++i]);
      else flags.set(name, true);
    } else positional.push(arg);
  }
  return { positional, flags };
}

function connectSocket(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(SOCKET_PATH);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function spawnDaemon(port: number): Promise<void> {
  await fs.mkdir(LOG_DIR, { recursive: true });
  const logFile = openSync(path.join(LOG_DIR, "daemon.log"), "a");
  const child = spawn(process.execPath, [SCRIPT_PATH, "daemon", "run", "--port", String(port)], {
    detached: true,
    stdio: ["ignore", logFile, logFile],
    env: process.env,
  });
  child.unref();
}

async function ensureDaemon(port: number): Promise<net.Socket> {
  try {
    return await connectSocket();
  } catch {
    await spawnDaemon(port);
  }
  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await connectSocket();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  const logPath = path.join(LOG_DIR, "daemon.log");
  const lastLine = (await fs.readFile(logPath, "utf8").catch(() => "")).trim().split("\n").pop() ?? "";
  const failure = lastLine.match(/startup failed: (.*)$/)?.[1];
  if (failure) throw new Error(`the daemon could not start: ${failure}`);
  throw new Error(`daemon did not start within ${DAEMON_START_TIMEOUT_MS / 1000}s (${lastError instanceof Error ? lastError.message : String(lastError)}); see ${logPath}`);
}

function talk(socket: net.Socket, request: CliRequest, onMessage: (message: CliMessage) => boolean | void): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;
        if (onMessage(JSON.parse(line) as CliMessage) === true) {
          socket.end();
          resolve();
          return;
        }
      }
    });
    socket.on("error", reject);
    socket.on("close", () => resolve());
    socket.write(`${JSON.stringify(request)}\n`);
  });
}

async function daemonStatus(): Promise<DaemonStatus | null> {
  let socket: net.Socket;
  try {
    socket = await connectSocket();
  } catch {
    return null;
  }
  let status: DaemonStatus | null = null;
  await talk(socket, { type: "status" }, (message) => {
    if (message.type === "status") {
      status = message;
      return true;
    }
  });
  return status;
}

function detectAgent(env: NodeJS.ProcessEnv = process.env, flag?: string): { agent?: string; agentPid?: number } {
  const session = cleanAgent(env.CLAUDE_CODE_SESSION_ID);
  const claude = session ? `claude-${session}` : undefined;
  const claudePid = claude ? cleanPid(env.CLAUDE_PID) : undefined;
  const ownPid = cleanPid(env.APART_AGENT_PID);
  if (flag) return claude ? { agent: cleanAgent(`${claude}:${flag}`), agentPid: ownPid ?? claudePid } : { agent: flag, agentPid: ownPid };
  const shared = cleanAgent(env.APART_AGENT);
  if (shared) return { agent: shared, agentPid: ownPid };
  return claude ? { agent: claude, agentPid: ownPid ?? claudePid } : {};
}

async function commandRepl(positional: string[], flags: Map<string, string | true>): Promise<void> {
  const port = Number(flags.get("port") ?? DEFAULT_PORT);
  const file = flags.get("file");
  let code: string | undefined;
  if (typeof file === "string") code = file === "-" ? await readStdin() : await fs.readFile(file, "utf8");
  else if (positional.length > 0) code = positional.join(" ");
  else if (!process.stdin.isTTY) code = await readStdin();
  if (!code || !code.trim()) {
    console.log("[error no script given: apart repl '<javascript>' or apart repl --file script.js]");
    return;
  }
  const timeoutMs = flags.has("timeout") ? Number(flags.get("timeout")) : undefined;
  let socket: net.Socket;
  try {
    socket = await ensureDaemon(port);
  } catch (error) {
    console.log(`[error ${error instanceof Error ? error.message : String(error)}]`);
    return;
  }
  const chosen = flags.get("browser");
  if (chosen !== undefined && !isBrowser(chosen)) {
    console.log("[error --browser needs a browser name, such as chrome, arc or headless]");
    return;
  }
  const browser = typeof chosen === "string" ? chosen : flags.has("headless") ? HEADLESS : flags.has("chrome") ? "chrome" : undefined;
  const named = flags.get("agent");
  if (flags.has("agent") && !cleanAgent(named)) {
    console.log("[error --agent needs a name, such as --agent research]");
    return;
  }
  const { agent, agentPid } = detectAgent(process.env, cleanAgent(named));
  await talk(socket, { type: "run", code, timeoutMs, browser, ...(agent ? { agent } : {}), ...(agentPid ? { agentPid } : {}) }, (message) => {
    if (message.type === "out") process.stdout.write(`${message.text}\n`);
    else if (message.type === "done") {
      process.stdout.write(message.ok ? `[ok ${(message.elapsedMs / 1000).toFixed(1)}s]\n` : `[error ${message.error}]\n`);
      return true;
    }
  });
}

async function commandDaemon(positional: string[], flags: Map<string, string | true>): Promise<number> {
  const port = Number(flags.get("port") ?? DEFAULT_PORT);
  const action = positional[0] ?? "status";
  if (action === "run") {
    const { runDaemon } = await import("../daemon/index");
    await runDaemon({ port, version: VERSION });
    return new Promise<number>(() => undefined);
  }
  if (action === "start") {
    const existing = await daemonStatus();
    if (existing) {
      console.log(`daemon already running (pid ${existing.pid}, port ${existing.port})`);
      return 0;
    }
    await ensureDaemon(port);
    const status = await daemonStatus();
    console.log(status ? `daemon started (pid ${status.pid}, port ${status.port})` : "daemon started");
    return 0;
  }
  if (action === "stop") {
    let socket: net.Socket;
    try {
      socket = await connectSocket();
    } catch {
      console.log("daemon is not running");
      return 0;
    }
    await talk(socket, { type: "stop" }, (message) => message.type === "stopping");
    console.log("daemon stopped");
    return 0;
  }
  if (action === "restart") {
    await commandDaemon(["stop"], flags);
    await new Promise((resolve) => setTimeout(resolve, 300));
    return commandDaemon(["start"], flags);
  }
  const status = await daemonStatus();
  if (!status) {
    console.log("daemon: not running");
    return 1;
  }
  console.log(`daemon: running (pid ${status.pid}, port ${status.port}, up ${Math.round(status.uptimeMs / 1000)}s${status.running ? ", script running" : ""})`);
  console.log(`browsers: ${status.browsers.length ? status.browsers.map((item) => `${item.name} (extension ${item.version})`).join(", ") : "none connected"}`);
  console.log(`default browser: ${status.defaultBrowser}`);
  console.log(`tabs at script end: ${status.keepTabs ? "left open" : "closed"}`);
  console.log(`headless chrome: ${status.headlessRunning ? "running" : "not running (starts on the next --headless run)"}`);
  return status.extensionConnected ? 0 : 1;
}

async function notifyConfigChanged(): Promise<void> {
  await connectSocket()
    .then((socket) => talk(socket, { type: "config-changed" }, (message) => message.type === "ok"))
    .catch(() => undefined);
}

async function commandConfig(positional: string[]): Promise<number> {
  const [key, value] = positional;
  const config = await readConfig();
  if (!key) {
    console.log(`default-browser ${config.defaultBrowser}${config.saved ? "" : " (not chosen yet; this is the default)"}`);
    console.log(`keep-tabs ${config.keepTabs ? "on" : "off"}`);
    return 0;
  }
  if (key === "default-browser") {
    if (value === undefined) {
      console.log(config.defaultBrowser);
      return 0;
    }
    if (!isBrowser(value)) {
      console.error("default-browser must be a browser name such as chrome, arc or headless (see apart daemon status)");
      return 2;
    }
    await writeConfig({ defaultBrowser: value });
    await notifyConfigChanged();
    console.log(value === HEADLESS
      ? "apart repl now uses headless Chrome by default. Add --browser <name> to use one of your browsers for one run."
      : `apart repl now uses ${browserLabel(value)} by default. Add --headless or --browser <name> to use another for one run.`);
    return 0;
  }
  if (key === "keep-tabs") {
    if (value === undefined) {
      console.log(config.keepTabs ? "on" : "off");
      return 0;
    }
    if (value !== "on" && value !== "off") {
      console.error("keep-tabs must be on or off");
      return 2;
    }
    await writeConfig({ keepTabs: value === "on" });
    await notifyConfigChanged();
    console.log(value === "on"
      ? "Tabs a script opens in your Chrome now stay open when it ends. closeTab() in a script still closes them; headless tabs always close."
      : "Tabs a script opens now close when it ends.");
    return 0;
  }
  console.error(`Unknown setting: ${key}. Settings: default-browser, keep-tabs`);
  return 2;
}

async function commandDoctor(flags: Map<string, string | true>): Promise<number> {
  const port = Number(flags.get("port") ?? DEFAULT_PORT);
  const lines: string[] = [];
  let problems = 0;
  const check = (ok: boolean, label: string, fix?: string) => {
    lines.push(`${ok ? "ok      " : "problem "} ${label}${!ok && fix ? `\n         → ${fix}` : ""}`);
    if (!ok) problems++;
  };
  const major = Number(process.versions.node.split(".")[0]);
  check(major >= 22, `node ${process.versions.node}`, "install Node 22 or newer");
  check(existsSync(path.join(DIST_DIR, "injected", "snapshot.js")) && existsSync(path.join(EXTENSION_DIR, "manifest.json")), `build at ${DIST_DIR}`, "run `yarn build`");
  const binDir = path.join(os.homedir(), ".local", "bin");
  const self = await fs.realpath(SCRIPT_PATH).catch(() => SCRIPT_PATH);
  const apartLink = path.join(binDir, "apart");
  check((await fs.realpath(apartLink).catch(() => null)) === self, `${apartLink} → this build`, "run ./install.sh");
  const gstackLink = path.join(binDir, "aside");
  const gstackTarget = await fs.realpath(gstackLink).catch(() => null);
  if (gstackTarget === self) lines.push(`ok       ${gstackLink} → this build (gstack browser skills)`);
  else if (gstackTarget === null) lines.push(`info     gstack link not installed (optional: ./install.sh --gstack)`);
  else lines.push(`info     ${gstackLink} belongs to another program, so gstack will not use apart`);
  if (!(process.env.PATH ?? "").split(path.delimiter).includes(binDir)) {
    lines.push(`info     ${binDir} is not on PATH; call ${apartLink} directly or add the directory to PATH`);
  }
  const chrome = ["/Applications/Google Chrome.app", "/Applications/Chromium.app", "/Applications/Google Chrome Canary.app"].find((app) => existsSync(app));
  check(Boolean(chrome) || process.platform !== "darwin", chrome ? `Chrome at ${chrome}` : "Chrome installed", "install Google Chrome or Chromium");
  const config = await readConfig();
  lines.push(`info     default browser: ${config.defaultBrowser}${config.saved ? "" : " (not chosen yet)"}; change with apart config default-browser <name>`);
  const headlessChrome = findChrome();
  if (headlessChrome) lines.push(`ok       headless runs use ${headlessChrome} (profile ${HEADLESS_PROFILE_DIR})`);
  else if (config.defaultBrowser === "headless") check(false, "Chrome for headless runs", "install Google Chrome or Chromium, or set APART_CHROME to its executable");
  else lines.push(`info     no Chrome found for --headless runs; set APART_CHROME to a Chrome or Chromium executable`);
  let status = await daemonStatus();
  if (!status) {
    try {
      await ensureDaemon(port);
      status = await daemonStatus();
    } catch (error) {
      lines.push(`problem  daemon could not start: ${error instanceof Error ? error.message : String(error)}`);
      problems++;
    }
  }
  if (status) {
    check(true, `daemon running (pid ${status.pid}, port ${status.port})`);
    const loadExtension = `in Chrome or Arc open chrome://extensions, turn on Developer mode, click "Load unpacked" and choose:\n           ${EXTENSION_DIR}\n           (accepted extension ids: ${allowedExtensionIds().join(", ")}); it connects within a few seconds`;
    for (const item of status.browsers) {
      if (VERSION !== "dev" && item.version !== VERSION) {
        check(false, `${browserLabel(item.name)} runs extension ${item.version}, but apart is ${VERSION}`, `reload the extension in ${browserLabel(item.name)}: open chrome://extensions (in Arc: arc://extensions) and click the reload icon on apart. Until then it ignores which agent owns a tab.`);
      } else lines.push(`ok       ${browserLabel(item.name)} connected as "${item.name}" (extension ${item.version})`);
    }
    const defaultConnected = config.defaultBrowser === HEADLESS || status.browsers.some((item) => item.name === config.defaultBrowser);
    if (status.browsers.length === 0 && config.defaultBrowser === HEADLESS) lines.push(`info     no browser connected; only needed for --browser runs\n         → ${loadExtension}`);
    else if (status.browsers.length === 0) check(false, "no browser connected", loadExtension);
    else if (!defaultConnected) check(false, `the default browser, ${config.defaultBrowser}, is not connected`, `open it with the extension loaded, or pick a connected one: apart config default-browser ${status.browsers[0].name}`);
  }
  console.log(lines.join("\n"));
  console.log(problems === 0
    ? "\nAll good. Try: apart repl 'const pg = await openTab(\"https://example.com\"); console.log(await pg.title()); await closeTab(pg);'\n\nTo let a coding agent use apart, add this line to your CLAUDE.md or AGENTS.md:\n  To read or act on a web page, use apart. Run `apart guide` first and follow it."
    : `\n${problems} problem${problems === 1 ? "" : "s"} found.`);
  return problems === 0 ? 0 : 1;
}

async function main(): Promise<number> {
  const { positional, flags } = parseFlags(process.argv.slice(2));
  const command = positional.shift();
  if (flags.has("version") || command === "version") {
    console.log(VERSION);
    return 0;
  }
  if (!command || command === "help" || flags.has("help")) {
    console.log(HELP);
    return 0;
  }
  switch (command) {
    case "repl":
      await commandRepl(positional, flags);
      return 0;
    case "exec":
      console.log("[error apart has no autonomous agent; write the steps with `apart repl` instead]");
      return 0;
    case "skills":
      console.log("No skills are installed. apart has no skill runtime; drive pages with `apart repl`.");
      return 0;
    case "daemon":
      return commandDaemon(positional, flags);
    case "doctor":
      return commandDoctor(flags);
    case "config":
      return commandConfig(positional);
    case "guide":
      console.log(guide());
      return 0;
    case "extension-path":
      console.log(EXTENSION_DIR);
      return 0;
    case "home":
      console.log(APART_HOME);
      return 0;
    default:
      console.error(`Unknown command: ${command}\n\n${HELP}`);
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
