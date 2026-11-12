import fs from "node:fs/promises";
import path from "node:path";
import { APART_HOME } from "./paths";
import { isReleaseVersion } from "./version";

export const PACKAGE_NAME = "apart-browser";
export const UPDATE_CHECK_PATH = path.join(APART_HOME, "update-check.json");
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const FETCH_TIMEOUT_MS = 5000;

export interface UpdateCheck {
  checkedAt: number;
  latest: string | null;
  noticedAt?: number;
  noticedVersion?: string;
}

export interface Installer {
  name: string;
  command: string[];
}

function flagOn(value: string | undefined): boolean {
  return Boolean(value) && value !== "0" && value!.toLowerCase() !== "false";
}

export function updateChecksOff(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env.APART_NO_UPDATE_CHECK) || flagOn(env.CI);
}

export async function readUpdateCheck(file = UPDATE_CHECK_PATH): Promise<UpdateCheck | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Partial<UpdateCheck>;
    if (typeof parsed.checkedAt !== "number") return null;
    return {
      checkedAt: parsed.checkedAt,
      latest: isReleaseVersion(parsed.latest) ? parsed.latest : null,
      ...(typeof parsed.noticedAt === "number" ? { noticedAt: parsed.noticedAt } : {}),
      ...(isReleaseVersion(parsed.noticedVersion) ? { noticedVersion: parsed.noticedVersion } : {}),
    };
  } catch {
    return null;
  }
}

export async function writeUpdateCheck(check: UpdateCheck, file = UPDATE_CHECK_PATH): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(check)}\n`, { mode: 0o600 });
  await fs.rename(temp, file);
}

export async function fetchLatestVersion(fetchImpl: typeof fetch = fetch): Promise<string> {
  const response = await fetchImpl(REGISTRY_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`the npm registry answered ${response.status}`);
  const body = (await response.json()) as { version?: unknown };
  if (!isReleaseVersion(body.version)) throw new Error("the npm registry did not say which version is latest");
  return body.version;
}

export async function refreshUpdateCheck(options: { now?: number; maxAgeMs?: number; file?: string; fetchImpl?: typeof fetch } = {}): Promise<UpdateCheck | null> {
  const now = options.now ?? Date.now();
  const file = options.file ?? UPDATE_CHECK_PATH;
  const current = await readUpdateCheck(file);
  if (current && now - current.checkedAt < (options.maxAgeMs ?? UPDATE_CHECK_INTERVAL_MS)) return current;
  try {
    const next: UpdateCheck = { ...current, checkedAt: now, latest: await fetchLatestVersion(options.fetchImpl) };
    await writeUpdateCheck(next, file);
    return next;
  } catch {
    return current;
  }
}

export function installerFor(installedAt: string): Installer {
  const spec = `${PACKAGE_NAME}@latest`;
  const location = installedAt.replaceAll("\\", "/");
  if (location.includes("/.volta/")) return { name: "Volta", command: ["volta", "install", spec] };
  if (location.includes("/pnpm/") || location.includes("/.pnpm/")) return { name: "pnpm", command: ["pnpm", "add", "-g", spec] };
  if (location.includes("/.bun/")) return { name: "Bun", command: ["bun", "add", "-g", spec] };
  if (location.includes("/yarn/global/") || location.includes("/.yarn/")) return { name: "Yarn", command: ["yarn", "global", "add", spec] };
  return { name: "npm", command: ["npm", "install", "-g", spec] };
}
