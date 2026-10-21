import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExtensionBridge } from "../src/daemon/bridge";
import { runScript } from "../src/daemon/runner";
import { EXTENSION_ID, EXTENSION_ORIGIN } from "../src/shared/protocol";

const enabled = process.env.APART_E2E === "1";
const PORT = 27197;
const extensionDir = path.resolve("dist/extension");

function chromeForTesting(): string | null {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const cache = path.join(os.homedir(), "Library/Caches/ms-playwright");
  if (!existsSync(cache)) return null;
  for (const entry of readdirSync(cache).filter((name) => name.startsWith("chromium-")).sort().reverse()) {
    const candidate = path.join(cache, entry, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function configureExtension(debugPort: number, settings: Record<string, unknown>): Promise<void> {
  let version: { webSocketDebuggerUrl: string } | null = null;
  for (let i = 0; i < 50 && !version; i++) {
    version = await fetch(`http://127.0.0.1:${debugPort}/json/version`).then((r) => r.json(), () => null);
    if (!version) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!version) throw new Error("Chrome DevTools endpoint did not come up");
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  let id = 0;
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => new Promise<any>((resolve, reject) => {
    const msgId = ++id;
    const onMessage = (data: WebSocket.RawData) => {
      const msg = JSON.parse(String(data));
      if (msg.id !== msgId) return;
      ws.off("message", onMessage);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    };
    ws.on("message", onMessage);
    ws.send(JSON.stringify({ id: msgId, method, params, sessionId }));
  });
  const { targetId } = await send("Target.createTarget", { url: `chrome-extension://${EXTENSION_ID}/options.html` });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  for (let i = 0; i < 20; i++) {
    const result = await send("Runtime.evaluate", { expression: `chrome.storage.local.set(${JSON.stringify(settings)}).then(() => true)`, awaitPromise: true, returnByValue: true }, sessionId).catch(() => null);
    if (result?.result?.value === true) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await send("Target.closeTarget", { targetId });
  ws.close();
}

function launch(executable: string, debugPort: number): ChildProcess {
  return spawn(executable, [
    "--headless=new", "--no-first-run", "--no-default-browser-check",
    `--user-data-dir=${mkdtempSync(path.join(os.tmpdir(), "apart-multi-profile-"))}`,
    `--load-extension=${extensionDir}`, `--disable-extensions-except=${extensionDir}`,
    `--remote-debugging-port=${debugPort}`, "about:blank",
  ], { stdio: "ignore" });
}

describe.skipIf(!enabled)("several browsers at once", () => {
  let bridge: ExtensionBridge;
  const browsers: ChildProcess[] = [];

  beforeAll(async () => {
    const executable = chromeForTesting();
    if (!executable) throw new Error("No Chrome for Testing found; set CHROME_PATH");
    bridge = new ExtensionBridge(PORT, EXTENSION_ORIGIN);
    await bridge.listen();
    browsers.push(launch(executable, 9341), launch(executable, 9342), launch(executable, 9343));
    await configureExtension(9341, { port: PORT, browserName: "alpha" });
    await configureExtension(9342, { port: PORT, browserName: "beta" });
    await configureExtension(9343, { port: PORT });
    const connected = await Promise.all([
      bridge.waitForConnection(30000, "alpha"),
      bridge.waitForConnection(30000, "beta"),
      bridge.waitForConnection(30000, "chrome-for-testing"),
    ]);
    if (connected.includes(false)) throw new Error(`Browsers did not all connect: ${JSON.stringify(bridge.browsers())}`);
  }, 90000);

  afterAll(() => {
    bridge?.close();
    for (const child of browsers) child.kill("SIGKILL");
  });

  it("names each browser and runs scripts in the one asked for", async () => {
    expect(bridge.browsers().map((item) => item.name).sort()).toEqual(["alpha", "beta", "chrome-for-testing"]);
    for (const name of ["alpha", "beta"]) {
      const out: string[] = [];
      const result = await runScript({
        bridge: bridge.connection(name)!,
        runDir: mkdtempSync(path.join(os.tmpdir(), "apart-multi-run-")),
        timeoutMs: 30000,
        emit: (text) => out.push(text),
        code: `const pg = await openTab("https://example.com/#${name}"); console.log("TABS=" + (await listBrowserTabs()).filter((tab) => tab.url.endsWith("#${name}")).length + " OTHER=" + (await listBrowserTabs()).filter((tab) => /#(alpha|beta)$/.test(tab.url) && !tab.url.endsWith("#${name}")).length); await closeTab(pg);`,
      });
      expect(result.error).toBeUndefined();
      expect(out).toContain("TABS=1 OTHER=0");
    }
  }, 60000);
});

function repl(home: string, port: number, args: string[]): Promise<{ out: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path.resolve("dist/apart.js"), "repl", ...args, "--port", String(port)], { env: { ...process.env, APART_HOME: home }, timeout: 60000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve({ out: stdout, ms: Date.now() - started });
    });
  });
}

describe.skipIf(!enabled)("the daemon with several browsers", () => {
  const DAEMON_PORT = 27195;
  const home = mkdtempSync(path.join(os.tmpdir(), "apart-multi-home-"));
  const children: ChildProcess[] = [];

  beforeAll(async () => {
    const executable = chromeForTesting();
    if (!executable) throw new Error("No Chrome for Testing found; set CHROME_PATH");
    children.push(spawn(process.execPath, [path.resolve("dist/apart.js"), "daemon", "run", "--port", String(DAEMON_PORT)], { env: { ...process.env, APART_HOME: home }, stdio: "ignore" }));
    children.push(launch(executable, 9345), launch(executable, 9346));
    await configureExtension(9345, { port: DAEMON_PORT, browserName: "alpha" });
    await configureExtension(9346, { port: DAEMON_PORT, browserName: "beta" });
  }, 90000);

  afterAll(() => {
    for (const child of children) child.kill("SIGKILL");
  });

  it("runs scripts in different browsers at the same time", async () => {
    const script = (name: string) => `const pg = await openTab("https://example.com/#${name}"); await sleep(3000); console.log("IN=${name} " + (await listBrowserTabs()).some((tab) => tab.url.endsWith("#${name}"))); await closeTab(pg);`;
    const started = Date.now();
    const [alpha, beta] = await Promise.all([
      repl(home, DAEMON_PORT, ["--browser", "alpha", script("alpha")]),
      repl(home, DAEMON_PORT, ["--browser", "beta", script("beta")]),
    ]);
    const total = Date.now() - started;
    expect(alpha.out).toContain("IN=alpha true");
    expect(beta.out).toContain("IN=beta true");
    expect(total).toBeLessThan(alpha.ms + beta.ms - 2000);
  }, 60000);

  it("explains which browsers are connected when the one asked for is not", async () => {
    const result = await repl(home, DAEMON_PORT, ["--browser", "nope", 'console.log("x")', "--timeout", "2000"]);
    expect(result.out).toMatch(/Nope is not connected\. Connected: (alpha, beta|beta, alpha)\./);
  }, 60000);
});
