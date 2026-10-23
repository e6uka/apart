import { describe, expect, it } from "vitest";
import { browserLabel, isExtensionBrowserName, nameFromBrands, nameFromProcess } from "../src/shared/browsers";

describe("browser names", () => {
  it("names a browser from the app its process belongs to", () => {
    expect(nameFromProcess("/Applications/Arc.app/Contents/Frameworks/ArcCore.framework/Helpers/Browser Helper.app/Contents/MacOS/Browser Helper")).toBe("arc");
    expect(nameFromProcess("/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper")).toBe("chrome");
    expect(nameFromProcess("/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary")).toBe("chrome-canary");
    expect(nameFromProcess("/Applications/Brave Browser.app/Contents/MacOS/Brave Browser")).toBe("brave");
    expect(nameFromProcess("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge")).toBe("edge");
    expect(nameFromProcess("/opt/google/chrome/chrome")).toBe("chrome");
    expect(nameFromProcess("/usr/bin/node")).toBeNull();
  });

  it("tells Dia apart from Arc, though Dia runs on Arc's engine", () => {
    expect(nameFromProcess("/Applications/Dia.app/Contents/Frameworks/ArcCore.framework/Helpers/Browser Helper.app/Contents/MacOS/Browser Helper")).toBe("dia");
    expect(nameFromProcess("/Applications/Dia.app/Contents/MacOS/Dia")).toBe("dia");
    expect(nameFromBrands(["Not)A;Brand", "Dia", "Chromium"])).toBe("dia");
    expect(browserLabel("dia")).toBe("Dia");
  });

  it("falls back to the browser's brand list", () => {
    expect(nameFromBrands(["Not)A;Brand", "Microsoft Edge", "Chromium"])).toBe("edge");
    expect(nameFromBrands(["Chromium", "Google Chrome"])).toBe("chrome");
    expect(nameFromBrands(undefined)).toBe("chrome");
  });

  it("validates names and labels them", () => {
    expect(isExtensionBrowserName("chrome-work")).toBe(true);
    expect(isExtensionBrowserName("headless")).toBe(false);
    expect(isExtensionBrowserName("Has Spaces")).toBe(false);
    expect(browserLabel("arc")).toBe("Arc");
    expect(browserLabel("chrome-work")).toBe("Chrome Work");
  });
});
