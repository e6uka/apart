import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtensionBridge } from "../src/daemon/bridge";
import { ExtensionNotConnectedError } from "../src/daemon/bridge";
import { runScript } from "../src/daemon/runner";

const offlineBridge = {
  connected: false,
  request: async () => { throw new ExtensionNotConnectedError(); },
  listTabs: async () => { throw new ExtensionNotConnectedError(); },
  onTab: () => () => undefined,
} as unknown as ExtensionBridge;

async function run(code: string, timeoutMs = 5000) {
  const out: string[] = [];
  const runDir = mkdtempSync(path.join(os.tmpdir(), "apart-run-"));
  const result = await runScript({ code, runDir, timeoutMs, bridge: offlineBridge, emit: (text) => out.push(text) });
  return { ...result, out, runDir };
}

describe("runScript", () => {
  it("captures console output and reports success", async () => {
    const result = await run('console.log("hello", 42, { a: 1 }); console.log("pwd is " + pwd);');
    expect(result.ok).toBe(true);
    expect(result.out[0]).toBe("hello 42 { a: 1 }");
    expect(result.out[1]).toBe(`pwd is ${result.runDir}`);
  });

  it("confines fs and path to the run directory", async () => {
    const result = await run(`
      await fs.writeFile("note.txt", "hi");
      console.log(await fs.readFile("note.txt", "utf8"));
      console.log(path.resolve("x.png"));
      try { await fs.readFile("/etc/hosts", "utf8"); } catch (e) { console.log("blocked: " + e.message); }
    `);
    expect(result.ok).toBe(true);
    expect(result.out).toEqual(["hi", path.join(result.runDir, "x.png"), "blocked: Path escapes the run directory: /etc/hosts"]);
  });

  it("reports thrown errors on one line", async () => {
    const result = await run('console.log("before"); throw new Error("boom\\nsecond line");');
    expect(result.ok).toBe(false);
    expect(result.out).toEqual(["before"]);
    expect(result.error).toBe("Error: boom | second line");
  });

  it("reports syntax errors", async () => {
    const result = await run("const = 1;");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/SyntaxError/);
  });

  it("ends silently on a top-level return", async () => {
    const result = await run('console.log("a"); return; console.log("b");');
    expect(result.ok).toBe(true);
    expect(result.out).toEqual(["a"]);
  });

  it("enforces the time limit", async () => {
    const result = await run("await sleep(5000); console.log('late');", 300);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/time limit/);
    expect(result.out).toEqual([]);
  });

  it("explains a missing extension when a tab is opened", async () => {
    const result = await run('await openTab("https://example.com");');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/No browser is connected/);
  });

  it("does not expose node globals", async () => {
    const result = await run("console.log(typeof process, typeof require, typeof globalThis.module);");
    expect(result.out).toEqual(["undefined undefined undefined"]);
  });
});
