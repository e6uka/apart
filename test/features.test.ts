import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrowserBackend } from "../src/daemon/backend";
import { ExtensionBridge } from "../src/daemon/bridge";
import { findChrome, HeadlessBrowser } from "../src/daemon/headless";
import { runScript } from "../src/daemon/runner";
import { EXTENSION_ID, EXTENSION_ORIGIN } from "../src/shared/protocol";

const enabled = process.env.APART_E2E === "1";
const EXTENSION_PORT = 27198;
const DEBUG_PORT = 9338;
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

function pages(port: number): Record<string, { type: string; body: string; headers?: Record<string, string> }> {
  return {
    "/": {
      type: "text/html",
      body: `<!doctype html><title>features</title>
        <button id="ask" onclick="document.getElementById('answer').textContent = prompt('Your name?', 'nobody') + '/' + confirm('Sure?')">Ask</button>
        <p id="answer">none</p>
        <input id="file" type="file" multiple onchange="document.getElementById('files').textContent = [...this.files].map(f => f.name + ':' + f.size + ':' + f.type).join(',')">
        <p id="files">no files</p>
        <a id="dl" href="/report">Export</a>
        <iframe id="same" title="Same" src="/child" width="420" height="220"></iframe>
        <iframe id="cross" title="Cross" src="http://localhost:${port}/child" width="420" height="220"></iframe>`,
    },
    "/child": {
      type: "text/html",
      body: `<!doctype html><h2>Child</h2><label>Name <input id="name"></label>
        <button onclick="document.getElementById('out').textContent = 'clicked ' + document.getElementById('name').value">Go</button>
        <p id="out">idle</p><iframe title="Grand" src="/grand" width="200" height="60"></iframe>`,
    },
    "/grand": { type: "text/html", body: `<!doctype html><button onclick="this.textContent = 'grand clicked'">Grand</button>` },
    "/report": { type: "text/csv", body: "a,b\n1,2\n", headers: { "content-disposition": "attachment; filename=report.csv" } },
  };
}

const SCRIPT = (url: string) => `
  const pg = await openTab(${JSON.stringify(url)});
  await pg.frameLocator("#cross").locator("button").waitFor();
  await pg.frameLocator("#cross").frameLocator("iframe").locator("button").waitFor();
  const s = await snapshot(pg, { interactive: true });
  console.log("TREE_START"); console.log(s.tree); console.log("TREE_END");
  console.log("FRAMES=" + JSON.stringify((await pg.frames()).map((f) => f.ref + " " + f.name)));

  const same = pg.frameLocator("#same");
  await same.getByLabel("Name").fill("ada");
  await same.getByRole("button", { name: "Go" }).click();
  console.log("SAME=" + await same.locator("#out").innerText());

  const cross = pg.frameLocator("#cross");
  await cross.getByLabel("Name").fill("grace");
  await cross.getByRole("button", { name: "Go" }).click();
  console.log("CROSS=" + await cross.locator("#out").innerText());

  await cross.frameLocator("iframe").getByRole("button", { name: "Grand" }).click();
  console.log("GRAND=" + await cross.frameLocator("iframe").locator("button").innerText());

  const ref = s.tree.match(/iframe "Cross":[\\s\\S]*?button "Go" \\[ref=(f\\d+e\\d+)\\]/)[1];
  await cross.getByLabel("Name").fill("by ref");
  await pg.locator(ref).click();
  console.log("REF=" + ref + " " + await cross.locator("#out").innerText());

  const unhandled = pg.waitForEvent("dialog");
  await pg.click("#ask");
  const first = await unhandled;
  console.log("DEFAULT=" + first.type() + " " + await pg.locator("#answer").innerText());

  const seen = [];
  pg.on("dialog", async (dialog) => {
    seen.push(dialog.type() + ":" + dialog.message());
    if (dialog.type() === "prompt") await dialog.accept("typed");
    else await dialog.accept();
  });
  await pg.click("#ask");
  console.log("DIALOGS=" + seen.join("|") + " ANSWER=" + await pg.locator("#answer").innerText());

  await fs.writeFile("notes.txt", "hello");
  await pg.setInputFiles("#file", ["notes.txt", { name: "data.csv", buffer: Buffer.from("x,y") }]);
  console.log("FILES=" + await pg.locator("#files").innerText());
  try { await pg.setInputFiles("#file", "/etc/hosts"); console.log("ESCAPE=allowed"); } catch (e) { console.log("ESCAPE=" + e.name); }

  const [download] = await Promise.all([pg.waitForEvent("download"), pg.click("#dl")]);
  const saved = await download.path();
  console.log("DOWNLOAD=" + download.suggestedFilename() + " " + path.relative(pwd, saved) + " " + JSON.stringify(await fs.readFile(saved, "utf8")));

  await pg.evaluate(() => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob(["hello"])); a.download = "hello.txt"; a.id = "blob"; a.textContent = "Blob"; document.body.prepend(a); });
  const [blob] = await Promise.all([pg.waitForEvent("download"), pg.click("#blob")]);
  console.log("BLOB=" + blob.suggestedFilename() + " " + JSON.stringify(await fs.readFile(await blob.path(), "utf8")));

  const shot = await annotatedScreenshot(pg);
  console.log("ANNOTATED=" + (shot.refCount > 4));
  await closeTab(pg);
`;

async function runFeatures(bridge: BrowserBackend, url: string): Promise<string> {
  const out: string[] = [];
  const runDir = mkdtempSync(path.join(os.tmpdir(), "apart-features-run-"));
  const result = await runScript({ bridge, runDir, timeoutMs: 90000, emit: (text) => out.push(text), code: SCRIPT(url) });
  const text = out.join("\n");
  if (process.env.APART_E2E_VERBOSE === "1") process.stderr.write(`${text}\n${result.error ?? ""}\n`);
  expect(result.error).toBeUndefined();
  return text;
}

function expectFeatures(text: string): void {
  expect(text).toMatch(/- iframe "Same":\n\s+- heading "Child" \[level=2\]\n\s+- textbox "Name" \[ref=f\d+e1\]\n\s+- button "Go" \[ref=f\d+e2\]/);
  expect(text).toMatch(/- iframe "Cross":\n\s+- heading "Child" \[level=2\]\n\s+- textbox "Name" \[ref=f\d+e1\]\n\s+- button "Go" \[ref=f\d+e2\]/);
  expect(text).toMatch(/- iframe "Grand":\n\s+- button "Grand" \[ref=f\d+e1\]/);
  expect(text).toMatch(/FRAMES=\["f\d+ same",/);
  expect(text).toContain("DEFAULT=prompt null/false");
  expect(text).toContain("SAME=clicked ada");
  expect(text).toContain("CROSS=clicked grace");
  expect(text).toContain("GRAND=grand clicked");
  expect(text).toMatch(/REF=f\d+e\d+ clicked by ref/);
  expect(text).toContain("DIALOGS=prompt:Your name?|confirm:Sure? ANSWER=typed/true");
  expect(text).toContain("FILES=notes.txt:5:text/plain,data.csv:3:text/csv");
  expect(text).toContain("ESCAPE=PathEscapesRunDirError");
  expect(text).toContain('DOWNLOAD=report.csv downloads/report.csv "a,b\\n1,2\\n"');
  expect(text).toContain('BLOB=hello.txt "hello"');
  expect(text).toContain("ANNOTATED=true");
}

async function startServer(): Promise<{ server: Server; url: string }> {
  let port = 0;
  const server = createServer((req, res) => {
    const page = pages(port)[new URL(req.url ?? "/", "http://x").pathname];
    if (!page) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader("content-type", `${page.type}; charset=utf-8`);
    for (const [name, value] of Object.entries(page.headers ?? {})) res.setHeader(name, value);
    res.end(page.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  port = (server.address() as { port: number }).port;
  return { server, url: `http://127.0.0.1:${port}/` };
}

async function pointExtensionAt(port: number): Promise<void> {
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
    const result = await send("Runtime.evaluate", { expression: `chrome.storage.local.set({ port: ${port} }).then(() => true)`, awaitPromise: true, returnByValue: true }, sessionId).catch(() => null);
    if (result?.result?.value === true) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await send("Target.closeTarget", { targetId });
  ws.close();
}

describe.skipIf(!enabled)("frames, dialogs, uploads and downloads", () => {
  let site: { server: Server; url: string };
  let headless: HeadlessBrowser;
  let bridge: ExtensionBridge;
  let chrome: ChildProcess | null = null;

  beforeAll(async () => {
    site = await startServer();
    const executable = chromeForTesting();
    if (!executable) throw new Error("No Chrome found; set CHROME_PATH");
    headless = new HeadlessBrowser({ profileDir: mkdtempSync(path.join(os.tmpdir(), "apart-features-headless-")), executable });
    bridge = new ExtensionBridge(EXTENSION_PORT, EXTENSION_ORIGIN);
    await bridge.listen();
    const profile = mkdtempSync(path.join(os.tmpdir(), "apart-features-profile-"));
    const downloads = mkdtempSync(path.join(os.tmpdir(), "apart-features-downloads-"));
    mkdirSync(path.join(profile, "Default"), { recursive: true });
    writeFileSync(path.join(profile, "Default", "Preferences"), JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }));
    chrome = spawn(executable, [
      "--headless=new", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profile}`,
      `--load-extension=${extensionDir}`, `--disable-extensions-except=${extensionDir}`,
      "--window-size=1200,900", `--remote-debugging-port=${DEBUG_PORT}`, "about:blank",
    ], { stdio: "ignore" });
    await pointExtensionAt(EXTENSION_PORT);
    if (!(await bridge.waitForConnection(30000))) throw new Error("Extension did not connect");
  }, 90000);

  afterAll(async () => {
    await headless?.close();
    bridge?.close();
    chrome?.kill("SIGKILL");
    site?.server.close();
  });

  it("works headless", async () => {
    await headless.acquire();
    try {
      expectFeatures(await runFeatures(headless, site.url));
    } finally {
      headless.release();
    }
  }, 120000);

  it("works in Chrome through the extension", async () => {
    expectFeatures(await runFeatures(bridge, site.url));
  }, 120000);
});
