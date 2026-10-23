import { spawn } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import readline from "node:readline/promises";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome } from "../daemon/headless";
import { browserLabel, HEADLESS } from "../shared/browsers";
import { isBrowser, readConfig, writeConfig } from "../shared/config";
import { APART_HOME, HEADLESS_PROFILE_DIR, LOG_DIR, SOCKET_PATH } from "../shared/paths";
import { createStyle, extensionsPage, formatUptime, MARK, tilde, type Style } from "./style";
import { DEFAULT_PORT, cleanAgent, cleanPid, type CliMessage, type CliRequest, type DaemonStatus } from "../shared/protocol";

declare const __APART_VERSION__: string;

const VERSION = typeof __APART_VERSION__ === "string" ? __APART_VERSION__ : "dev";
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DIST_DIR = path.dirname(SCRIPT_PATH);
const BUNDLED_EXTENSION_DIR = path.join(DIST_DIR, "extension");
const RUNS_FROM_CHECKOUT = existsSync(path.join(DIST_DIR, "..", ".git"));
const EXTENSION_DIR = RUNS_FROM_CHECKOUT ? BUNDLED_EXTENSION_DIR : path.join(APART_HOME, "extension");
const PACKAGE_NAME = "apart-browser";
const GSTACK_LINK = path.join(os.homedir(), ".local", "bin", "aside");
const DAEMON_START_TIMEOUT_MS = 8000;

function help(style: Style = createStyle()): string {
  const { accent, bold, dim } = style;
  const row = (command: string, text = "") => `  ${accent(command)}${text ? `${" ".repeat(Math.max(2, 27 - command.length))}${text}` : ""}`;
  const option = (flag: string, text: string) => `    ${flag}${" ".repeat(Math.max(2, 25 - flag.length))}${dim(text)}`;
  return [
    `${accent(bold("apart"))} ${dim(VERSION)}`,
    "Drive your signed-in browser from the terminal.",
    "",
    `${accent(MARK.next)} Agents: run ${accent("apart guide")} first. It has the rules.`,
    "",
    bold("Run scripts"),
    row("apart repl '<js>'", "Run a Playwright-style script"),
    option("--file <path>", "Read the script from a file, - for stdin"),
    option("--browser <name>", "chrome, arc, dia, brave, edge or headless"),
    option("--headless, --chrome", "Shortcuts for --browser"),
    option("--agent <name>", "Who owns the tabs this run leaves open"),
    option("--timeout <ms>", "Default 120000, at most 600000"),
    "",
    bold("Set up"),
    row("apart setup", "Choose the default browser, load the extension"),
    row("apart doctor", "Check everything and say what to fix"),
    row("apart extension-path", "Print the extension folder"),
    "",
    bold("Settings"),
    row("apart config", "Show settings"),
    row("apart config default-browser <name>"),
    row("apart config keep-tabs on|off"),
    "",
    bold("Daemon"),
    row("apart daemon status|start|stop|restart"),
    "",
    bold("More"),
    row("apart guide", "How to use apart from a coding agent"),
    `  ${dim("Script API  https://github.com/e6uka/apart#script-api")}`,
    `  ${dim("--json on doctor and daemon status prints JSON for scripts")}`,
  ].join("\n");
}

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

Script globals
  page, tabs, openTab(url, { newTab }), closeTab(page), listBrowserTabs(), attachBrowserTab(targetId),
  attachActiveBrowserTab(), getTabByTargetId(id), snapshot(page, { interactive }) -> { tree, diff },
  annotatedScreenshot(page) -> { base64Image }, page.screenshot({ path, type, quality, fullPage }),
  page.pdf({ path, format }), page.locator(sel) / getByRole / getByLabel / getByText, page.evaluate(fn),
  page.frameLocator(sel), page.frames(), page.setInputFiles(sel, files), page.on("dialog", fn),
  page.waitForEvent("download") -> { path(), saveAs(p) }, page._sendToTarget(method, params),
  fetch(url) (with the page's cookies), fs, path, pwd, Buffer, sleep(ms), console.log(...)
  Relative file paths resolve inside the run directory printed by console.log(pwd).

Full API: https://github.com/e6uka/apart#script-api`;

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

async function manifestVersion(dir: string): Promise<string | null> {
  try {
    return (JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8")) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

async function syncExtension(): Promise<void> {
  if (RUNS_FROM_CHECKOUT) return;
  const bundled = await manifestVersion(BUNDLED_EXTENSION_DIR);
  if (!bundled || bundled === (await manifestVersion(EXTENSION_DIR))) return;
  const temp = `${EXTENSION_DIR}.${process.pid}.tmp`;
  await fs.rm(temp, { recursive: true, force: true });
  await fs.cp(BUNDLED_EXTENSION_DIR, temp, { recursive: true });
  await fs.rm(EXTENSION_DIR, { recursive: true, force: true });
  await fs.rename(temp, EXTENSION_DIR);
}

async function spawnDaemon(port: number): Promise<void> {
  await syncExtension().catch(() => {});
  await fs.mkdir(LOG_DIR, { recursive: true });
  const logFile = openSync(path.join(LOG_DIR, "daemon.log"), "a");
  const child = spawn(process.execPath, [SCRIPT_PATH, "daemon", "run", "--port", String(port)], {
    detached: true,
    stdio: ["ignore", logFile, logFile],
    env: process.env,
  });
  child.unref();
}

async function replaceOutdatedDaemon(): Promise<void> {
  if (VERSION === "dev") return;
  const status = await daemonStatus();
  if (!status || status.version === VERSION || status.running) return;
  let socket: net.Socket;
  try {
    socket = await connectSocket();
  } catch {
    return;
  }
  await talk(socket, { type: "stop", pid: status.pid }, (message) => message.type === "stopping" || message.type === "ok");
  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = await daemonStatus();
    if (!current || current.pid !== status.pid) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  process.stderr.write(`apart: restarted the background daemon (it was running ${status.version ?? "an older version"}, this is ${VERSION})\n`);
}

async function ensureDaemon(port: number): Promise<net.Socket> {
  await replaceOutdatedDaemon();
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
      const style = createStyle();
      process.stdout.write(message.ok ? `${style.ok(`[ok ${(message.elapsedMs / 1000).toFixed(1)}s]`)}\n` : `${style.bad(`[error ${message.error}]`)}\n`);
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
      console.log(`The daemon is already running (pid ${existing.pid}, port ${existing.port}).`);
      return 0;
    }
    await ensureDaemon(port);
    const status = await daemonStatus();
    console.log(status ? `The daemon started (pid ${status.pid}, port ${status.port}).` : "The daemon started.");
    return 0;
  }
  if (action === "stop") {
    let socket: net.Socket;
    try {
      socket = await connectSocket();
    } catch {
      console.log("The daemon is not running.");
      return 0;
    }
    await talk(socket, { type: "stop" }, (message) => message.type === "stopping");
    console.log("The daemon stopped.");
    return 0;
  }
  if (action === "restart") {
    await commandDaemon(["stop"], flags);
    await new Promise((resolve) => setTimeout(resolve, 300));
    return commandDaemon(["start"], flags);
  }
  const status = await daemonStatus();
  if (flags.has("json")) {
    console.log(JSON.stringify(status ? { cli: VERSION, ...status, type: undefined } : { cli: VERSION, running: false }, null, 2));
    return status?.extensionConnected ? 0 : 1;
  }
  const style = createStyle();
  const { bold, dim, ok, bad } = style;
  const label = (text: string) => bold(text.padEnd(11));
  if (!status) {
    console.log(`${bad(MARK.problem)} ${label("Daemon")}not running`);
    console.log(`  ${style.accent(MARK.next)} It starts on the next run, or now with ${style.accent("apart daemon start")}`);
    return 1;
  }
  const outdated = VERSION !== "dev" && status.version !== VERSION ? ` · restarts as ${VERSION} on the next run` : "";
  const daemonDetail = dim(`${status.version ? `${status.version} · ` : ""}pid ${status.pid} · port ${status.port} · up ${formatUptime(status.uptimeMs)}${outdated}`);
  const versions = Array.from(new Set(status.browsers.map((item) => item.version)));
  const browsers = status.browsers.length === 0
    ? dim("none connected")
    : `${status.browsers.map((item) => item.name).join(", ")} ${dim(versions.length === 1 ? `· ${status.browsers.length > 1 ? "all on " : ""}extension ${versions[0]}` : `· ${status.browsers.map((item) => `${item.name} ${item.version}`).join(", ")}`)}`;
  console.log(`${ok(MARK.ok)} ${label("Daemon")}${status.running ? "running a script" : "running"} ${daemonDetail}`);
  console.log(`  ${label("Browsers")}${browsers}`);
  console.log(`  ${label("Default")}${status.defaultBrowser}`);
  console.log(`  ${label("Tabs")}${status.keepTabs ? "stay open when a script ends" : "close when a script ends"}`);
  console.log(`  ${label("Headless")}${status.headlessRunning ? "running" : `idle ${dim("· starts on the next --headless run")}`}`);
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
    console.log(`default-browser  ${config.defaultBrowser}${config.saved ? "" : " (not chosen yet; this is the default)"}`);
    console.log(`keep-tabs        ${config.keepTabs ? "on" : "off"}`);
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

type CheckStatus = "ok" | "problem" | "info";

interface Check {
  status: CheckStatus;
  label: string;
  detail?: string;
  fix?: string[];
}

interface Section {
  name: string;
  note?: string;
  checks: Check[];
}

function highlight(text: string, style: Style, base: (value: string) => string = (value) => value): string {
  return text.split("`").map((part, index) => (index % 2 === 1 ? style.accent(part) : part ? base(part) : part)).join("");
}

function plain(text: string): string {
  return text.replaceAll("`", "");
}

function renderSections(sections: Section[], style: Style): string {
  const width = Math.max(10, ...sections.flatMap((section) => section.checks.map((check) => check.label.length))) + 2;
  const marks: Record<CheckStatus, string> = {
    ok: style.ok(style.bold(MARK.ok)),
    problem: style.bad(style.bold(MARK.problem)),
    info: style.dim(MARK.info),
  };
  const lines: string[] = [];
  for (const section of sections) {
    if (section.checks.length === 0) continue;
    if (lines.length) lines.push("");
    lines.push(section.note ? `${style.bold(section.name)}  ${style.dim(section.note)}` : style.bold(section.name));
    for (const check of section.checks) {
      const detail = check.detail ? highlight(check.detail, style, check.status === "problem" ? undefined : style.dim) : "";
      lines.push(`${marks[check.status]} ${detail ? check.label.padEnd(width) : check.label}${detail}`);
      for (const fix of check.fix ?? []) lines.push(`  ${style.accent(MARK.next)} ${highlight(fix, style)}`);
    }
  }
  return lines.join("\n");
}

function headlessName(executable: string): string {
  const app = executable.match(/([^/]+)\.app\//)?.[1];
  return app ?? tilde(executable);
}

async function commandDoctor(flags: Map<string, string | true>): Promise<number> {
  const port = Number(flags.get("port") ?? DEFAULT_PORT);
  const system: Section = { name: "System", checks: [] };
  const daemon: Section = { name: "Daemon", checks: [] };
  const config = await readConfig();
  const browsers: Section = { name: "Browsers", note: `default: ${browserLabel(config.defaultBrowser)}${config.saved ? "" : " (not chosen yet)"}`, checks: [] };
  const optional: Section = { name: "Optional", checks: [] };
  const sections = [system, daemon, browsers, optional];

  const major = Number(process.versions.node.split(".")[0]);
  system.checks.push(major >= 22
    ? { status: "ok", label: "Node", detail: process.versions.node }
    : { status: "problem", label: "Node", detail: `${process.versions.node}, but apart needs 22 or newer`, fix: ["Install a newer Node from `https://nodejs.org`"] });

  const self = await fs.realpath(SCRIPT_PATH).catch(() => SCRIPT_PATH);
  const built = existsSync(path.join(DIST_DIR, "injected", "snapshot.js")) && existsSync(path.join(BUNDLED_EXTENSION_DIR, "manifest.json"));
  const onPath = await findOnPath("apart");
  const onPathSelf = onPath !== null && (await fs.realpath(onPath).catch(() => null)) === self;
  if (!built) system.checks.push({ status: "problem", label: "apart", detail: `files missing in ${tilde(DIST_DIR)}`, fix: [RUNS_FROM_CHECKOUT ? "`yarn build`" : `\`npm install -g ${PACKAGE_NAME}\``] });
  else if (onPath === null) system.checks.push({ status: "problem", label: "apart", detail: "not on PATH", fix: [`\`npm install -g ${PACKAGE_NAME}\`, or \`yarn global add ${PACKAGE_NAME}\``] });
  else if (onPathSelf) system.checks.push({ status: "ok", label: "apart", detail: `${VERSION}  ${tilde(onPath)}` });
  else system.checks.push({ status: "info", label: "apart", detail: `${VERSION} at ${tilde(self)}; another copy is first on PATH: ${tilde(onPath)}` });

  try {
    await syncExtension();
    system.checks.push({ status: "ok", label: "Extension", detail: tilde(EXTENSION_DIR) });
  } catch (error) {
    system.checks.push({ status: "problem", label: "Extension", detail: `could not copy it to ${tilde(EXTENSION_DIR)}: ${error instanceof Error ? error.message : String(error)}` });
  }

  let status = await daemonStatus();
  if (!status) {
    try {
      (await ensureDaemon(port)).destroy();
      status = await daemonStatus();
    } catch (error) {
      daemon.checks.push({ status: "problem", label: "Daemon", detail: `could not start: ${error instanceof Error ? error.message : String(error)}`, fix: [`See \`${tilde(path.join(LOG_DIR, "daemon.log"))}\``] });
    }
  }
  if (status) {
    daemon.checks.push({ status: "ok", label: "Running", detail: `port ${status.port} · pid ${status.pid} · up ${formatUptime(status.uptimeMs)}` });
    const loadSteps = (browser: string) => [
      `Open \`${extensionsPage(browser)}\` and turn on Developer mode`,
      `Click Load unpacked and choose \`${tilde(EXTENSION_DIR)}\``,
    ];
    for (const item of status.browsers) {
      if (VERSION !== "dev" && item.version !== VERSION) {
        browsers.checks.push({ status: "problem", label: browserLabel(item.name), detail: `extension ${item.version}, but apart is ${VERSION}`, fix: [`Reload apart in \`${extensionsPage(item.name)}\``] });
      } else browsers.checks.push({ status: "ok", label: browserLabel(item.name), detail: `extension ${item.version}` });
    }
    const defaultConnected = config.defaultBrowser === HEADLESS || status.browsers.some((item) => item.name === config.defaultBrowser);
    if (status.browsers.length === 0 && config.defaultBrowser === HEADLESS) {
      browsers.checks.push({ status: "info", label: "Your browsers", detail: "none connected; only needed for --browser runs", fix: loadSteps("chrome") });
    } else if (!defaultConnected) {
      browsers.checks.push({
        status: "problem",
        label: browserLabel(config.defaultBrowser),
        detail: "not connected",
        fix: status.browsers.length === 0
          ? [...loadSteps(config.defaultBrowser), "Keep it open; it connects within a few seconds"]
          : [`Open it with the extension loaded, or use a connected one: \`apart config default-browser ${status.browsers[0].name}\``],
      });
    }
  }
  const headlessChrome = findChrome();
  const findChromeFix = ["Install Google Chrome or Chromium, or set `APART_CHROME` to its path"];
  if (headlessChrome) browsers.checks.push({ status: "ok", label: "Headless", detail: `${headlessName(headlessChrome)}, profile ${tilde(HEADLESS_PROFILE_DIR)}` });
  else browsers.checks.push({ status: config.defaultBrowser === HEADLESS ? "problem" : "info", label: "Headless", detail: "no Chrome found", fix: findChromeFix });

  const gstackTarget = await fs.realpath(GSTACK_LINK).catch(() => null);
  if (gstackTarget === self) optional.checks.push({ status: "ok", label: "gstack", detail: `linked at ${tilde(GSTACK_LINK)}` });
  else if (gstackTarget === null) optional.checks.push({ status: "info", label: "gstack", detail: "not linked   `apart setup --gstack`" });
  else optional.checks.push({ status: "info", label: "gstack", detail: `${tilde(GSTACK_LINK)} belongs to another program` });

  const problems = sections.reduce((sum, section) => sum + section.checks.filter((check) => check.status === "problem").length, 0);
  if (flags.has("json")) {
    const clean = sections.map((section) => ({
      name: section.name,
      ...(section.note ? { note: section.note } : {}),
      checks: section.checks.map((check) => ({ ...check, ...(check.detail ? { detail: plain(check.detail) } : {}), ...(check.fix ? { fix: check.fix.map(plain) } : {}) })),
    }));
    console.log(JSON.stringify({ version: VERSION, ok: problems === 0, problems, sections: clean }, null, 2));
    return problems === 0 ? 0 : 1;
  }
  const style = createStyle();
  console.log(renderSections(sections, style));
  console.log("");
  if (problems === 0) {
    console.log(`${style.ok(style.bold(`${MARK.ok} All good.`))} Try:`);
    console.log(`  ${style.accent(`apart repl 'const pg = await openTab("https://example.com"); console.log(await pg.title()); await closeTab(pg);'`)}`);
    console.log("");
    console.log(agentHint(style));
  } else {
    console.log(`${style.bad(style.bold(`${problems} problem${problems === 1 ? "" : "s"}.`))} Fix ${problems === 1 ? "it" : "them"}, then run ${style.accent("apart doctor")} again.`);
  }
  return problems === 0 ? 0 : 1;
}

function agentHint(style: Style): string {
  return `${style.accent(MARK.next)} To let a coding agent use apart, add this to CLAUDE.md or AGENTS.md:\n  To read or act on a web page, use apart. Run \`apart guide\` first and follow it.`;
}

async function findOnPath(command: string): Promise<string | null> {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try {
      await fs.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

const MAC_APPS: [string, string][] = [
  ["chrome", "/Applications/Google Chrome.app"],
  ["arc", "/Applications/Arc.app"],
  ["dia", "/Applications/Dia.app"],
  ["brave", "/Applications/Brave Browser.app"],
  ["edge", "/Applications/Microsoft Edge.app"],
  ["vivaldi", "/Applications/Vivaldi.app"],
  ["chromium", "/Applications/Chromium.app"],
];

async function askDefaultBrowser(style: Style, current: string | undefined): Promise<string> {
  const found = process.platform === "darwin" ? MAC_APPS.filter(([, app]) => existsSync(app)).map(([name]) => name) : [];
  const choices = [...(found.length ? found : ["chrome"]), HEADLESS];
  if (current && !choices.includes(current)) choices.unshift(current);
  const preferred = Math.max(0, choices.indexOf(current ?? choices[0]));
  const width = Math.max(...choices.map((name) => browserLabel(name).length)) + 3;
  console.log(style.bold("Which browser should runs use by default?"));
  console.log("");
  choices.forEach((name, index) => {
    const detail = name === HEADLESS ? "hidden and signed out, no extension needed" : "signed in as you, and you can watch it work";
    const entry = `${index + 1}  ${browserLabel(name).padEnd(width)}`;
    console.log(index === preferred ? `${style.accent(`❯ ${entry}`)}${style.dim(detail)}` : `  ${entry}${style.dim(detail)}`);
  });
  console.log("");
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = Number((await prompt.question(`Choose 1-${choices.length} ${style.dim(`[${preferred + 1}]`)}: `)).trim() || String(preferred + 1));
    return choices[Number.isInteger(answer) && answer >= 1 && answer <= choices.length ? answer - 1 : preferred];
  } finally {
    prompt.close();
  }
}

type ConnectResult = { name: string; version: string } | "skipped" | "timeout";

async function waitForBrowser(browser: string, port: number, style: Style): Promise<ConnectResult> {
  (await ensureDaemon(port)).destroy();
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const animate = style.color && Boolean(process.stdout.isTTY);
  const message = `Waiting for ${browserLabel(browser)} to connect  ${style.dim("Ctrl+C to skip")}`;
  if (!animate) console.log(message);
  let skipped = false;
  const onInterrupt = () => {
    skipped = true;
  };
  process.on("SIGINT", onInterrupt);
  const deadline = Date.now() + 5 * 60_000;
  let frame = 0;
  try {
    while (!skipped && Date.now() < deadline) {
      const found = (await daemonStatus())?.browsers.find((item) => item.name === browser);
      if (found) return found;
      for (let tick = 0; tick < 10 && !skipped; tick++) {
        if (animate) process.stdout.write(`\r${style.accent(frames[frame++ % frames.length])} ${message}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    return skipped ? "skipped" : "timeout";
  } finally {
    process.off("SIGINT", onInterrupt);
    if (animate) process.stdout.write("\r\x1b[2K");
  }
}

async function linkGstack(): Promise<string> {
  const self = await fs.realpath(SCRIPT_PATH).catch(() => SCRIPT_PATH);
  const current = await fs.readlink(GSTACK_LINK).catch(() => null);
  const exists = current !== null || existsSync(GSTACK_LINK);
  if (exists && !(current ?? "").endsWith(path.join("dist", "apart.js"))) {
    return `skipped ${GSTACK_LINK}: a different program already uses that name (${current ?? "a regular file"})`;
  }
  await fs.mkdir(path.dirname(GSTACK_LINK), { recursive: true });
  await fs.rm(GSTACK_LINK, { force: true });
  await fs.symlink(self, GSTACK_LINK);
  return `linked ${GSTACK_LINK} → ${self} (for gstack's browser skills)`;
}

async function commandSetup(flags: Map<string, string | true>): Promise<number> {
  const style = createStyle();
  const { accent, bold, dim, ok, bad } = style;
  const port = Number(flags.get("port") ?? DEFAULT_PORT);
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  await syncExtension();
  const config = await readConfig();
  let browser = typeof flags.get("browser") === "string" ? (flags.get("browser") as string) : flags.has("headless") ? HEADLESS : undefined;
  if (browser === undefined && interactive) browser = await askDefaultBrowser(style, config.saved ? config.defaultBrowser : undefined);
  if (browser !== undefined) {
    if (!isBrowser(browser)) {
      console.error("--browser must be a browser name such as chrome, arc, dia or headless");
      return 2;
    }
    await writeConfig({ defaultBrowser: browser });
    await notifyConfigChanged();
  }
  const current = browser ?? config.defaultBrowser;
  if (interactive && browser !== undefined) console.log("");
  console.log(`${ok(bold(MARK.ok))} Default browser: ${browserLabel(current)}`);
  if (flags.has("gstack")) {
    const result = await linkGstack();
    console.log(result.startsWith("linked") ? `${ok(bold(MARK.ok))} ${result}` : `${dim(MARK.info)} ${result}`);
  }
  console.log("");

  const steps = (name: string) => [
    `  1  Open ${accent(extensionsPage(name))} and turn on Developer mode`,
    `  2  Click Load unpacked and choose ${accent(tilde(EXTENSION_DIR))}`,
  ];
  if (current === HEADLESS) {
    console.log(bold("To also use your own browsers, load the extension once in each"));
    console.log(steps("chrome").join("\n"));
    console.log(`     ${dim("In Arc use arc://extensions, in Dia dia://extensions")}`);
  } else {
    const connected = (await daemonStatus())?.browsers.find((item) => item.name === current);
    let result: ConnectResult | undefined = connected;
    if (!connected) {
      console.log(bold(`Load the extension in ${browserLabel(current)}, once`));
      console.log(steps(current).join("\n"));
      console.log("");
      if (interactive && !flags.has("no-wait")) result = await waitForBrowser(current, port, style);
    }
    if (result === "skipped") console.log(`${style.color && process.stdout.isTTY ? "" : "\n"}${dim(MARK.info)} Skipped. Run ${accent("apart doctor")} once the extension is loaded.`);
    else if (result === "timeout") console.log(`${bad(bold(MARK.problem))} ${browserLabel(current)} did not connect in 5 minutes. Run ${accent("apart doctor")} to see why.`);
    else if (result && VERSION !== "dev" && result.version !== VERSION) {
      console.log(`${bad(bold(MARK.problem))} ${browserLabel(current)} runs extension ${result.version}, but apart is ${VERSION}`);
      console.log(`  ${accent(MARK.next)} Reload apart in ${accent(extensionsPage(current))}`);
    } else if (result) console.log(`${ok(bold(MARK.ok))} ${browserLabel(current)} connected ${dim(`· extension ${result.version}`)}`);
  }

  console.log("");
  console.log(bold("Next"));
  console.log(`  ${accent("apart doctor")}            ${dim("Check everything")}`);
  if (!flags.has("gstack")) console.log(`  ${accent("apart setup --gstack")}    ${dim("Let gstack's /browse and /scrape use apart")}`);
  console.log("");
  console.log(agentHint(style));
  return 0;
}

async function main(): Promise<number> {
  const { positional, flags } = parseFlags(process.argv.slice(2));
  const command = positional.shift();
  if (flags.has("version") || command === "version") {
    console.log(VERSION);
    return 0;
  }
  if (!command || command === "help" || flags.has("help")) {
    console.log(help());
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
    case "setup":
      return commandSetup(flags);
    case "extension-path":
      await syncExtension();
      console.log(EXTENSION_DIR);
      return 0;
    case "home":
      console.log(APART_HOME);
      return 0;
    default:
      console.error(`Unknown command: ${command}. Run apart --help to see the commands.`);
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
