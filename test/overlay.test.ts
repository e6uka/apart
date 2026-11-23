import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExtensionBridge } from "../src/daemon/bridge";
import { findChrome } from "../src/daemon/headless";
import { runScript } from "../src/daemon/runner";
import { EXTENSION_ID, EXTENSION_ORIGIN } from "../src/shared/protocol";

const enabled = process.env.APART_E2E === "1";
const EXTENSION_PORT = 27194;
const DEBUG_PORT = 9347;
const extensionDir = path.resolve("dist/extension");

function chromeForTesting(): string | null {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const cache = path.join(os.homedir(), "Library/Caches/ms-playwright");
  if (existsSync(cache)) {
    for (const entry of readdirSync(cache).filter((name) => name.startsWith("chromium-")).sort().reverse()) {
      const candidate = path.join(cache, entry, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
      if (existsSync(candidate)) return candidate;
    }
  }
  return findChrome();
}

const PAGE = `<!doctype html><html><head><title>overlay</title></head>
<body style="margin:0;background:#fff;height:100vh">
<button id="under" onclick="this.textContent='reached'" style="position:fixed;left:50%;bottom:18px;transform:translateX(-50%);width:120px;height:30px">Under</button>
</body></html>`;

const MODAL_PAGE = `<!doctype html><title>modal</title><body style="margin:0">
<dialog id="d"><p>Sign in</p><button id="inside" onclick="this.textContent='reached'">Inside</button></dialog>
<script>document.getElementById("d").showModal();</script></body>`;

function firstPixel(png: Buffer): [number, number, number] {
  let offset = 8;
  const idat: Buffer[] = [];
  let width = 0;
  let channels = 4;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      channels = data[9] === 2 ? 3 : 4;
    }
    if (type === "IDAT") idat.push(data);
    offset += length + 12;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  expect(width).toBeGreaterThan(0);
  expect(channels).toBeGreaterThanOrEqual(3);
  return [raw[1], raw[2], raw[3]];
}

class Cdp {
  private id = 0;
  private constructor(private readonly ws: WebSocket) {}

  static async connect(): Promise<Cdp> {
    let version: { webSocketDebuggerUrl: string } | null = null;
    for (let i = 0; i < 50 && !version; i++) {
      version = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`).then((r) => r.json(), () => null);
      if (!version) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!version) throw new Error("Chrome DevTools endpoint did not come up");
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    return new Cdp(ws);
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const msgId = ++this.id;
    return new Promise((resolve, reject) => {
      const onMessage = (data: WebSocket.RawData) => {
        const msg = JSON.parse(String(data));
        if (msg.id !== msgId) return;
        this.ws.off("message", onMessage);
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
      };
      this.ws.on("message", onMessage);
      this.ws.send(JSON.stringify({ id: msgId, method, params, sessionId }));
    });
  }

  async session(urlPart: string): Promise<string> {
    const { targetInfos } = await this.send("Target.getTargets");
    const target = targetInfos.find((info: { type: string; url: string }) => info.type === "page" && info.url.includes(urlPart));
    if (!target) throw new Error(`No page for ${urlPart}`);
    const { sessionId } = await this.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    return sessionId;
  }

  async evaluate(sessionId: string, expression: string): Promise<unknown> {
    const { result } = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
    return result.value;
  }

  async click(sessionId: string, x: number, y: number): Promise<void> {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, sessionId);
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, sessionId);
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, sessionId);
  }

  close(): void {
    this.ws.close();
  }
}

describe.skipIf(!enabled)("overlay in the user's browser", () => {
  let server: Server;
  let base = "";
  let bridge: ExtensionBridge;
  let chrome: ChildProcess | null = null;
  let cdp: Cdp;

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      if (req.url?.startsWith("/strict")) res.setHeader("content-security-policy", "style-src 'none'; require-trusted-types-for 'script'");
      res.end(req.url?.startsWith("/modal") ? MODAL_PAGE : PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const executable = chromeForTesting();
    if (!executable) throw new Error("No Chrome found; set CHROME_PATH");
    bridge = new ExtensionBridge(EXTENSION_PORT, EXTENSION_ORIGIN);
    await bridge.listen();
    const profile = mkdtempSync(path.join(os.tmpdir(), "apart-overlay-profile-"));
    mkdirSync(path.join(profile, "Default"), { recursive: true });
    writeFileSync(path.join(profile, "Default", "Preferences"), JSON.stringify({}));
    chrome = spawn(executable, [
      "--headless=new", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profile}`,
      `--load-extension=${extensionDir}`, `--disable-extensions-except=${extensionDir}`,
      "--window-size=1000,700", `--remote-debugging-port=${DEBUG_PORT}`, "about:blank",
    ], { stdio: "ignore" });
    cdp = await Cdp.connect();
    const { targetId } = await cdp.send("Target.createTarget", { url: `chrome-extension://${EXTENSION_ID}/options.html` });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    for (let i = 0; i < 20; i++) {
      const value = await cdp.evaluate(sessionId, `chrome.storage.local.set({ port: ${EXTENSION_PORT} }).then(() => true)`).catch(() => null);
      if (value === true) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await cdp.send("Target.closeTarget", { targetId });
    if (!(await bridge.waitForConnection(30000))) throw new Error("Extension did not connect");
  }, 90000);

  afterAll(async () => {
    cdp?.close();
    bridge?.close();
    chrome?.kill("SIGKILL");
    server?.close();
  });

  it("glows on a strict page, stays out of snapshots and screenshots, and lets clicks through", async () => {
    const out: string[] = [];
    const result = await runScript({
      bridge,
      runDir: mkdtempSync(path.join(os.tmpdir(), "apart-overlay-run-")),
      timeoutMs: 60000,
      keepTabs: true,
      emit: (text) => out.push(text),
      code: `
        const pg = await openTab(${JSON.stringify(`${base}/strict`)});
        await sleep(600);
        console.log("HOST=" + await pg.evaluate(() => document.querySelectorAll("apart-overlay").length));
        console.log("TREE=" + JSON.stringify((await snapshot(pg)).tree));
        const shot = await pg.screenshot();
        console.log("SHOT=" + shot.toString("base64"));
      `,
    });
    expect(result.error).toBeUndefined();
    const text = out.join("\n");
    expect(text).toContain("HOST=1");
    expect(text).not.toMatch(/Take over|apart is working/);
    expect(firstPixel(Buffer.from(text.match(/SHOT=(\S+)/)![1], "base64"))).toEqual([255, 255, 255]);
    const session = await cdp.session("/strict");
    expect(await cdp.evaluate(session, `document.querySelectorAll("apart-overlay").length`)).toBe(0);
  }, 90000);

  it("shows the glow to the user while the script runs", async () => {
    let session = "";
    let rawShot = "";
    const result = await runScript({
      bridge,
      runDir: mkdtempSync(path.join(os.tmpdir(), "apart-overlay-run-")),
      timeoutMs: 60000,
      emit: async (text) => {
        if (text !== "READY") return;
        session = await cdp.session("/glow");
        rawShot = (await cdp.send("Page.captureScreenshot", { format: "png" }, session)).data;
      },
      code: `
        const pg = await openTab(${JSON.stringify(`${base}/strict/glow`)}, { newTab: true });
        await sleep(600);
        console.log("READY");
        await sleep(1500);
        await closeTab(pg);
      `,
    });
    expect(result.error).toBeUndefined();
    const [r, g, b] = firstPixel(Buffer.from(rawShot, "base64"));
    expect(r).toBeGreaterThan(g + 40);
    expect(b).toBeGreaterThan(g);
  }, 90000);

  it("pauses when the user takes over and continues when they resume, without counting the pause", async () => {
    const out: string[] = [];
    let session = "";
    const pill = { x: 0, y: 0 };
    const result = await runScript({
      bridge,
      runDir: mkdtempSync(path.join(os.tmpdir(), "apart-overlay-run-")),
      timeoutMs: 6000,
      emit: async (text) => {
        out.push(text);
        const ready = text.match(/^READY (\d+) (\d+)$/);
        if (!ready) return;
        session = await cdp.session("/pause");
        pill.x = Number(ready[1]);
        pill.y = Number(ready[2]);
        await cdp.click(session, pill.x, pill.y);
        await new Promise((resolve) => setTimeout(resolve, 7000));
        await cdp.click(session, pill.x, pill.y);
      },
      code: `
        const pg = await openTab(${JSON.stringify(`${base}/pause`)}, { newTab: true });
        await sleep(600);
        const at = await pg.evaluate(() => ({ x: Math.round(innerWidth / 2 + 70), y: innerHeight - 36 }));
        console.log("READY " + at.x + " " + at.y);
        await sleep(1500);
        const started = Date.now();
        await pg.locator("#under").click();
        console.log("WAITED=" + (Date.now() - started));
        console.log("UNDER=" + await pg.locator("#under").innerText());
        await closeTab(pg);
      `,
    });
    const text = out.join("\n");
    if (process.env.APART_E2E_VERBOSE === "1") process.stderr.write(`${text}\n${result.error ?? ""}\n`);
    expect(result.error).toBeUndefined();
    expect(text).toContain("[paused: you took over the tab");
    expect(text).toContain("[resumed: apart has control again]");
    expect(Number(text.match(/WAITED=(\d+)/)![1])).toBeGreaterThan(3000);
    expect(text).toContain("UNDER=reached");
  }, 90000);

  it("can be taken over while the page has a modal dialog open", async () => {
    const out: string[] = [];
    let session = "";
    const pill = { x: 0, y: 0 };
    const result = await runScript({
      bridge,
      runDir: mkdtempSync(path.join(os.tmpdir(), "apart-overlay-run-")),
      timeoutMs: 6000,
      emit: async (text) => {
        out.push(text);
        const ready = text.match(/^READY (\d+) (\d+)$/);
        if (!ready) return;
        session = await cdp.session("/modal");
        pill.x = Number(ready[1]);
        pill.y = Number(ready[2]);
        await cdp.click(session, pill.x, pill.y);
        await new Promise((resolve) => setTimeout(resolve, 7000));
        await cdp.click(session, pill.x, pill.y);
      },
      code: `
        const pg = await openTab(${JSON.stringify(`${base}/modal`)}, { newTab: true });
        await sleep(600);
        const at = await pg.evaluate(() => ({ x: Math.round(innerWidth / 2 + 70), y: innerHeight - 36 }));
        console.log("READY " + at.x + " " + at.y);
        await sleep(1500);
        const started = Date.now();
        await pg.locator("#inside").click();
        console.log("WAITED=" + (Date.now() - started));
        console.log("UNDER=" + await pg.locator("#inside").innerText());
        await closeTab(pg);
      `,
    });
    const text = out.join("\n");
    if (process.env.APART_E2E_VERBOSE === "1") process.stderr.write(`${text}\n${result.error ?? ""}\n`);
    expect(result.error).toBeUndefined();
    expect(text).toContain("[paused: you took over the tab");
    expect(text).toContain("[resumed: apart has control again]");
    expect(Number(text.match(/WAITED=(\d+)/)![1])).toBeGreaterThan(3000);
    expect(text).toContain("UNDER=reached");
  }, 90000);
  it("turns amber while the tab is offline", async () => {
    let rawShot = "";
    const result = await runScript({
      bridge,
      runDir: mkdtempSync(path.join(os.tmpdir(), "apart-overlay-run-")),
      timeoutMs: 60000,
      emit: async (text) => {
        if (text !== "READY") return;
        const session = await cdp.session("/offline-glow");
        rawShot = (await cdp.send("Page.captureScreenshot", { format: "png" }, session)).data;
      },
      code: `
        const pg = await openTab(${JSON.stringify(`${base}/offline-glow`)}, { newTab: true });
        await pg.setOffline(true);
        await sleep(800);
        console.log("READY");
        await sleep(1500);
        await pg.setOffline(false);
        await closeTab(pg);
      `,
    });
    expect(result.error).toBeUndefined();
    const [r, g, b] = firstPixel(Buffer.from(rawShot, "base64"));
    expect(r).toBeGreaterThan(b + 60);
    expect(g).toBeGreaterThan(b + 20);
  }, 90000);

  it("shows nothing when the overlay setting is off", async () => {
    const counts: unknown[] = [];
    const result = await runScript({
      bridge,
      runDir: mkdtempSync(path.join(os.tmpdir(), "apart-overlay-run-")),
      timeoutMs: 60000,
      overlay: false,
      emit: async (text) => {
        if (text !== "READY") return;
        const session = await cdp.session("/no-overlay");
        counts.push(await cdp.evaluate(session, `document.querySelectorAll("apart-overlay").length`));
      },
      code: `
        const pg = await openTab(${JSON.stringify(`${base}/no-overlay`)}, { newTab: true });
        await pg.mouse.click(200, 200);
        await sleep(900);
        console.log("READY");
        await sleep(800);
        await closeTab(pg);
      `,
    });
    expect(result.error).toBeUndefined();
    expect(counts).toEqual([0]);
  }, 90000);
});
