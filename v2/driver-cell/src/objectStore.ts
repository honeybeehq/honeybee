import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tryGit } from "./git.ts";
import { gitImageRepoKey } from "./gitImage.ts";

export function cellObjectStoreRoot(cellsRoot: string): string {
  return join(dirname(resolve(cellsRoot)), "cell-objects");
}

export function objectStoreDir(root: string, originRepo: string): string {
  return join(root, `${gitImageRepoKey(originRepo)}.git`);
}

const STORE_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ["gc.auto", "0"],
  ["gc.pruneExpire", "never"],
  ["gc.reflogExpireUnreachable", "never"],
  ["core.logAllRefUpdates", "false"],
];

const FETCH_REFSPECS = ["+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*", "+refs/remotes/*:refs/remotes/*"];

export type ObjectStoreStatus = "fetched" | "fetch_failed" | "init_failed";

export interface ObjectStore {
  dir: string;
  status: ObjectStoreStatus;
  error: string | null;
}

export function ensureObjectStore(root: string, originRepo: string, opts: { timeoutMs?: number } = {}): ObjectStore {
  const dir = objectStoreDir(root, originRepo);
  if (!existsSync(join(dir, "HEAD"))) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const staging = `${dir}.init-${process.pid}`;
    rmSync(staging, { recursive: true, force: true });
    const init = tryGit(root, ["init", "--bare", "--quiet", staging]);
    if (init.status !== 0) return { dir, status: "init_failed", error: init.stderr.trim() };
    for (const [key, value] of STORE_CONFIG) {
      const set = tryGit(staging, ["config", key, value]);
      if (set.status !== 0) return { dir, status: "init_failed", error: set.stderr.trim() };
    }
    try {
      renameSync(staging, dir);
    } catch {
      rmSync(staging, { recursive: true, force: true });
      if (!existsSync(join(dir, "HEAD"))) return { dir, status: "init_failed", error: "another process is initializing the store" };
    }
  }
  const fetch = tryGit(dir, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--", originRepo, ...FETCH_REFSPECS], { timeoutMs: opts.timeoutMs ?? 120_000 });
  if (fetch.status !== 0) return { dir, status: "fetch_failed", error: fetch.stderr.trim() };
  const head = tryGit(originRepo, ["symbolic-ref", "--quiet", "HEAD"]);
  if (head.status === 0 && head.stdout.trim().startsWith("refs/heads/")) tryGit(dir, ["symbolic-ref", "HEAD", head.stdout.trim()]);
  return { dir, status: "fetched", error: null };
}

export function hasObjectStore(root: string, originRepo: string): boolean {
  try {
    return existsSync(join(objectStoreDir(root, originRepo), "HEAD"));
  } catch {
    return false;
  }
}
