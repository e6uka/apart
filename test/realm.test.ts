import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { isRegExp } from "../src/daemon/page";

describe("isRegExp", () => {
  it("recognises regular expressions created inside a script sandbox", () => {
    const fromSandbox = vm.runInNewContext("/dashboard/i");
    expect(fromSandbox instanceof RegExp).toBe(false);
    expect(isRegExp(fromSandbox)).toBe(true);
  });

  it("rejects strings and plain objects", () => {
    expect(isRegExp("dashboard")).toBe(false);
    expect(isRegExp({ source: "x", flags: "" })).toBe(false);
  });
});
