import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createConfinedFs, resolveInside } from "../src/daemon/confined-fs";

function tempRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), "apart-fs-"));
}

describe("resolveInside", () => {
  it("accepts relative and absolute paths inside the root", () => {
    const root = tempRoot();
    const real = realpathSync(root);
    expect(resolveInside(root, "shot.png")).toBe(path.join(real, "shot.png"));
    expect(resolveInside(root, path.join(root, "a", "b.txt"))).toBe(path.join(real, "a", "b.txt"));
    expect(resolveInside(root, path.join(real, "c.txt"))).toBe(path.join(real, "c.txt"));
  });

  it("rejects traversal and foreign absolute paths", () => {
    const root = tempRoot();
    expect(() => resolveInside(root, "../escape.txt")).toThrow(/escapes/);
    expect(() => resolveInside(root, "/etc/hosts")).toThrow(/escapes/);
  });

  it("rejects symlinks that point outside the root", () => {
    const root = tempRoot();
    const outside = tempRoot();
    writeFileSync(path.join(outside, "secret"), "x");
    symlinkSync(outside, path.join(root, "link"));
    expect(() => resolveInside(root, "link/secret")).toThrow(/escapes/);
    expect(() => resolveInside(root, "link/new-file")).toThrow(/escapes/);
  });

  it("follows symlinks that stay inside the root", () => {
    const root = tempRoot();
    mkdirSync(path.join(root, "real"));
    symlinkSync(path.join(root, "real"), path.join(root, "alias"));
    expect(resolveInside(root, "alias/file.txt")).toBe(path.join(realpathSync(root), "real", "file.txt"));
  });
});

describe("createConfinedFs", () => {
  it("reads and writes inside the root only", async () => {
    const root = tempRoot();
    const fs = createConfinedFs(root);
    await fs.mkdir("artifacts", { recursive: true });
    await fs.writeFile("artifacts/a.txt", "hello");
    expect(await fs.readFile("artifacts/a.txt", "utf8")).toBe("hello");
    expect(await fs.exists("artifacts/a.txt")).toBe(true);
    await expect(fs.writeFile("../b.txt", "no")).rejects.toThrow(/escapes/);
  });
});
