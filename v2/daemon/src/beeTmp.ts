import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { NodeKind } from "./config.ts";

export const DAEMON_TMP_NAME = "daemon";

export interface BeeTmpPolicy {
  readonly source: "config" | "satellite_default";
  readonly root: string;
  readonly daemonDir: string;
  readonly compileCache: string;
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
  const root = configured === undefined
    ? join(cacheHome, "honeybee", "tmp")
    : configured.startsWith("~/") ? join(home, configured.slice(2)) : configured;
  return {
    source: configured === undefined ? "satellite_default" : "config",
    root,
    daemonDir: join(root, DAEMON_TMP_NAME),
    compileCache: join(cacheHome, "honeybee", "node-compile-cache"),
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

export function applyDaemonTmpPolicy(policy: BeeTmpPolicy, env: Record<string, string | undefined>): void {
  mkdirSync(policy.daemonDir, { recursive: true, mode: 0o700 });
  mkdirSync(policy.compileCache, { recursive: true, mode: 0o700 });
  env.TMPDIR = policy.daemonDir;
  env.NODE_COMPILE_CACHE = policy.compileCache;
}

export function ensureBeeTmpEnv(policy: BeeTmpPolicy, beeId: string): { TMPDIR: string; NODE_COMPILE_CACHE: string } {
  const dir = beeTmpDir(policy, beeId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  mkdirSync(policy.compileCache, { recursive: true, mode: 0o700 });
  return { TMPDIR: dir, NODE_COMPILE_CACHE: policy.compileCache };
}

export function removeBeeTmpDir(policy: BeeTmpPolicy, beeId: string): boolean {
  return removeTmpEntry(policy, beeTmpName(beeId));
}

function removeTmpEntry(policy: BeeTmpPolicy, name: string): boolean {
  const dir = join(policy.root, name);
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
    return true;
  } catch {
    return false;
  }
}

export function sweepBeeTmpDirs(policy: BeeTmpPolicy, releasedBeeIds: Iterable<string>): string[] {
  const removed: string[] = [];
  for (const beeId of releasedBeeIds) {
    const name = beeTmpName(beeId);
    if (!existsSync(join(policy.root, name))) continue;
    if (removeTmpEntry(policy, name)) removed.push(name);
  }
  return removed;
}

export function describeBeeTmpPolicy(policy: BeeTmpPolicy | null): string {
  return policy
    ? `tmp.policy beeTmpRoot=${policy.root} source=${policy.source} daemonTmp=${policy.daemonDir} nodeCompileCache=${policy.compileCache}`
    : "tmp.policy beeTmpRoot=off";
}
