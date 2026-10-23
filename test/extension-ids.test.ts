import { describe, expect, it } from "vitest";
import { EXTENSION_ID, STORE_EXTENSION_IDS, STORE_URL, allowedExtensionIds, allowedExtensionOrigins } from "../src/shared/protocol";

const STORE_ID = "aejkpibmfgojapfgoplgnokmblmacgpe";

describe("allowedExtensionIds", () => {
  it("always includes the development id", () => {
    expect(allowedExtensionIds("")).toContain(EXTENSION_ID);
  });

  it("includes the Chrome Web Store id", () => {
    expect(STORE_EXTENSION_IDS).toContain(STORE_ID);
    expect(allowedExtensionIds("")).toContain(STORE_ID);
    expect(STORE_URL).toBe(`https://chromewebstore.google.com/detail/apart/${STORE_ID}`);
  });

  it("adds valid ids from the environment and ignores invalid ones", () => {
    const extra = "abcdefghijklmnopabcdefghijklmnop";
    const ids = allowedExtensionIds(`${extra}, not-an-id ,ZZZZ`);
    expect(ids).toEqual([EXTENSION_ID, STORE_ID, extra]);
    expect(allowedExtensionOrigins(extra)).toContain(`chrome-extension://${extra}`);
  });
});
