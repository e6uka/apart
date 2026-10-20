import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

const MAX_SOCKET_PATH_BYTES = 100;

export const APART_HOME = process.env.APART_HOME
  ? path.resolve(process.env.APART_HOME)
  : path.join(os.homedir(), ".apart");
export const PID_PATH = path.join(APART_HOME, "daemon.pid");
export const LOG_DIR = path.join(APART_HOME, "logs");
export const RUNS_DIR = path.join(APART_HOME, "runs");
export const HISTORY_PATH = path.join(APART_HOME, "history.json");
export const HEADLESS_PROFILE_DIR = path.join(APART_HOME, "headless-profile");

function socketPath(): string {
  const preferred = path.join(APART_HOME, "daemon.sock");
  if (Buffer.byteLength(preferred) <= MAX_SOCKET_PATH_BYTES) return preferred;
  const digest = createHash("sha256").update(APART_HOME).digest("hex").slice(0, 16);
  return path.join(SHORT_SOCKET_DIR, `${digest}.sock`);
}

export const SHORT_SOCKET_DIR = path.join("/tmp", `apart-${process.getuid?.() ?? "user"}`);
export const SOCKET_PATH = socketPath();
export const SOCKET_DIR = path.dirname(SOCKET_PATH);
