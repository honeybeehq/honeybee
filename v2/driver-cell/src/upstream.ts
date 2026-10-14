/**
 * Honeybee-owned upstream mirrors: one bare repository per origin URL under
 * `<data-dir>/upstream/`, fetch-only, whose `refs/upstream/head` is the
 * upstream's default branch. A Cell commit reachable from it counts as
 * landed (ancestry only; never by message or branch name). The mirror borrows
 * the origin's objects through `objects/info/alternates`, so a fetch only
 * transfers what the origin lacks. Nothing here writes to the origin checkout
 * or to a Cell, and nothing ever pushes.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { devNull } from "node:os";
import { join } from "node:path";
import { tryGit } from "./git.ts";

export const UPSTREAM_REF = "refs/upstream/head";
const MIN_FAILURE_BACKOFF_MS = 5 * 60_000;
const FETCHED_AT_FILE = "honeybee-fetched-at";
const FAILED_AT_FILE = "honeybee-fetch-failed-at";

export interface UpstreamRef {
  objectsDir: string;
  sha: string;
}

export type UpstreamRefresh =
  | { status: "fetched" | "fresh"; url: string; ref: UpstreamRef }
  | { status: "unmirrored"; url: null; ref: null }
  | { status: "failed"; url: string; ref: UpstreamRef | null; error: string };

export function upstreamRootFor(dataDir: string): string {
  return join(dataDir, "upstream");
}

export function originFetchUrl(originRepo: string): string | null {
  const res = tryGit(originRepo, ["config", "--get", "remote.origin.url"]);
  const url = res.status === 0 ? res.stdout.trim() : "";
  return url.length > 0 ? url : null;
}

export function mirrorDirFor(upstreamRoot: string, url: string): string {
  return join(upstreamRoot, `${createHash("sha256").update(url).digest("hex").slice(0, 16)}.git`);
}

function originObjectsDir(originRepo: string): string | null {
  const res = tryGit(originRepo, ["rev-parse", "--path-format=absolute", "--git-path", "objects"]);
  return res.status === 0 ? res.stdout.trim() : null;
}

function mirrorRef(mirrorDir: string): UpstreamRef | null {
  if (!existsSync(join(mirrorDir, "HEAD"))) return null;
  const res = tryGit(mirrorDir, ["rev-parse", "--verify", "--quiet", `${UPSTREAM_REF}^{commit}`]);
  return res.status === 0 ? { objectsDir: join(mirrorDir, "objects"), sha: res.stdout.trim() } : null;
}

function mtimeOf(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function fetchedAt(mirrorDir: string): number | null {
  return mtimeOf(join(mirrorDir, FETCHED_AT_FILE));
}

function ensureMirror(mirrorDir: string, url: string, originObjects: string): void {
  if (!existsSync(join(mirrorDir, "HEAD"))) {
    const staging = `${mirrorDir}.init-${process.pid}`;
    rmSync(staging, { recursive: true, force: true });
    const init = tryGit(join(mirrorDir, ".."), ["init", "--bare", "--quiet", staging]);
    if (init.status !== 0) throw new Error(`git init --bare failed: ${init.stderr.trim()}`);
    writeFileSync(join(staging, "honeybee-upstream-url"), `${url}\n`);
    renameSync(staging, mirrorDir);
  }
  const alternates = join(mirrorDir, "objects", "info", "alternates");
  const current = existsSync(alternates) ? readFileSync(alternates, "utf8").trim() : "";
  if (current !== originObjects) writeFileSync(alternates, `${originObjects}\n`);
}

function originSshCommand(originRepo: string): string | null {
  const res = tryGit(originRepo, ["config", "--get", "core.sshCommand"]);
  const value = res.status === 0 ? res.stdout.trim() : "";
  return value.length > 0 ? value : null;
}

function fetchEnv(originRepo: string): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
  delete env.GIT_ALLOW_PROTOCOL;
  delete env.GIT_CONFIG_GLOBAL;
  delete env.GIT_CONFIG_SYSTEM;
  delete env.GIT_CONFIG_NOSYSTEM;
  const ssh = originSshCommand(originRepo) ?? env.GIT_SSH_COMMAND ?? "ssh";
  env.GIT_SSH_COMMAND = `${ssh} -o BatchMode=yes`;
  return env;
}

/**
 * Bring the mirror for `originRepo` up to date when it is older than
 * `maxAgeMs` (or always with `maxAgeMs: 0`). Fetch-only, bounded by
 * `timeoutMs`; a failure keeps the last good ref.
 */
export function refreshUpstreamMirror(
  originRepo: string,
  upstreamRoot: string,
  opts: { maxAgeMs: number; timeoutMs: number; now?: () => number },
): UpstreamRefresh {
  const url = originFetchUrl(originRepo);
  if (url == null) return { status: "unmirrored", url: null, ref: null };
  const mirrorDir = mirrorDirFor(upstreamRoot, url);
  const now = opts.now ?? Date.now;
  const last = fetchedAt(mirrorDir);
  const existing = mirrorRef(mirrorDir);
  if (existing && last != null && now() - last < opts.maxAgeMs) return { status: "fresh", url, ref: existing };
  const failedAt = mtimeOf(join(mirrorDir, FAILED_AT_FILE));
  if (failedAt != null && (last == null || failedAt > last) && now() - failedAt < Math.max(opts.maxAgeMs, MIN_FAILURE_BACKOFF_MS)) {
    return { status: "failed", url, ref: existing, error: `previous fetch failed at ${new Date(failedAt).toISOString()}; not retried yet` };
  }
  try {
    const originObjects = originObjectsDir(originRepo);
    if (originObjects == null) throw new Error("origin object directory unresolvable");
    mkdirSync(upstreamRoot, { recursive: true });
    ensureMirror(mirrorDir, url, originObjects);
    const args = [
      "-c", `core.hooksPath=${devNull}`,
      "-c", "core.fsmonitor=false",
      "-c", "fetch.recurseSubmodules=false",
      "-c", "protocol.ext.allow=never",
      "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--no-auto-gc", url, `+HEAD:${UPSTREAM_REF}`,
    ];
    const res = spawnSync("git", args, { cwd: mirrorDir, encoding: "utf8", env: fetchEnv(originRepo), timeout: opts.timeoutMs, maxBuffer: 16 * 1024 * 1024 });
    if (res.error) throw res.error;
    if (res.status !== 0) throw new Error(`git fetch exited ${res.status}: ${(res.stderr ?? "").trim().slice(0, 400)}`);
    const ref = mirrorRef(mirrorDir);
    if (ref == null) throw new Error(`${UPSTREAM_REF} missing after fetch`);
    writeFileSync(join(mirrorDir, FETCHED_AT_FILE), `${new Date(now()).toISOString()}\n`);
    return { status: "fetched", url, ref };
  } catch (err) {
    try {
      if (existsSync(mirrorDir)) writeFileSync(join(mirrorDir, FAILED_AT_FILE), `${new Date(now()).toISOString()}\n`);
    } catch {}
    return { status: "failed", url, ref: existing, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The last fetched ref for `originRepo`, without touching the network. */
export function readUpstreamMirror(originRepo: string, upstreamRoot: string): UpstreamRef | null {
  const url = originFetchUrl(originRepo);
  return url == null ? null : mirrorRef(mirrorDirFor(upstreamRoot, url));
}
