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

const PROBE = `async function probe(url) { try { const r = await fetch(url, { cache: "no-store" }); return "ok:" + (await r.text()); } catch { return "failed"; } }`;

function routes(port: number): Record<string, { type: string; body: string }> {
  return {
    "/": {
      type: "text/html",
      body: `<!doctype html><title>offline</title><script>${PROBE}
        window.events = [];
        addEventListener("offline", () => events.push("offline"));
        addEventListener("online", () => events.push("online"));
        window.worker = new Worker("/worker.js");
        window.workerProbe = () => new Promise((resolve) => { worker.onmessage = (e) => resolve(e.data); worker.postMessage("go"); });
        </script><iframe id="cross" src="http://localhost:${port}/child"></iframe>`,
    },
    "/child": { type: "text/html", body: `<!doctype html><script>${PROBE}</script><p>child</p>` },
    "/worker.js": { type: "text/javascript", body: `${PROBE} onmessage = async () => postMessage(await probe("/data"));` },
    "/data": { type: "text/plain", body: "pong" },
  };
}

describe.skipIf(!enabled)("offline simulation", () => {
  let browser: HeadlessBrowser;
  let server: Server;
  let base = "";

  beforeAll(async () => {
    let port = 0;
    server = createServer((req, res) => {
      const route = routes(port)[new URL(req.url ?? "/", "http://x").pathname];
      if (!route) {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.setHeader("content-type", route.type);
      res.setHeader("access-control-allow-origin", "*");
      res.end(route.body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    port = typeof address === "object" && address ? address.port : 0;
    base = `http://127.0.0.1:${port}`;
    browser = new HeadlessBrowser({
      profileDir: mkdtempSync(path.join(os.tmpdir(), "apart-offline-profile-")),
      executable: chromeForTesting(),
      idleMs: 1000,
    });
  });

  afterAll(async () => {
    await browser?.close();
    server?.close();
  });

  it("takes the page, its cross-origin frames and its workers offline and back", async () => {
    await browser.acquire();
    const out: string[] = [];
    const result = await runScript({
      bridge: browser,
      runDir: mkdtempSync(path.join(os.tmpdir(), "apart-offline-run-")),
      timeoutMs: 60000,
      emit: (text) => out.push(text),
      code: `
        const pg = await openTab(${JSON.stringify(`${base}/`)});
        const frame = pg.frameLocator("#cross");
        await frame.locator("p").waitFor();
        const state = async (label) => {
          const page = await pg.evaluate(() => probe("/data"));
          const worker = await pg.evaluate(() => workerProbe());
          const child = await frame.locator("p").evaluate(async () => { try { const r = await fetch("/data", { cache: "no-store" }); return "ok:" + (await r.text()); } catch { return "failed"; } });
          const online = await pg.evaluate(() => navigator.onLine);
          console.log(label + "=" + [online, page, worker, child, pg.isOffline()].join("|"));
        };
        await state("BEFORE");
        await pg.setOffline(true);
        await state("OFFLINE");
        let gotoError = "none";
        try { await pg.goto(${JSON.stringify(`${base}/data`)}, { timeout: 5000 }); } catch (error) { gotoError = error.message; }
        console.log("GOTO=" + gotoError);
        await pg.setOffline(false);
        await pg.goto(${JSON.stringify(`${base}/`)});
        await frame.locator("p").waitFor();
        await state("AFTER");
        await pg.setOffline(true);
        await pg.evaluate(() => new Promise((r) => setTimeout(r, 100)));
        await pg.setOffline(false);
        await pg.evaluate(() => new Promise((r) => setTimeout(r, 100)));
        console.log("EVENTS=" + (await pg.evaluate(() => events.join(","))));
        await closeTab(pg);
      `,
    });
    browser.release();
    expect(result.error).toBeUndefined();
    const text = out.join("\n");
    expect(text).toContain("BEFORE=true|ok:pong|ok:pong|ok:pong|false");
    expect(text).toContain("OFFLINE=false|failed|failed|failed|true");
    expect(text).toMatch(/GOTO=.*ERR_INTERNET_DISCONNECTED/);
    expect(text).toContain("AFTER=true|ok:pong|ok:pong|ok:pong|false");
    expect(text).toContain("EVENTS=offline,online");
  }, 90000);
});
