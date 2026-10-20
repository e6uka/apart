import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findChrome, HeadlessBrowser } from "../src/daemon/headless";
import { runScript } from "../src/daemon/runner";

const enabled = process.env.APART_E2E === "1";

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

const PAGE_HTML = `<!doctype html><title>apart headless</title>
<h1>Hello headless</h1>
<label>Name <input id="name"></label>
<button onclick="document.getElementById('out').textContent = 'hi ' + document.getElementById('name').value">Greet</button>
<p id="out">waiting</p>`;

describe.skipIf(!enabled)("headless Chrome", () => {
  let browser: HeadlessBrowser;
  let server: Server;
  let pageUrl = "";

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(PAGE_HTML);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    pageUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/greet`;
    browser = new HeadlessBrowser({
      profileDir: mkdtempSync(path.join(os.tmpdir(), "apart-headless-profile-")),
      executable: chromeForTesting(),
      idleMs: 1000,
    });
  });

  afterAll(async () => {
    await browser?.close();
    server?.close();
  });

  it("runs a script without the extension", async () => {
    await browser.acquire();
    const out: string[] = [];
    const runDir = mkdtempSync(path.join(os.tmpdir(), "apart-headless-run-"));
    const result = await runScript({
      bridge: browser,
      runDir,
      timeoutMs: 60000,
      emit: (text) => out.push(text),
      code: `
        const pg = await openTab(${JSON.stringify(pageUrl)});
        console.log("TITLE=" + await pg.title());
        const s = await snapshot(pg, { interactive: true });
        console.log(s.tree);
        await pg.getByLabel("Name").fill("apart");
        await pg.getByRole("button", { name: "Greet" }).click();
        console.log("OUT=" + await pg.locator("#out").innerText());
        await pg.screenshot({ path: "shot.png" });
        console.log("TABS=" + (await listBrowserTabs()).filter((tab) => tab.url.includes("/greet")).length);
        await closeTab(pg);
      `,
    });
    browser.release();
    expect(result.error).toBeUndefined();
    const text = out.join("\n");
    expect(text).toContain("TITLE=apart headless");
    expect(text).toMatch(/- button "Greet".*\[ref=e\d+\]/);
    expect(text).toContain("OUT=hi apart");
    expect(text).toContain("TABS=1");
    expect(existsSync(path.join(runDir, "shot.png"))).toBe(true);
    expect(result.urls).toEqual([pageUrl]);
    expect(result.tabsOpened).toBe(1);
    expect((await browser.listTabs()).some((tab) => tab.url.includes("/greet"))).toBe(false);
  }, 60000);

  it("closes Chrome after it has been idle", async () => {
    await browser.acquire();
    browser.release();
    expect(browser.connected).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(browser.connected).toBe(false);
  }, 15000);

  it("reports a clear error when Chrome cannot be found", async () => {
    const missing = new HeadlessBrowser({ profileDir: mkdtempSync(path.join(os.tmpdir(), "apart-headless-none-")), executable: null });
    await expect(missing.acquire()).rejects.toThrow(/No Chrome or Chromium found/);
  });
});
