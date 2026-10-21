import fs from "node:fs/promises";
import path from "node:path";
import { APART_HOME } from "./paths";
import { HEADLESS, isBrowserName } from "./browsers";
import type { RunBrowser } from "./protocol";

export const CONFIG_PATH = path.join(APART_HOME, "config.json");

export interface ApartConfig {
  defaultBrowser: RunBrowser;
  keepTabs: boolean;
}

export const DEFAULT_CONFIG: ApartConfig = { defaultBrowser: "chrome", keepTabs: false };

export function isBrowser(value: unknown): value is RunBrowser {
  return isBrowserName(value);
}

export function isHeadless(browser: RunBrowser): boolean {
  return browser === HEADLESS;
}

export async function readConfig(file = CONFIG_PATH): Promise<ApartConfig & { saved: boolean }> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Partial<ApartConfig>;
    return {
      defaultBrowser: isBrowser(parsed.defaultBrowser) ? parsed.defaultBrowser : DEFAULT_CONFIG.defaultBrowser,
      keepTabs: typeof parsed.keepTabs === "boolean" ? parsed.keepTabs : DEFAULT_CONFIG.keepTabs,
      saved: true,
    };
  } catch {
    return { ...DEFAULT_CONFIG, saved: false };
  }
}

export async function writeConfig(changes: Partial<ApartConfig>, file = CONFIG_PATH): Promise<ApartConfig> {
  const { saved: _saved, ...current } = await readConfig(file);
  const config: ApartConfig = { ...current, ...changes };
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temp, file);
  return config;
}
