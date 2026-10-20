import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExtensionBridge } from "../src/daemon/bridge";
import { runScript } from "../src/daemon/runner";
import WebSocket from "ws";
import { EXTENSION_ID, EXTENSION_ORIGIN } from "../src/shared/protocol";

const TEST_PORT = Number(process.env.APART_E2E_PORT ?? 27199);
const DEBUG_PORT = Number(process.env.APART_E2E_DEBUG_PORT ?? 9339);

async function pointExtensionAtTestPort(): Promise<void> {
  let version: { webSocketDebuggerUrl: string } | null = null;
  for (let i = 0; i < 50 && !version; i++) {
    version = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`).then((r) => r.json(), () => null);
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
    const result = await send("Runtime.evaluate", { expression: `chrome.storage.local.set({ port: ${TEST_PORT} }).then(() => true)`, awaitPromise: true, returnByValue: true }, sessionId).catch(() => null);
    if (result?.result?.value === true) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await send("Target.closeTarget", { targetId });
  ws.close();
}

const enabled = process.env.APART_E2E === "1";
const extensionDir = path.resolve("dist/extension");

function findChrome(): string | null {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const cache = path.join(os.homedir(), "Library/Caches/ms-playwright");
  if (existsSync(cache)) {
    for (const entry of readdirSync(cache).filter((name) => name.startsWith("chromium-")).sort().reverse()) {
      const candidate = path.join(cache, entry, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
      if (existsSync(candidate)) return candidate;
    }
  }
  const system = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return existsSync(system) ? system : null;
}

const PAGE_HTML = `
<!doctype html><title>apart e2e</title>
<h1>Hello apart</h1>
<nav><a href="#about">About</a></nav>
<form onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'sent:' + document.getElementById('email').value">
  <label>Email <input id="email" type="email" placeholder="you@example.com"></label>
  <label><input id="agree" type="checkbox"> I agree</label>
  <button id="go">Send</button>
</form>
<p id="out">waiting</p>
`;

describe.skipIf(!enabled)("end to end against Chrome", () => {
  let bridge: ExtensionBridge;
  let chrome: ChildProcess | null = null;
  let server: Server;
  let pageUrl = "";

  beforeAll(async () => {
    const chromePath = findChrome();
    if (!chromePath) throw new Error("No Chrome found; set CHROME_PATH");
    if (!existsSync(path.join(extensionDir, "manifest.json"))) throw new Error("Run `yarn build` first");
    server = createServer((_req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(PAGE_HTML);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    pageUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`;
    bridge = new ExtensionBridge(TEST_PORT, EXTENSION_ORIGIN);
    await bridge.listen();
    const profile = mkdtempSync(path.join(os.tmpdir(), "apart-e2e-profile-"));
    chrome = spawn(chromePath, [
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profile}`,
      `--load-extension=${extensionDir}`,
      `--disable-extensions-except=${extensionDir}`,
      "--window-size=1200,800",
      `--remote-debugging-port=${DEBUG_PORT}`,
      "about:blank",
    ], { stdio: "ignore" });
    await pointExtensionAtTestPort();
    const connected = await bridge.waitForConnection(30000);
    if (!connected) throw new Error("Extension did not connect to the test daemon");
  }, 60000);

  afterAll(async () => {
    bridge?.close();
    server?.close();
    chrome?.kill("SIGKILL");
  });

  it("drives a page: snapshot, fill, click, evaluate, screenshot", async () => {
    const out: string[] = [];
    const runDir = mkdtempSync(path.join(os.tmpdir(), "apart-e2e-run-"));
    const result = await runScript({
      bridge,
      runDir,
      timeoutMs: 60000,
      emit: (text) => {
        out.push(text);
        if (process.env.APART_E2E_VERBOSE === "1") process.stderr.write(`  | ${text}\n`);
      },
      code: `
        const pg = await openTab(${JSON.stringify(pageUrl)});
        console.log("TITLE=" + await pg.title());
        const s = await snapshot(pg, { interactive: true });
        console.log(s.tree);
        await pg.fill("#email", "qa@example.com");
        await pg.getByLabel("I agree").check();
        await pg.waitForURL(/127\.0\.0\.1/);
        console.log("ROLE_REGEX=" + await pg.getByRole("button", { name: /^send$/i }).count());
        await pg.getByRole("button", { name: "Send" }).click();
        await pg.waitForFunction(() => document.getElementById("out").textContent.startsWith("sent:"));
        console.log("OUT=" + await pg.locator("#out").innerText());
        console.log("CHECKED=" + await pg.locator("#agree").isChecked());
        const after = await snapshot(pg, { interactive: true });
        console.log("DIFF_START"); console.log(after.diff); console.log("DIFF_END");
        await pg.screenshot({ path: "shot.jpg", type: "jpeg", quality: 60 });
        const a = await annotatedScreenshot(pg);
        console.log("ANNOTATED=" + (a.base64Image.length > 1000));
        console.log("FILES=" + (await fs.readdir(".")).sort().join(","));
        await closeTab(pg);
        console.log("DONE");
      `,
    });
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    const text = out.join("\n");
    expect(text).toContain("TITLE=apart e2e");
    expect(text).toMatch(/- textbox "Email".*\[ref=e\d+\]/);
    expect(text).toMatch(/- button "Send".*\[ref=e\d+\]/);
    expect(text).toContain("OUT=sent:qa@example.com");
    expect(text).toContain("CHECKED=true");
    expect(text).toContain("ROLE_REGEX=1");
    expect(text).toMatch(/\+\s+- textbox "Email" \[value="qa@example.com"\]/);
    expect(text).toContain("ANNOTATED=true");
    expect(text).toContain("FILES=shot.jpg");
    expect(text).toContain("DONE");
    expect((await bridge.listTabs()).some((tab) => tab.url.startsWith(pageUrl))).toBe(false);
  }, 60000);
});
