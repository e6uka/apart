import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { installerFor, readUpdateCheck, refreshUpdateCheck, updateChecksOff, writeUpdateCheck } from "../src/shared/update";
import { compareVersions, isReleaseVersion } from "../src/shared/version";

const DAY = 24 * 60 * 60 * 1000;

function tempFile(): string {
  return path.join(mkdtempSync(path.join(os.tmpdir(), "apart-update-")), "update-check.json");
}

function registry(version: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify({ version }), { status })) as unknown as typeof fetch;
}

describe("versions", () => {
  it("orders release versions by number, not by text", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
    expect(compareVersions("0.9.0", "0.9.0")).toBe(0);
    expect(compareVersions("0.9.0", "1.0.0")).toBe(-1);
  });

  it("accepts only plain release versions", () => {
    expect(isReleaseVersion("0.9.0")).toBe(true);
    expect(isReleaseVersion("1.0.0-beta.1")).toBe(false);
    expect(isReleaseVersion("dev")).toBe(false);
    expect(isReleaseVersion(9)).toBe(false);
  });
});

describe("update checks", () => {
  it("are off when APART_NO_UPDATE_CHECK or CI is set", () => {
    expect(updateChecksOff({})).toBe(false);
    expect(updateChecksOff({ APART_NO_UPDATE_CHECK: "1" })).toBe(true);
    expect(updateChecksOff({ APART_NO_UPDATE_CHECK: "0" })).toBe(false);
    expect(updateChecksOff({ CI: "true" })).toBe(true);
    expect(updateChecksOff({ CI: "false" })).toBe(false);
  });

  it("asks the registry once a day and keeps the answer", async () => {
    const file = tempFile();
    const first = registry("0.9.1");
    expect(await refreshUpdateCheck({ file, now: 1000, fetchImpl: first })).toEqual({ checkedAt: 1000, latest: "0.9.1" });
    const second = registry("0.9.2");
    expect((await refreshUpdateCheck({ file, now: 1000 + DAY - 1, fetchImpl: second }))?.latest).toBe("0.9.1");
    expect(second).not.toHaveBeenCalled();
    expect((await refreshUpdateCheck({ file, now: 1000 + DAY, fetchImpl: second }))?.latest).toBe("0.9.2");
  });

  it("keeps the last answer when the registry fails or sends nonsense", async () => {
    const file = tempFile();
    await writeUpdateCheck({ checkedAt: 0, latest: "0.9.1", noticedAt: 5, noticedVersion: "0.9.1" }, file);
    expect(await refreshUpdateCheck({ file, now: DAY, fetchImpl: registry("0.9.2", 500) })).toEqual({ checkedAt: 0, latest: "0.9.1", noticedAt: 5, noticedVersion: "0.9.1" });
    expect((await refreshUpdateCheck({ file, now: DAY, fetchImpl: registry("latest") }))?.latest).toBe("0.9.1");
  });

  it("keeps when the user was last told about an update", async () => {
    const file = tempFile();
    await writeUpdateCheck({ checkedAt: 0, latest: "0.9.1", noticedAt: 5, noticedVersion: "0.9.1" }, file);
    expect(await refreshUpdateCheck({ file, now: DAY, fetchImpl: registry("0.9.2") })).toEqual({ checkedAt: DAY, latest: "0.9.2", noticedAt: 5, noticedVersion: "0.9.1" });
  });

  it("treats a missing or broken file as never checked", async () => {
    expect(await readUpdateCheck(tempFile())).toBeNull();
  });
});

describe("installerFor", () => {
  it("updates with the tool apart was installed with", () => {
    expect(installerFor("/usr/local/lib/node_modules/apart-browser/dist/apart.js").command).toEqual(["npm", "install", "-g", "apart-browser@latest"]);
    expect(installerFor("/Users/me/.config/yarn/global/node_modules/apart-browser/dist/apart.js").name).toBe("Yarn");
    expect(installerFor("/Users/me/Library/pnpm/global/5/node_modules/apart-browser/dist/apart.js").name).toBe("pnpm");
    expect(installerFor("/Users/me/.volta/tools/image/packages/apart-browser/lib/node_modules/apart-browser/dist/apart.js").name).toBe("Volta");
    expect(installerFor("/Users/me/.bun/install/global/node_modules/apart-browser/dist/apart.js").name).toBe("Bun");
  });
});
