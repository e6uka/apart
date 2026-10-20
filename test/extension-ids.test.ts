import { describe, expect, it } from "vitest";
import { EXTENSION_ID, allowedExtensionIds, allowedExtensionOrigins } from "../src/shared/protocol";

describe("allowedExtensionIds", () => {
  it("always includes the development id", () => {
    expect(allowedExtensionIds("")).toContain(EXTENSION_ID);
  });

  it("adds valid ids from the environment and ignores invalid ones", () => {
    const store = "abcdefghijklmnopabcdefghijklmnop";
    const ids = allowedExtensionIds(`${store}, not-an-id ,ZZZZ`);
    expect(ids).toEqual([EXTENSION_ID, store]);
    expect(allowedExtensionOrigins(store)).toContain(`chrome-extension://${store}`);
  });
});
