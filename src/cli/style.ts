import os from "node:os";

export function colorEnabled(stream: { isTTY?: boolean } = process.stdout, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== "0" && env.FORCE_COLOR !== "false";
  if (env.TERM === "dumb") return false;
  return Boolean(stream.isTTY);
}

export interface Style {
  color: boolean;
  bold(text: string): string;
  dim(text: string): string;
  accent(text: string): string;
  ok(text: string): string;
  bad(text: string): string;
}

export function createStyle(color = colorEnabled()): Style {
  const wrap = (open: number, close: number) => (text: string) => (color ? `\x1b[${open}m${text}\x1b[${close}m` : text);
  return {
    color,
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    accent: wrap(35, 39),
    ok: wrap(32, 39),
    bad: wrap(31, 39),
  };
}

export const MARK = { ok: "✓", problem: "✗", info: "·", next: "→" } as const;

export function tilde(file: string, home = os.homedir()): string {
  return file === home ? "~" : file.startsWith(`${home}/`) ? `~${file.slice(home.length)}` : file;
}

export function formatUptime(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return `${Math.max(0, Math.round(ms / 1000))}s`;
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function extensionsPage(browser: string): string {
  const scheme = ["arc", "dia", "brave", "edge", "vivaldi", "opera"].includes(browser) ? browser : "chrome";
  return `${scheme}://extensions`;
}
