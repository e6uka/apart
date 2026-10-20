import fs from "node:fs/promises";
import path from "node:path";
import { APART_HOME } from "./paths";
import type { RunBrowser } from "./protocol";

export const CONFIG_PATH = path.join(APART_HOME, "config.json");
export const BROWSERS: readonly RunBrowser[] = ["chrome", "headless"];

export interface ApartConfig {
  defaultBrowser: RunBrowser;
}

export const DEFAULT_CONFIG: ApartConfig = { defaultBrowser: "chrome" };

export function isBrowser(value: unknown): value is RunBrowser {
  return typeof value === "string" && (BROWSERS as readonly string[]).includes(value);
}

export async function readConfig(file = CONFIG_PATH): Promise<ApartConfig & { saved: boolean }> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Partial<ApartConfig>;
    return { defaultBrowser: isBrowser(parsed.defaultBrowser) ? parsed.defaultBrowser : DEFAULT_CONFIG.defaultBrowser, saved: true };
  } catch {
    return { ...DEFAULT_CONFIG, saved: false };
  }
}

export async function writeConfig(config: ApartConfig, file = CONFIG_PATH): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temp, file);
}
