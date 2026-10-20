import fs from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

export class PathEscapesRunDirError extends Error {
  constructor(requested: string) {
    super(`Path escapes the run directory: ${requested}`);
    this.name = "PathEscapesRunDirError";
  }
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

export function resolveInside(root: string, requested: string): string {
  const realRoot = realpathSync(root);
  const resolved = path.resolve(root, requested);
  let probe = resolved;
  while (!existsSync(probe)) probe = path.dirname(probe);
  const real = path.join(realpathSync(probe), path.relative(probe, resolved));
  if (!isInside(realRoot, real)) throw new PathEscapesRunDirError(requested);
  return real;
}

export function createConfinedFs(root: string) {
  const inside = (p: string) => resolveInside(root, String(p));
  return {
    readFile: async (p: string, options?: BufferEncoding | { encoding?: BufferEncoding | null }) =>
      options === undefined ? fs.readFile(inside(p)) : fs.readFile(inside(p), options as BufferEncoding),
    writeFile: async (p: string, data: string | Uint8Array) => fs.writeFile(inside(p), data),
    appendFile: async (p: string, data: string | Uint8Array) => fs.appendFile(inside(p), data),
    mkdir: async (p: string, options?: { recursive?: boolean }) => fs.mkdir(inside(p), options),
    readdir: async (p: string) => fs.readdir(inside(p)),
    stat: async (p: string) => fs.stat(inside(p)),
    rm: async (p: string, options?: { recursive?: boolean; force?: boolean }) => fs.rm(inside(p), options),
    unlink: async (p: string) => fs.unlink(inside(p)),
    rename: async (from: string, to: string) => fs.rename(inside(from), inside(to)),
    copyFile: async (from: string, to: string) => fs.copyFile(inside(from), inside(to)),
    access: async (p: string) => fs.access(inside(p)),
    exists: async (p: string) => fs.access(inside(p)).then(() => true, () => false),
    resolvePath: inside,
  };
}

export type ConfinedFs = ReturnType<typeof createConfinedFs>;
