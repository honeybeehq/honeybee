import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { NodeKind } from "./config.ts";

export const DAEMON_TMP_NAME = "daemon";

export interface BeeTmpPolicy {
  readonly source: "config" | "satellite_default";
  readonly root: string;
  readonly daemonDir: string;
  readonly compileCache: string;
  readonly ownedFrom: { readonly root: string; readonly compileCache: string };
}

export class BeeTmpUnsafeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BeeTmpUnsafeError";
  }
}

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function resolveBeeTmpPolicy(
  nodeKind: NodeKind,
  configured: string | null | undefined,
  env: Readonly<Record<string, string | undefined>>,
  home: string = homedir(),
): BeeTmpPolicy | null {
  if (configured === null) return null;
  if (configured === undefined && nodeKind !== "satellite") return null;
  const xdg = env.XDG_CACHE_HOME;
  const cacheHome = xdg && isAbsolute(xdg) ? xdg : join(home, ".cache");
  const honeybee = join(cacheHome, "honeybee");
  const root = configured === undefined
    ? join(honeybee, "tmp")
    : configured.startsWith("~/") ? join(home, configured.slice(2)) : configured;
  return {
    source: configured === undefined ? "satellite_default" : "config",
    root,
    daemonDir: join(root, DAEMON_TMP_NAME),
    compileCache: join(honeybee, "node-compile-cache"),
    ownedFrom: { root: configured === undefined ? honeybee : root, compileCache: honeybee },
  };
}

export function beeTmpName(beeId: string): string {
  return SAFE_SEGMENT.test(beeId) && beeId !== DAEMON_TMP_NAME
    ? beeId
    : `~${createHash("sha256").update(beeId).digest("hex").slice(0, 32)}`;
}

export function beeTmpDir(policy: BeeTmpPolicy, beeId: string): string {
  return join(policy.root, beeTmpName(beeId));
}

function ownedChain(from: string, target: string): string[] {
  const chain: string[] = [];
  for (let cursor = target; ; cursor = dirname(cursor)) {
    chain.unshift(cursor);
    if (cursor === from) return chain;
    if (dirname(cursor) === cursor) throw new BeeTmpUnsafeError(`bee tmp: ${target} is not under ${from}`);
  }
}

export type BeeTmpReplaced = (path: string, was: "symlink" | "not_directory") => void;

function realDirectory(path: string, create: boolean, onReplace?: BeeTmpReplaced): boolean {
  let info;
  try {
    info = lstatSync(path);
  } catch {
    if (!create) return false;
    mkdirSync(path, { mode: 0o700 });
    info = lstatSync(path);
  }
  if (info.isDirectory() && !info.isSymbolicLink()) return true;
  if (!create) throw new BeeTmpUnsafeError(`bee tmp: ${path} is not a real directory`);
  onReplace?.(path, info.isSymbolicLink() ? "symlink" : "not_directory");
  rmSync(path, { force: true });
  mkdirSync(path, { mode: 0o700 });
  const again = lstatSync(path);
  if (!again.isDirectory() || again.isSymbolicLink()) throw new BeeTmpUnsafeError(`bee tmp: could not replace ${path} with a real directory`);
  return true;
}

function verifiedOwnedDir(from: string, target: string, create: boolean, onReplace?: BeeTmpReplaced): string | null {
  const base = dirname(from);
  if (create) mkdirSync(base, { recursive: true, mode: 0o700 });
  let canonicalBase: string;
  try {
    canonicalBase = realpathSync(base);
  } catch {
    if (!create) return null;
    throw new BeeTmpUnsafeError(`bee tmp: ${base} does not exist`);
  }
  for (const component of ownedChain(from, target)) {
    if (!realDirectory(component, create, onReplace)) return null;
  }
  const expected = join(canonicalBase, target.slice(base.length));
  const actual = realpathSync(target);
  if (actual !== expected) throw new BeeTmpUnsafeError(`bee tmp: ${target} resolves to ${actual}, expected ${expected}`);
  return actual;
}

export function applyDaemonTmpPolicy(policy: BeeTmpPolicy, env: Record<string, string | undefined>, onReplace?: BeeTmpReplaced): void {
  env.TMPDIR = verifiedOwnedDir(policy.ownedFrom.root, policy.daemonDir, true, onReplace)!;
  env.NODE_COMPILE_CACHE = verifiedOwnedDir(policy.ownedFrom.compileCache, policy.compileCache, true, onReplace)!;
}

export function beeTmpPaths(policy: BeeTmpPolicy, beeId: string): { TMPDIR: string; NODE_COMPILE_CACHE: string } {
  return { TMPDIR: beeTmpDir(policy, beeId), NODE_COMPILE_CACHE: policy.compileCache };
}

export function ensureBeeTmpEnv(policy: BeeTmpPolicy, beeId: string, onReplace?: BeeTmpReplaced): { TMPDIR: string; NODE_COMPILE_CACHE: string } {
  return {
    TMPDIR: verifiedOwnedDir(policy.ownedFrom.root, beeTmpDir(policy, beeId), true, onReplace)!,
    NODE_COMPILE_CACHE: verifiedOwnedDir(policy.ownedFrom.compileCache, policy.compileCache, true, onReplace)!,
  };
}

export function removeBeeTmpDir(policy: BeeTmpPolicy, beeId: string): boolean {
  return removeTmpEntry(policy, beeTmpName(beeId));
}

function removeTmpEntry(policy: BeeTmpPolicy, name: string): boolean {
  const dir = join(policy.root, name);
  try {
    verifiedOwnedDir(policy.ownedFrom.root, policy.root, false);
    const info = lstatSync(dir, { throwIfNoEntry: false });
    if (!info) return true;
    rmSync(dir, info.isDirectory() && !info.isSymbolicLink() ? { recursive: true, force: true, maxRetries: 2 } : { force: true });
    return true;
  } catch {
    return false;
  }
}

export function sweepBeeTmpDirs(policy: BeeTmpPolicy, releasedBeeIds: Iterable<string>): string[] {
  const removed: string[] = [];
  for (const beeId of releasedBeeIds) {
    const name = beeTmpName(beeId);
    if (!lstatSync(join(policy.root, name), { throwIfNoEntry: false })) continue;
    if (removeTmpEntry(policy, name)) removed.push(name);
  }
  return removed;
}

export function describeBeeTmpPolicy(policy: BeeTmpPolicy | null): string {
  return policy
    ? `tmp.policy beeTmpRoot=${policy.root} source=${policy.source} daemonTmp=${policy.daemonDir} nodeCompileCache=${policy.compileCache}`
    : "tmp.policy beeTmpRoot=off";
}
