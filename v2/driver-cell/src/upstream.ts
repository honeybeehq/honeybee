import { childNodePath, nativeNodeEnv } from "../../../src/nodeRuntime.ts";
/**
 * Honeybee-owned upstream mirrors: one bare repository per origin URL under
 * `<data-dir>/upstream/`, fetch-only, whose `refs/upstream/head` is the
 * upstream's default branch. A Cell commit reachable from it counts as
 * landed (ancestry only; never by message or branch name). The mirror borrows
 * the origin's objects through `objects/info/alternates`, so a fetch only
 * transfers what the origin lacks. Nothing here writes to the origin checkout
 * or to a Cell, and nothing ever pushes.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { devNull } from "node:os";
import { join } from "node:path";
import { isAncestor, tryGit } from "./git.ts";

export const UPSTREAM_REF = "refs/upstream/head";
const MIN_FAILURE_BACKOFF_MS = 5 * 60_000;
const MIRROR_LOCK_STALE_MS = 5 * 60_000;
const MIRROR_LOCK_HEARTBEAT_MS = 30_000;
const LOCK_HEARTBEAT_SOURCE = `const fs = require("node:fs");
const dir = process.argv[1];
const touch = () => { try { const now = new Date(); fs.utimesSync(dir, now, now); } catch { process.exit(0); } };
setInterval(touch, Number(process.argv[2]));
process.stdin.on("end", () => process.exit(0));
process.stdin.on("error", () => process.exit(0));
process.stdin.resume();`;
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
  mkdirSync(upstreamRoot, { recursive: true, mode: 0o700 });
  const lockDir = `${mirrorDir}.lock`;
  if (!acquireMirrorLock(lockDir, opts.timeoutMs)) {
    return { status: "failed", url, ref: mirrorRef(mirrorDir), error: "another refresh of this mirror is still running" };
  }
  const heartbeat = holdMirrorLock(lockDir);
  try {
    return refreshLocked(originRepo, mirrorDir, url, { ...opts, now });
  } finally {
    heartbeat.release();
    rmSync(lockDir, { recursive: true, force: true });
  }
}

export function holdMirrorLock(lockDir: string, heartbeatMs = MIRROR_LOCK_HEARTBEAT_MS): { release(): void } {
  try {
    const child = spawn(childNodePath(), ["-e", LOCK_HEARTBEAT_SOURCE, lockDir, String(heartbeatMs)], {
      stdio: ["pipe", "ignore", "ignore"],
      env: nativeNodeEnv(),
    });
    child.on("error", () => {});
    child.unref();
    return { release: () => { child.kill("SIGKILL"); } };
  } catch {
    return { release: () => {} };
  }
}

function acquireMirrorLock(lockDir: string, waitMs: number): boolean {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(lockDir);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const heldSince = mtimeOf(lockDir);
    if (heldSince != null && Date.now() - heldSince > MIRROR_LOCK_STALE_MS) {
      rmSync(lockDir, { recursive: true, force: true });
      continue;
    }
    if (Date.now() >= deadline) return false;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
}

function refreshLocked(
  originRepo: string,
  mirrorDir: string,
  url: string,
  opts: { maxAgeMs: number; timeoutMs: number; now: () => number },
): UpstreamRefresh {
  const now = opts.now;
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

export type CellBaseSource = "pinned" | "head" | "upstream";

export interface CellBase {
  sha: string;
  source: CellBaseSource;
  upstreamRef?: string;
  upstreamSha?: string;
  fetchedAt?: number;
}

const OBJECT_NAME = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function fetchedAtIn(commonDir: string): number | undefined {
  try {
    return Math.round(statSync(join(commonDir, "FETCH_HEAD")).mtimeMs);
  } catch {
    return undefined;
  }
}

export function resolveCellBase(originRepo: string): CellBase | null {
  const res = tryGit(originRepo, [
    "rev-parse", "--path-format=absolute", "--git-common-dir", "HEAD", "@{upstream}", "--symbolic-full-name", "@{upstream}",
  ]);
  const [commonDir, head, tip, upstreamRef] = res.stdout.split("\n");
  if (commonDir == null || head == null || !OBJECT_NAME.test(head)) return null;
  if (res.status !== 0 || tip == null || !OBJECT_NAME.test(tip) || !upstreamRef?.startsWith("refs/remotes/")) {
    return { sha: head, source: "head" };
  }
  const fetchedAt = fetchedAtIn(commonDir);
  const described = { upstreamRef, upstreamSha: tip, ...(fetchedAt == null ? {} : { fetchedAt }) };
  if (tip === head || !isAncestor(originRepo, head, tip)) return { sha: head, source: "head", ...described };
  return { sha: tip, source: "upstream", ...described };
}

export interface OriginSync {
  refresh: UpstreamRefresh;
  skipped: string | null;
  trackingRef: string | null;
  before: string | null;
  after: string | null;
  durationMs: number;
}

const ORIGIN_WORKTREE_BUSY = ["index.lock", "HEAD.lock", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-merge", "rebase-apply", "sequencer"];
const ORIGIN_COMMON_BUSY = ["packed-refs.lock", "config.lock", "shallow.lock", "gc.pid"];

function originBusyReason(originRepo: string, trackingRef: string): string | null {
  const dirs = tryGit(originRepo, ["rev-parse", "--path-format=absolute", "--absolute-git-dir", "--git-common-dir"]);
  const [gitDir, commonDir] = dirs.status === 0 ? dirs.stdout.split("\n") : [];
  if (gitDir == null || commonDir == null || gitDir.length === 0 || commonDir.length === 0) return "git dir unresolvable";
  const markers = [
    ...ORIGIN_WORKTREE_BUSY.map((name) => join(gitDir, name)),
    ...ORIGIN_COMMON_BUSY.map((name) => join(commonDir, name)),
    join(commonDir, `${trackingRef}.lock`),
  ];
  const found = markers.find((path) => existsSync(path));
  return found == null ? null : found.slice(found.startsWith(commonDir) ? commonDir.length + 1 : gitDir.length + 1);
}

function defaultTrackingRef(originRepo: string): { ref: string; sha: string } | null {
  const upstream = tryGit(originRepo, ["rev-parse", "@{upstream}", "--symbolic-full-name", "@{upstream}"]);
  const [sha, ref] = upstream.status === 0 ? upstream.stdout.split("\n") : [];
  if (ref == null || sha == null || !OBJECT_NAME.test(sha) || !ref.startsWith("refs/remotes/origin/")) return null;
  const head = tryGit(originRepo, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  const remoteDefault = head.status === 0 ? head.stdout.trim() : null;
  const isDefault = remoteDefault == null
    ? ref === "refs/remotes/origin/main" || ref === "refs/remotes/origin/master"
    : ref === remoteDefault;
  return isDefault ? { ref, sha } : null;
}

export function syncOriginFromMirror(
  originRepo: string,
  upstreamRoot: string,
  opts: { maxAgeMs: number; timeoutMs: number; now?: () => number },
): OriginSync {
  const started = performance.now();
  const refresh = refreshUpstreamMirror(originRepo, upstreamRoot, opts);
  const tracking = defaultTrackingRef(originRepo);
  const done = (after: string | null, skipped: string | null = null): OriginSync => ({
    refresh,
    skipped,
    trackingRef: tracking?.ref ?? null,
    before: tracking?.sha ?? null,
    after,
    durationMs: Math.round(performance.now() - started),
  });
  if (tracking == null || refresh.ref == null || refresh.url == null) {
    return done(tracking?.sha ?? null);
  }
  const busy = originBusyReason(originRepo, tracking.ref);
  if (busy != null) return done(tracking.sha, `origin busy: ${busy}`);
  const mirrorDir = mirrorDirFor(upstreamRoot, refresh.url);
  tryGit(originRepo, [
    "-c", "fetch.writeCommitGraph=false",
    "fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--no-prune", "--no-auto-gc",
    mirrorDir, `+${UPSTREAM_REF}:${tracking.ref}`,
  ]);
  const after = tryGit(originRepo, ["rev-parse", "--verify", "--quiet", tracking.ref]);
  return done(after.status === 0 ? after.stdout.trim() : tracking.sha);
}
