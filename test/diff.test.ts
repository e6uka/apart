import { describe, expect, it } from "vitest";
import { diffTrees } from "../src/daemon/diff";

describe("diffTrees", () => {
  it("explains the first snapshot", () => {
    expect(diffTrees(null, "- heading \"Hi\"")).toMatch(/first snapshot/);
  });

  it("reports no changes when only refs differ", () => {
    const before = "- button \"Save\" [ref=e1]\n- link \"Home\" [ref=e2]";
    const after = "- button \"Save\" [ref=e7]\n- link \"Home\" [ref=e9]";
    expect(diffTrees(before, after)).toBe("(no changes)");
  });

  it("lists added and removed lines", () => {
    const before = "- heading \"Login\"\n- textbox \"Email\" [ref=e1]\n- button \"Sign in\" [ref=e2]";
    const after = "- heading \"Dashboard\"\n- button \"Sign in\" [ref=e1]\n- link \"Settings\" [ref=e2]";
    expect(diffTrees(before, after).split("\n")).toEqual([
      "- - heading \"Login\"",
      "- - textbox \"Email\"",
      "+ - heading \"Dashboard\"",
      "+ - link \"Settings\"",
    ]);
  });

  it("falls back to a multiset diff for huge trees", () => {
    const before = Array.from({ length: 2500 }, (_, i) => `- text: ${i}`).join("\n");
    const after = `${before}\n- text: new`;
    expect(diffTrees(before, after)).toBe("+ - text: new");
  });
});
