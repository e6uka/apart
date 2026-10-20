import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RunHistory } from "../src/daemon/history";
import { readConfig, writeConfig } from "../src/shared/config";
import { mergeRuns, type RunRecord } from "../src/shared/protocol";

function run(id: string, startedAt: number, extra: Partial<RunRecord> = {}): RunRecord {
  return { id, startedAt, elapsedMs: 10, ok: true, urls: [], tabsOpened: 1, ...extra };
}

describe("mergeRuns", () => {
  it("dedupes by id, sorts newest first and keeps the limit", () => {
    const merged = mergeRuns([run("a", 1), run("b", 3)], [run("b", 3, { ok: false }), run("c", 2)], 0, 2);
    expect(merged.map((item) => item.id)).toEqual(["b", "c"]);
    expect(merged[0].ok).toBe(false);
  });

  it("drops runs that started before the history was cleared", () => {
    expect(mergeRuns([run("old", 5)], [run("new", 20)], 10).map((item) => item.id)).toEqual(["new"]);
  });

  it("ignores malformed records", () => {
    expect(mergeRuns([], [{ id: 3 } as unknown as RunRecord, run("ok", 1)])).toHaveLength(1);
  });
});

describe("RunHistory", () => {
  it("persists runs to disk and clears older ones", async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "apart-history-")), "history.json");
    const history = new RunHistory(file, 3);
    await history.add(run("a", 1, { browser: "headless" }));
    await history.add(run("b", 2));
    await history.add(run("c", 3));
    await history.add(run("d", 4));
    expect((await new RunHistory(file, 3).list()).map((item) => item.id)).toEqual(["d", "c", "b"]);
    await history.clearBefore(3);
    expect(JSON.parse(readFileSync(file, "utf8")).map((item: RunRecord) => item.id)).toEqual(["d", "c"]);
  });

  it("starts empty when the file is missing or broken", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "apart-history-"));
    expect(await new RunHistory(path.join(dir, "missing.json")).list()).toEqual([]);
  });
});

describe("config", () => {
  it("defaults to your Chrome until a browser is chosen", async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "apart-config-")), "config.json");
    expect(await readConfig(file)).toEqual({ defaultBrowser: "chrome", keepTabs: false, saved: false });
    await writeConfig({ defaultBrowser: "headless" }, file);
    expect(await readConfig(file)).toEqual({ defaultBrowser: "headless", keepTabs: false, saved: true });
    await writeConfig({ keepTabs: true }, file);
    expect(await readConfig(file)).toEqual({ defaultBrowser: "headless", keepTabs: true, saved: true });
  });
});
