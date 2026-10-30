import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { gitEnv, revParse, tryGit } from "./git.ts";

const WIP_NS = "refs/hive/wip";
const SHA = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

export function wipRefFor(cellId: string): string {
  const safe = cellId.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${WIP_NS}/${safe.length > 0 ? safe : "cell"}`;
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
    } catch {
      rmSync(index, { force: true });
    }
  }
  if (!existsSync(index)) must(spaceDir, ["read-tree", "HEAD"], stage, env);
}

function changedPaths(spaceDir: string, stage: WipStage): string[] {
  const res = tryGit(spaceDir, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]);
  if (res.status !== 0) throw new WipError(stage, `git status exited ${res.status}: ${res.stderr.trim()}`);
  return res.stdout.split("\0").filter((entry) => entry.length > 3).map((entry) => entry.slice(3));
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

function stageWorkingTree(spaceDir: string, index: string, stage: WipStage, maxFileBytes: number): { env: Record<string, string>; skipped: Array<{ path: string; bytes: number }> } {
  const env = gitEnv({ GIT_INDEX_FILE: index });
  seedIndex(spaceDir, index, stage, env);
  const skipped = oversize(spaceDir, changedPaths(spaceDir, stage), maxFileBytes);
  const add = ["add", "-A", "--", ".", ...skipped.map((s) => `:(exclude,literal)${s.path}`)];
  if (tryGit(spaceDir, add, { env }).status !== 0) {
    rmSync(index, { force: true });
    must(spaceDir, ["read-tree", "HEAD"], stage, env);
    must(spaceDir, add, stage, env);
  }
  return { env, skipped };
}

export function snapshotWip(spaceDir: string, boxDir: string, cellId: string, now: () => number = Date.now, maxFileBytes = WIP_MAX_FILE_BYTES): WipSnapshot {
  const head = revParse(spaceDir, "HEAD");
  if (head == null) throw new WipError("snapshot", "the Cell has no HEAD");
  const inProgress = operationInProgress(spaceDir);
  if (inProgress != null) throw new WipError("snapshot", `operation_in_progress:${inProgress}`);
  mkdirSync(boxDir, { recursive: true });
  const index = join(boxDir, "wip.index");
  try {
    const { env, skipped } = stageWorkingTree(spaceDir, index, "snapshot", maxFileBytes);
    const tree = must(spaceDir, ["write-tree"], "snapshot", env);
    const headTree = must(spaceDir, ["rev-parse", `${head}^{tree}`], "snapshot");
    if (tree === headTree) return { head, tree, sha: head, dirty: false, skipped, complete: skipped.length === 0 };
    const sha = must(spaceDir, ["commit-tree", tree, "-p", head, "-m", `hive wip ${cellId} ${new Date(now()).toISOString()}`], "snapshot", env);
    return { head, tree, sha, dirty: true, skipped, complete: skipped.length === 0 };
  } finally {
    rmSync(index, { force: true });
  }
}

export function pushWip(originRepo: string, spaceDir: string, cellId: string, sha: string, timeoutMs = 120_000): void {
  if (!SHA.test(sha)) throw new WipError("push", `not a commit sha: ${sha}`);
  if (!existsSync(join(originRepo, ".git")) && !existsSync(join(originRepo, "HEAD"))) throw new WipError("push", `origin ${originRepo} is not a local repository`);
  const res = tryGit(originRepo, ["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", spaceDir, `+${sha}:${wipRefFor(cellId)}`], { timeoutMs });
  if (res.status !== 0) throw new WipError("push", `fetch into origin exited ${res.status}: ${res.stderr.trim()}`);
}

export function confirmWip(originRepo: string, cellId: string, sha: string): boolean {
  if (revParse(originRepo, wipRefFor(cellId)) !== sha) return false;
  if (tryGit(originRepo, ["cat-file", "-e", `${sha}^{commit}`]).status !== 0) return false;
  const parent = revParse(originRepo, `${sha}^`);
  const connected = tryGit(originRepo, parent ? ["rev-list", "--objects", "--missing=error", "--quiet", sha, `^${parent}`] : ["rev-list", "--objects", "--missing=error", "--quiet", "--max-count=1", sha]);
  return connected.status === 0;
}

export function sweepWipRefs(originRepo: string, liveCellIds: ReadonlySet<string>): string[] {
  const listed = tryGit(originRepo, ["for-each-ref", "--format=%(refname)", `${WIP_NS}/`]);
  if (listed.status !== 0) return [];
  const live = new Set([...liveCellIds].map((id) => wipRefFor(id)));
  const dropped: string[] = [];
  for (const ref of listed.stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
    if (live.has(ref)) continue;
    if (tryGit(originRepo, ["update-ref", "-d", ref]).status === 0) dropped.push(ref);
  }
  return dropped;
}

export type WipRestoreSkip = "invalid_sha" | "nothing_to_restore" | "no_head" | "wip_unreachable" | "head_mismatch" | "space_dirty";

export function restoreWip(spaceDir: string, originRepo: string, cellId: string, sha: string): { restored: boolean; reason: WipRestoreSkip | null } {
  if (!SHA.test(sha)) return { restored: false, reason: "invalid_sha" };
  const head = revParse(spaceDir, "HEAD");
  if (head == null) return { restored: false, reason: "no_head" };
  if (sha === head) return { restored: false, reason: "nothing_to_restore" };
  if (tryGit(spaceDir, ["cat-file", "-e", `${sha}^{commit}`]).status !== 0) {
    const fetched = tryGit(spaceDir, ["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", originRepo, wipRefFor(cellId)], { timeoutMs: 120_000 });
    if (fetched.status !== 0 || tryGit(spaceDir, ["cat-file", "-e", `${sha}^{commit}`]).status !== 0) return { restored: false, reason: "wip_unreachable" };
  }
  if (revParse(spaceDir, `${sha}^`) !== head) return { restored: false, reason: "head_mismatch" };
  if (tryGit(spaceDir, ["status", "--porcelain", "--untracked-files=normal"]).stdout.trim().length > 0) return { restored: false, reason: "space_dirty" };
  must(spaceDir, ["read-tree", "-m", "-u", sha], "restore");
  must(spaceDir, ["reset", "--quiet"], "restore");
  return { restored: true, reason: null };
}

export function dropWipRef(originRepo: string, cellId: string): boolean {
  if (revParse(originRepo, wipRefFor(cellId)) == null) return false;
  return tryGit(originRepo, ["update-ref", "-d", wipRefFor(cellId)]).status === 0;
}
