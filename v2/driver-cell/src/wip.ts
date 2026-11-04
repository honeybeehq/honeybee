import {tmpdir} from "node:os";
import {randomUUID} from "node:crypto";
import {cellGit, withCellGit, requireCellGitIdentity, type CellGitIdentity} from "./cellGit.ts";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { gitEnv, revParse, tryGit } from "./git.ts";

const WIP_NS = "refs/hive/wip";
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

export interface WipSnapshot {
  head: string;
  tree: string;
  sha: string;
  dirty: boolean;
  skipped: Array<{ path: string; bytes: number }>;
  complete: boolean;
}

const IN_PROGRESS_MARKERS = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-merge", "rebase-apply"] as const;

export function operationInProgress(spaceDir: string, identity?: CellGitIdentity): string | null {
  for (const marker of IN_PROGRESS_MARKERS) {
    const res = cellGit(requireCellGitIdentity(identity,spaceDir), ["rev-parse", "--git-path", marker]);
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

function cellMust(spaceDir: string, args: string[], stage: WipStage, identity: CellGitIdentity, indexFile?:string): string {
  const res=cellGit(identity,args,{indexFile});
  if(res.status!==0)throw new WipError(stage,`repository command exited ${res.status}`);
  return res.stdout.trim();
}

function changedPaths(spaceDir: string, stage: WipStage, identity:CellGitIdentity): string[] {
  const res = cellGit(identity, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]);
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

function stageWorkingTree(spaceDir:string,index:string,stage:WipStage,maxFileBytes:number,identity:CellGitIdentity): {skipped:Array<{path:string;bytes:number}>} {
  cellMust(spaceDir,["read-tree","HEAD"],stage,identity,index);
  const skipped=oversize(spaceDir,changedPaths(spaceDir,stage,identity),maxFileBytes);
  cellMust(spaceDir,["add","-A","--",".",...skipped.map(s=>`:(exclude,literal)${s.path}`)],stage,identity,index);
  return {skipped};
}

export function snapshotWip(spaceDir: string, boxDir: string, cellId: string, now: () => number = Date.now, maxFileBytes = WIP_MAX_FILE_BYTES, cellIdentity?:CellGitIdentity): WipSnapshot {
  const identity=requireCellGitIdentity(cellIdentity,spaceDir);
  const head = cellMust(spaceDir,["rev-parse","--verify","HEAD"],"snapshot",identity);
  if (head == null) throw new WipError("snapshot", "the Cell has no HEAD");
  const inProgress = operationInProgress(spaceDir,identity);
  if (inProgress != null) throw new WipError("snapshot", `operation_in_progress:${inProgress}`);
  const scratch=mkdtempSync(join(tmpdir(),"hive-wip-index-"));
  const index=join(scratch,"index");
  try {
    const { skipped } = stageWorkingTree(spaceDir, index, "snapshot", maxFileBytes, identity);
    const tree = cellMust(spaceDir, ["write-tree"], "snapshot", identity,index);
    const headTree = cellMust(spaceDir, ["rev-parse", `${head}^{tree}`], "snapshot",identity);
    if (tree === headTree) return { head, tree, sha: head, dirty: false, skipped, complete: skipped.length === 0 };
    const sha = cellMust(spaceDir, ["commit-tree", tree, "-p", head, "-m", `hive wip ${cellId} ${new Date(now()).toISOString()}`], "snapshot", identity,index);
    return { head, tree, sha, dirty: true, skipped, complete: skipped.length === 0 };
  } finally {
    rmSync(scratch, { recursive:true, force: true });
  }
}

export function pushWip(originRepo: string, spaceDir: string, node: string, cellId: string, sha: string, timeoutMs = 120_000, cellIdentity?:CellGitIdentity): void {
  const identity=requireCellGitIdentity(cellIdentity,spaceDir);
  if (!SHA.test(sha)) throw new WipError("push", `not a commit sha: ${sha}`);
  if (!existsSync(join(originRepo, ".git")) && !existsSync(join(originRepo, "HEAD"))) throw new WipError("push", `origin ${originRepo} is not a local repository`);
  const intake=`refs/hive/wip-intake/${randomUUID()}`;
  try {
    const res=withCellGit(identity,()=>tryGit(originRepo,["-c","fetch.fsckObjects=true","fetch","--quiet","--no-tags","--no-recurse-submodules",spaceDir,`+${sha}:${intake}`],{timeoutMs}));
    if(res.status!==0)throw new WipError("push","checked intake failed");
    must(originRepo,["update-ref",wipRefFor(node,cellId),sha],"push");
  } finally {tryGit(originRepo,["update-ref","-d",intake]);}
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

export function restoreWip(spaceDir: string, originRepo: string, node: string, cellId: string, sha: string, cellIdentity?:CellGitIdentity): { restored: boolean; reason: WipRestoreSkip | null } {
  const identity=requireCellGitIdentity(cellIdentity,spaceDir);
  if (!SHA.test(sha)) return { restored: false, reason: "invalid_sha" };
  const head = cellMust(spaceDir,["rev-parse","--verify","HEAD"],"restore",identity);
  if (head == null) return { restored: false, reason: "no_head" };
  if (sha === head) return { restored: false, reason: "nothing_to_restore" };
  if (cellGit(identity, ["cat-file", "-e", `${sha}^{commit}`]).status !== 0) {
    const fetched = cellGit(identity, ["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", originRepo, wipRefFor(node, cellId)], { timeoutMs: 15000 });
    if (fetched.status !== 0 || cellGit(identity, ["cat-file", "-e", `${sha}^{commit}`]).status !== 0) return { restored: false, reason: "wip_unreachable" };
  }
  if (cellMust(spaceDir,["rev-parse",`${sha}^`],"restore",identity) !== head) return { restored: false, reason: "head_mismatch" };
  if (cellGit(identity, ["status", "--porcelain", "--untracked-files=normal"]).stdout.trim().length > 0) return { restored: false, reason: "space_dirty" };
  cellMust(spaceDir, ["read-tree", "-m", "-u", sha], "restore",identity);
  cellMust(spaceDir, ["reset", "--quiet"], "restore",identity);
  return { restored: true, reason: null };
}

export function dropWipRef(originRepo: string, node: string, cellId: string): boolean {
  if (revParse(originRepo, wipRefFor(node, cellId)) == null) return false;
  return tryGit(originRepo, ["update-ref", "-d", wipRefFor(node, cellId)]).status === 0;
}
