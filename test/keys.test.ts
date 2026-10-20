import { describe, expect, it } from "vitest";
import { keyDescriptor } from "../src/daemon/keys";

describe("keyDescriptor", () => {
  it("maps named keys", () => {
    expect(keyDescriptor("Enter")).toMatchObject({ key: "Enter", code: "Enter", keyCode: 13, text: "\r", modifiers: 0 });
    expect(keyDescriptor("ArrowDown")).toMatchObject({ key: "ArrowDown", keyCode: 40 });
    expect(keyDescriptor("Tab").text).toBeUndefined();
  });

  it("maps printable characters", () => {
    expect(keyDescriptor("a")).toMatchObject({ key: "a", code: "KeyA", keyCode: 65, text: "a" });
    expect(keyDescriptor("A")).toMatchObject({ key: "A", code: "KeyA", keyCode: 65, text: "A" });
    expect(keyDescriptor("5")).toMatchObject({ key: "5", code: "Digit5", keyCode: 53 });
    expect(keyDescriptor("!")).toMatchObject({ key: "!", code: "Digit1", modifiers: 8 });
  });

  it("applies modifiers and drops text for shortcuts", () => {
    expect(keyDescriptor("Control+a")).toMatchObject({ key: "a", modifiers: 2, text: undefined });
    expect(keyDescriptor("Meta+Shift+Enter")).toMatchObject({ key: "Enter", modifiers: 12, text: undefined });
    expect(keyDescriptor("Shift+a")).toMatchObject({ key: "A", modifiers: 8, text: "A" });
  });

  it("rejects unknown keys and modifiers", () => {
    expect(() => keyDescriptor("Hyper+a")).toThrow(/Unknown modifier/);
    expect(() => keyDescriptor("NotAKey")).toThrow(/Unknown key/);
  });
});
