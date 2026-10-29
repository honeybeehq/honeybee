import { lstatSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const CELL_PRIVATE_STATE_DIR = "sandbox-state";
export const CELL_PRIVATE_TMP = join(CELL_PRIVATE_STATE_DIR, "tmp");
export const CELL_PRIVATE_CACHE = join(CELL_PRIVATE_STATE_DIR, "cache");

export class CellPrivateStateError extends Error {
  constructor(path: string) {
    super(`cell private state: ${path} is not a real directory`);
    this.name = "CellPrivateStateError";
  }
}

function realDirectory(path: string): void {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new CellPrivateStateError(path);
  if (!info) mkdirSync(path, { mode: 0o700 });
}

export function cellPrivateEnv(wrapperDir: string, opts: { privateTmpfs: boolean }): Record<string, string> {
  const root = join(wrapperDir, CELL_PRIVATE_STATE_DIR);
  const tmp = join(wrapperDir, CELL_PRIVATE_TMP);
  const cache = join(wrapperDir, CELL_PRIVATE_CACHE);
  for (const path of [root, tmp, cache]) realDirectory(path);
  const scratch = opts.privateTmpfs ? "/tmp" : tmp;
  return { TMPDIR: scratch, TMP: scratch, TEMP: scratch, CLAUDE_CODE_TMPDIR: scratch, NODE_COMPILE_CACHE: join(cache, "node-compile") };
}

export function cellPnpmStoreDir(cellsRoot: string): string {
  return join(dirname(resolve(cellsRoot)), "pnpm-store");
}

export function cellPnpmStoreEnv(cellsRoot: string): Record<string, string> {
  const store = cellPnpmStoreDir(cellsRoot);
  realDirectory(store);
  return { npm_config_store_dir: store };
}

export function cellPrivateStatePaths(wrapperDir: string): string[] {
  return [join(wrapperDir, CELL_PRIVATE_TMP), join(wrapperDir, CELL_PRIVATE_CACHE)];
}
