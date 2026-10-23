import { describe, expect, it } from "vitest";
import { colorEnabled, createStyle, extensionsPage, formatUptime, tilde } from "../src/cli/style";

describe("colorEnabled", () => {
  it("follows the terminal by default", () => {
    expect(colorEnabled({ isTTY: true }, {})).toBe(true);
    expect(colorEnabled({ isTTY: false }, {})).toBe(false);
  });

  it("turns off for NO_COLOR and dumb terminals", () => {
    expect(colorEnabled({ isTTY: true }, { NO_COLOR: "1" })).toBe(false);
    expect(colorEnabled({ isTTY: true }, { TERM: "dumb" })).toBe(false);
  });

  it("lets FORCE_COLOR override a pipe, but not NO_COLOR", () => {
    expect(colorEnabled({ isTTY: false }, { FORCE_COLOR: "1" })).toBe(true);
    expect(colorEnabled({ isTTY: true }, { FORCE_COLOR: "0" })).toBe(false);
    expect(colorEnabled({ isTTY: false }, { FORCE_COLOR: "1", NO_COLOR: "1" })).toBe(false);
  });
});

describe("createStyle", () => {
  it("leaves text untouched without colour", () => {
    const style = createStyle(false);
    expect(style.accent(style.bold("apart"))).toBe("apart");
  });

  it("wraps text in ANSI codes with colour", () => {
    expect(createStyle(true).ok("done")).toBe("\x1b[32mdone\x1b[39m");
  });
});

describe("tilde", () => {
  it("shortens paths in the home folder only", () => {
    expect(tilde("/Users/a/.apart/extension", "/Users/a")).toBe("~/.apart/extension");
    expect(tilde("/Users/a", "/Users/a")).toBe("~");
    expect(tilde("/Users/ab/x", "/Users/a")).toBe("/Users/ab/x");
  });
});

describe("formatUptime", () => {
  it("picks a readable unit", () => {
    expect(formatUptime(42_000)).toBe("42s");
    expect(formatUptime(5 * 60_000)).toBe("5m");
    expect(formatUptime((2 * 60 + 14) * 60_000)).toBe("2h 14m");
    expect(formatUptime(26 * 3_600_000)).toBe("1d 2h");
  });
});

describe("extensionsPage", () => {
  it("uses the browser's own scheme where it has one", () => {
    expect(extensionsPage("dia")).toBe("dia://extensions");
    expect(extensionsPage("chrome-beta")).toBe("chrome://extensions");
  });
});
