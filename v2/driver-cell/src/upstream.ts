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
import { isAncestor, tryGit } from "./git.ts";

export const UPSTREAM_REF = "refs/upstream/head";
const MIN_FAILURE_BACKOFF_MS = 5 * 60_000;
const MIRROR_LOCK_STALE_MS = 5 * 60_000;
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
  try {
    return refreshLocked(originRepo, mirrorDir, url, { ...opts, now });
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
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
  trackingRef: string | null;
  before: string | null;
  after: string | null;
  durationMs: number;
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
  const done = (after: string | null): OriginSync => ({
    refresh,
    trackingRef: tracking?.ref ?? null,
    before: tracking?.sha ?? null,
    after,
    durationMs: Math.round(performance.now() - started),
  });
  if (tracking == null || refresh.ref == null || refresh.url == null) {
    return done(tracking?.sha ?? null);
  }
  const mirrorDir = mirrorDirFor(upstreamRoot, refresh.url);
  tryGit(originRepo, ["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", mirrorDir, `+${UPSTREAM_REF}:${tracking.ref}`]);
  const after = tryGit(originRepo, ["rev-parse", "--verify", "--quiet", tracking.ref]);
  return done(after.status === 0 ? after.stdout.trim() : tracking.sha);
}

interface OriginRemote {
  url: string;
  pushUrl: string | null;
  branch: string | null;
  tip: string | null;
}

function originRemoteOf(originRepo: string): OriginRemote | null {
  const listed = tryGit(originRepo, ["config", "--get-regexp", "^remote\\..*\\.(url|pushurl)$"]);
  if (listed.status !== 0) return null;
  const remotes = new Map<string, { url?: string; pushUrl?: string }>();
  for (const line of listed.stdout.split("\n")) {
    const match = /^remote\.(.+)\.(url|pushurl) (.+)$/.exec(line);
    if (match == null) continue;
    const entry = remotes.get(match[1] as string) ?? {};
    if (match[2] === "url") entry.url = match[3];
    else entry.pushUrl = match[3];
    remotes.set(match[1] as string, entry);
  }
  const upstream = tryGit(originRepo, ["rev-parse", "@{upstream}", "--symbolic-full-name", "@{upstream}"]);
  const [tip, trackingRef] = upstream.status === 0 ? upstream.stdout.split("\n") : [];
  const remote = trackingRef == null || tip == null || !OBJECT_NAME.test(tip)
    ? null
    : [...remotes.keys()]
      .filter((name) => trackingRef.startsWith(`refs/remotes/${name}/`))
      .sort((a, b) => b.length - a.length)[0] ?? null;
  const chosen = remotes.get(remote ?? "origin");
  if (chosen?.url == null) return null;
  return {
    url: chosen.url,
    pushUrl: chosen.pushUrl ?? null,
    branch: remote == null ? null : (trackingRef as string).slice(`refs/remotes/${remote}/`.length),
    tip: remote == null ? null : (tip as string),
  };
}

export function adoptOriginRemote(spaceDir: string, originRepo: string): void {
  const origin = originRemoteOf(originRepo);
  if (origin == null) return;
  tryGit(spaceDir, ["config", "remote.origin.url", origin.url]);
  if (origin.pushUrl != null) tryGit(spaceDir, ["config", "remote.origin.pushurl", origin.pushUrl]);

  const trackingRef = origin.branch == null ? null : `refs/remotes/origin/${origin.branch}`;
  const localRef = origin.branch == null ? null : `refs/heads/${origin.branch}`;
  const listed = tryGit(spaceDir, [
    "for-each-ref", "--format=%(refname) %(objectname) %(symref)", "refs/remotes/origin/", ...(localRef == null ? [] : [localRef]),
  ]);
  const refs = (listed.status === 0 ? listed.stdout.split("\n") : [])
    .filter((line) => line.length > 0)
    .map((line) => {
      const [name, sha, symref] = line.split(" ");
      return { name: name as string, sha: sha as string, symref: symref ?? "" };
    });
  const deletes = refs
    .filter((ref) => ref.name.startsWith("refs/remotes/origin/") && ref.name !== trackingRef)
    .filter((ref) => trackingRef == null || origin.tip == null || ref.symref !== trackingRef)
    .map((ref) => `delete ${ref.name}\n`);
  const updates: string[] = [];
  if (trackingRef != null && origin.tip != null) {
    updates.push(`update ${trackingRef} ${origin.tip}\n`);
    const local = refs.find((ref) => ref.name === localRef);
    if (local != null && local.sha !== origin.tip && isAncestor(spaceDir, local.sha, origin.tip)) {
      updates.push(`update ${localRef} ${origin.tip} ${local.sha}\n`);
    }
  }
  if (deletes.length + updates.length === 0) return;
  const applied = tryGit(spaceDir, ["update-ref", "--no-deref", "--stdin"], { input: [...deletes, ...updates].join("") });
  if (applied.status !== 0 && deletes.length > 0) {
    tryGit(spaceDir, ["update-ref", "--no-deref", "--stdin"], { input: deletes.join("") });
  }
}
