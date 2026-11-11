import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { gitEnv, revParse, tryGit } from "./git.ts";
import { landingTargets } from "./landed.ts";
import { DEFAULT_LEFTOVER_PATTERNS, leftoverTopLevels } from "./leftovers.ts";

const WIP_NS = "refs/hive/wip";
const WIP_BRANCH_NS = "refs/hive/wip-heads";
const SHA = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

function refSegment(value: string, fallback: string): string {
  const safe = value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe.length > 0 ? safe : fallback;
}

export function wipNodeScope(installationId: string | null | undefined, host: string): string {
  return refSegment(installationId && installationId.length > 0 ? installationId : host, "node");
}

export function wipRefFor(node: string, cellId: string): string {
  return `${WIP_NS}/${refSegment(node, "node")}/${refSegment(cellId, "cell")}`;
}

/** Where a Cell's local branches are saved beside its WIP: `<prefix>/<branch name>`. */
export function wipBranchRefPrefix(node: string, cellId: string): string {
  return `${WIP_BRANCH_NS}/${refSegment(node, "node")}/${refSegment(cellId, "cell")}`;
}

function refPairs(out: string): Array<{ name: string; sha: string }> {
  const pairs: Array<{ name: string; sha: string }> = [];
  for (const line of out.split("\n")) {
    const nul = line.indexOf("\0");
    if (nul <= 0) continue;
    const name = line.slice(0, nul);
    const sha = line.slice(nul + 1).trim();
    if (SHA.test(sha)) pairs.push({ name, sha });
  }
  return pairs;
}

function localBranches(spaceDir: string): Array<{ name: string; sha: string }> {
  const res = tryGit(spaceDir, ["for-each-ref", "--format=%(refname:short)%00%(objectname)", "refs/heads"]);
  return res.status !== 0 ? [] : refPairs(res.stdout);
}

/** The branches saved for a Cell in the origin, by branch name. */
export function listWipBranches(originRepo: string, node: string, cellId: string): Array<{ name: string; sha: string }> {
  const prefix = wipBranchRefPrefix(node, cellId);
  const res = tryGit(originRepo, ["for-each-ref", "--format=%(refname)%00%(objectname)", `${prefix}/`]);
  if (res.status !== 0) return [];
  return refPairs(res.stdout).filter((p) => p.name.startsWith(`${prefix}/`)).map((p) => ({ name: p.name.slice(prefix.length + 1), sha: p.sha }));
}

export interface WipSnapshot {
  head: string;
  tree: string;
  sha: string;
  dirty: boolean;
  skipped: Array<{ path: string; bytes: number }>;
  complete: boolean;
}

const IN_PROGRESS_MARKERS = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-merge", "rebase-apply"] as const;

export function operationInProgress(spaceDir: string): string | null {
  for (const marker of IN_PROGRESS_MARKERS) {
    const res = tryGit(spaceDir, ["rev-parse", "--git-path", marker]);
    if (res.status !== 0) continue;
    const path = res.stdout.trim();
    if (existsSync(join(spaceDir, path)) || existsSync(path)) return marker;
  }
  return null;
}

export const WIP_MAX_FILE_BYTES = 64 * 1024 * 1024;

export type WipStage = "snapshot" | "push" | "confirm" | "restore";

export class WipError extends Error {
  readonly stage: WipStage;
  constructor(stage: WipStage, message: string) {
    super(`wip ${stage}: ${message}`);
    this.name = "WipError";
    this.stage = stage;
  }
}

function must(cwd: string, args: string[], stage: WipError["stage"], env?: Record<string, string>): string {
  const res = tryGit(cwd, args, env ? { env } : {});
  if (res.status !== 0) throw new WipError(stage, `git ${args.join(" ")} exited ${res.status}: ${res.stderr.trim()}`);
  return res.stdout.trim();
}

function seedIndex(spaceDir: string, index: string, stage: WipStage, env: Record<string, string>): void {
  rmSync(index, { force: true });
  const real = join(spaceDir, ".git", "index");
  if (existsSync(real)) {
    try {
      copyFileSync(real, index);
      const written = statSync(real);
      utimesSync(index, written.atime, written.mtime);
    } catch {
      rmSync(index, { force: true });
    }
  }
  if (!existsSync(index)) must(spaceDir, ["read-tree", "HEAD"], stage, env);
}

function changedPaths(spaceDir: string, stage: WipStage): Array<{ path: string; untracked: boolean }> {
  const res = tryGit(spaceDir, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]);
  if (res.status !== 0) throw new WipError(stage, `git status exited ${res.status}: ${res.stderr.trim()}`);
  return res.stdout.split("\0").filter((entry) => entry.length > 3).map((entry) => ({ path: entry.slice(3), untracked: entry.startsWith("?? ") }));
}

function oversize(spaceDir: string, paths: string[], maxFileBytes: number): Array<{ path: string; bytes: number }> {
  const out: Array<{ path: string; bytes: number }> = [];
  for (const path of paths) {
    try {
      const info = statSync(join(spaceDir, path));
      if (info.isFile() && info.size > maxFileBytes) out.push({ path, bytes: info.size });
    } catch {
      continue;
    }
  }
  return out;
}

function stageWorkingTree(spaceDir: string, index: string, stage: WipStage, maxFileBytes: number, leftoverPatterns: readonly string[]): { env: Record<string, string>; skipped: Array<{ path: string; bytes: number }> } {
  const env = gitEnv({ GIT_INDEX_FILE: index });
  seedIndex(spaceDir, index, stage, env);
  const changed = changedPaths(spaceDir, stage);
  const leftovers = leftoverTopLevels(changed.filter((c) => c.untracked).map((c) => c.path), leftoverPatterns);
  const skipped = oversize(spaceDir, changed.filter((c) => !(c.untracked && leftovers.includes(c.path.split("/")[0] ?? c.path))).map((c) => c.path), maxFileBytes);
  const add = ["add", "-A", "--", ".", ...skipped.map((s) => `:(exclude,literal)${s.path}`), ...leftovers.map((top) => `:(exclude,literal)${top}`)];
  if (tryGit(spaceDir, add, { env }).status !== 0) {
    rmSync(index, { force: true });
    must(spaceDir, ["read-tree", "HEAD"], stage, env);
    must(spaceDir, add, stage, env);
  }
  return { env, skipped };
}

export function snapshotWip(spaceDir: string, boxDir: string, cellId: string, now: () => number = Date.now, maxFileBytes = WIP_MAX_FILE_BYTES, leftoverPatterns: readonly string[] = DEFAULT_LEFTOVER_PATTERNS): WipSnapshot {
  const head = revParse(spaceDir, "HEAD");
  if (head == null) throw new WipError("snapshot", "the Cell has no HEAD");
  const inProgress = operationInProgress(spaceDir);
  if (inProgress != null) throw new WipError("snapshot", `operation_in_progress:${inProgress}`);
  mkdirSync(boxDir, { recursive: true });
  const index = join(boxDir, "wip.index");
  try {
    const { env, skipped } = stageWorkingTree(spaceDir, index, "snapshot", maxFileBytes, leftoverPatterns);
    const tree = must(spaceDir, ["write-tree"], "snapshot", env);
    const headTree = must(spaceDir, ["rev-parse", `${head}^{tree}`], "snapshot");
    if (tree === headTree) return { head, tree, sha: head, dirty: false, skipped, complete: skipped.length === 0 };
    const sha = must(spaceDir, ["commit-tree", tree, "-p", head, "-m", `hive wip ${cellId} ${new Date(now()).toISOString()}`], "snapshot", env);
    return { head, tree, sha, dirty: true, skipped, complete: skipped.length === 0 };
  } finally {
    rmSync(index, { force: true });
  }
}

/**
 * Save the WIP commit and every local branch of the Cell into the origin:
 * `refs/hive/wip/<node>/<cell>` and `refs/hive/wip-heads/<node>/<cell>/<branch>`.
 * A branch the agent committed to and switched away from is work too; the
 * push carries it so an eviction after the push loses nothing.
 */
export function pushWip(originRepo: string, spaceDir: string, node: string, cellId: string, sha: string, timeoutMs = 120_000): void {
  if (!SHA.test(sha)) throw new WipError("push", `not a commit sha: ${sha}`);
  if (!existsSync(join(originRepo, ".git")) && !existsSync(join(originRepo, "HEAD"))) throw new WipError("push", `origin ${originRepo} is not a local repository`);
  const prefix = wipBranchRefPrefix(node, cellId);
  const targets = landingTargets(originRepo, []);
  const landed = (sha: string): boolean => {
    if (targets.length === 0) return false;
    const res = tryGit(originRepo, ["rev-list", "--max-count=1", sha, "--not", ...targets]);
    return res.status === 0 && res.stdout.trim().length === 0;
  };
  const branches = localBranches(spaceDir).filter((b) => !landed(b.sha));
  const refspecs = [`+${sha}:${wipRefFor(node, cellId)}`, ...branches.map((b) => `+${b.sha}:${prefix}/${b.name}`)];
  const res = tryGit(originRepo, ["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", spaceDir, ...refspecs], { timeoutMs });
  if (res.status !== 0) throw new WipError("push", `fetch into origin exited ${res.status}: ${res.stderr.trim()}`);
  const wanted = new Set(branches.map((b) => b.name));
  for (const saved of listWipBranches(originRepo, node, cellId)) {
    if (!wanted.has(saved.name)) tryGit(originRepo, ["update-ref", "-d", `${prefix}/${saved.name}`, saved.sha]);
  }
}

export function confirmWip(originRepo: string, node: string, cellId: string, sha: string): boolean {
  if (revParse(originRepo, wipRefFor(node, cellId)) !== sha) return false;
  if (tryGit(originRepo, ["cat-file", "-e", `${sha}^{commit}`]).status !== 0) return false;
  const parent = revParse(originRepo, `${sha}^`);
  const connected = tryGit(originRepo, parent ? ["rev-list", "--objects", "--missing=error", "--quiet", sha, `^${parent}`] : ["rev-list", "--objects", "--missing=error", "--quiet", "--max-count=1", sha]);
  return connected.status === 0;
}

export interface WipRefSweep {
  dropped: string[];
  migrated: string[];
}

export function sweepWipRefs(originRepo: string, scopes: readonly string[], liveCellIds: ReadonlySet<string>, ownedCellIds: ReadonlySet<string> = liveCellIds): WipRefSweep {
  const out: WipRefSweep = { dropped: [], migrated: [] };
  const listed = tryGit(originRepo, ["for-each-ref", "--format=%(refname) %(objectname)", `${WIP_NS}/`]);
  if (listed.status !== 0 || scopes.length === 0) return out;
  const savedBranches = tryGit(originRepo, ["for-each-ref", "--format=%(refname) %(objectname)", `${WIP_BRANCH_NS}/`]);
  if (savedBranches.status === 0) {
    const ownedScopes = new Set(scopes.map((scope) => refSegment(scope, "node")));
    const liveSegments = new Set([...liveCellIds].map((id) => refSegment(id, "cell")));
    for (const line of savedBranches.stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
      const [ref, sha] = line.split(" ") as [string, string];
      const parts = ref.slice(WIP_BRANCH_NS.length + 1).split("/");
      if (parts.length < 3 || !ownedScopes.has(parts[0]!) || liveSegments.has(parts[1]!)) continue;
      if (tryGit(originRepo, ["update-ref", "-d", ref, sha]).status === 0) out.dropped.push(ref);
    }
  }
  const current = refSegment(scopes[0]!, "node");
  const owned = new Set(scopes.map((scope) => refSegment(scope, "node")));
  const live = new Map([...liveCellIds].map((id) => [refSegment(id, "cell"), id] as const));
  const mine = new Set([...ownedCellIds].map((id) => refSegment(id, "cell")));
  for (const line of listed.stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const [ref, sha] = line.split(" ") as [string, string];
    const parts = ref.slice(WIP_NS.length + 1).split("/");
    if (parts.length === 1) {
      const segment = parts[0]!;
      if (!mine.has(segment)) continue;
      const cellId = live.get(segment);
      if (cellId === undefined) {
        if (tryGit(originRepo, ["update-ref", "-d", ref, sha]).status === 0) out.dropped.push(ref);
        continue;
      }
      const scoped = wipRefFor(current, cellId);
      if (tryGit(originRepo, ["update-ref", scoped, sha]).status === 0 && tryGit(originRepo, ["update-ref", "-d", ref, sha]).status === 0) out.migrated.push(ref);
      continue;
    }
    if (parts.length !== 2 || !owned.has(parts[0]!) || live.has(parts[1]!)) continue;
    if (tryGit(originRepo, ["update-ref", "-d", ref]).status === 0) out.dropped.push(ref);
  }
  return out;
}

export type WipRestoreSkip = "invalid_sha" | "nothing_to_restore" | "no_head" | "wip_unreachable" | "head_mismatch" | "space_dirty";

export function adoptWipRef(originRepo: string, node: string, cellId: string, sha: string, parentSha: string): "adopted" | "missing" | "parent_mismatch" | "failed" {
  if (!SHA.test(sha) || !SHA.test(parentSha)) return "failed";
  if (tryGit(originRepo, ["cat-file", "-e", `${sha}^{commit}`]).status !== 0) return "missing";
  if (sha !== parentSha && revParse(originRepo, `${sha}^`) !== parentSha) return "parent_mismatch";
  return tryGit(originRepo, ["update-ref", wipRefFor(node, cellId), sha]).status === 0 ? "adopted" : "failed";
}

export function restoreWip(spaceDir: string, originRepo: string, node: string, cellId: string, sha: string): { restored: boolean; reason: WipRestoreSkip | null } {
  if (!SHA.test(sha)) return { restored: false, reason: "invalid_sha" };
  const head = revParse(spaceDir, "HEAD");
  if (head == null) return { restored: false, reason: "no_head" };
  if (sha === head) return { restored: false, reason: "nothing_to_restore" };
  if (tryGit(spaceDir, ["cat-file", "-e", `${sha}^{commit}`]).status !== 0) {
    const fetched = tryGit(spaceDir, ["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", originRepo, wipRefFor(node, cellId)], { timeoutMs: 120_000 });
    if (fetched.status !== 0 || tryGit(spaceDir, ["cat-file", "-e", `${sha}^{commit}`]).status !== 0) return { restored: false, reason: "wip_unreachable" };
  }
  if (revParse(spaceDir, `${sha}^`) !== head) return { restored: false, reason: "head_mismatch" };
  if (tryGit(spaceDir, ["status", "--porcelain", "--untracked-files=normal"]).stdout.trim().length > 0) return { restored: false, reason: "space_dirty" };
  must(spaceDir, ["read-tree", "-m", "-u", sha], "restore");
  must(spaceDir, ["reset", "--quiet"], "restore");
  return { restored: true, reason: null };
}

export function dropWipRef(originRepo: string, node: string, cellId: string): boolean {
  const prefix = wipBranchRefPrefix(node, cellId);
  for (const saved of listWipBranches(originRepo, node, cellId)) tryGit(originRepo, ["update-ref", "-d", `${prefix}/${saved.name}`, saved.sha]);
  if (revParse(originRepo, wipRefFor(node, cellId)) == null) return false;
  return tryGit(originRepo, ["update-ref", "-d", wipRefFor(node, cellId)]).status === 0;
}

/**
 * Recreate the Cell's saved branches in a fresh checkout. A branch that
 * already exists there is left alone. Returns the names created.
 */
export function restoreWipBranches(spaceDir: string, originRepo: string, node: string, cellId: string): string[] {
  const saved = listWipBranches(originRepo, node, cellId);
  if (saved.length === 0) return [];
  const existing = new Set(localBranches(spaceDir).map((b) => b.name));
  const missing = saved.filter((b) => !existing.has(b.name));
  if (missing.length === 0) return [];
  const prefix = wipBranchRefPrefix(node, cellId);
  const fetched = tryGit(spaceDir, ["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", originRepo, ...missing.map((b) => `+${prefix}/${b.name}:${prefix}/${b.name}`)], { timeoutMs: 120_000 });
  if (fetched.status !== 0) return [];
  const created: string[] = [];
  for (const b of missing) {
    if (tryGit(spaceDir, ["update-ref", `refs/heads/${b.name}`, b.sha, ""]).status === 0) created.push(b.name);
    tryGit(spaceDir, ["update-ref", "-d", `${prefix}/${b.name}`]);
  }
  return created;
}
