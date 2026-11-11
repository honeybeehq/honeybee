import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { revParse, tryGit } from "./git.ts";
import { DEFAULT_LEFTOVER_PATTERNS, leftoverTopLevels } from "./leftovers.ts";
import { workingTreeStatus, type WorkingTreeStatus } from "./remove.ts";

export const WORK_RECORD_VERSION = 1;
const SHA = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const CELL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const LARGEST = 5;
const WORK_REF = "refs/hive/work";
const INDEX_REF = "refs/hive/index";
const HEAD_REF = "refs/hive/head";
const RESTORE_NS = "refs/hive/restore";

export type WorkStage = "measure" | "bundle" | "verify" | "write" | "restore";

export class WorkError extends Error {
  readonly stage: WorkStage;
  readonly reason: string;
  constructor(stage: WorkStage, reason: string, detail?: string) {
    super(`work ${stage}: ${reason}${detail ? `: ${detail}` : ""}`);
    this.name = "WorkError";
    this.stage = stage;
    this.reason = reason;
  }
}

export function cellWorkRootForCells(cellsRoot: string): string {
  return join(dirname(resolve(cellsRoot)), "cell-work");
}

export function workBundlePaths(workRoot: string, cellId: string): { bundle: string; record: string } {
  if (!CELL_ID.test(cellId)) throw new WorkError("write", "invalid_cell_id", cellId);
  return { bundle: join(workRoot, `${cellId}.bundle`), record: join(workRoot, `${cellId}.json`) };
}

export const WORK_REFUSALS = ["no_head", "operation_in_progress", "unmerged_index", "sparse_checkout", "partial_clone", "shallow_clone"] as const;
export type WorkRefusal = (typeof WORK_REFUSALS)[number];

export interface WorkMeasure {
  commits: number;
  paths: number;
  modified: number;
  untracked: number;
  capturedBytes: number;
  largest: Array<{ path: string; bytes: number }>;
  refusal: WorkRefusal | null;
  refusalDetail: string | null;
}

export interface WorkBundleRecord {
  version: typeof WORK_RECORD_VERSION;
  cellId: string;
  createdAt: number;
  head: { sha: string; branch: string | null };
  branches: Array<{ name: string; sha: string }>;
  work: { sha: string; tree: string } | null;
  index: { sha: string | null; tree: string };
  prerequisites: string[];
  excluded: string[];
  infoExclude: string | null;
  commits: number;
  paths: number;
  capturedBytes: number;
  bundleBytes: number;
  elapsedMs: number;
}

export interface WorkRestoreOutcome {
  status: "restored" | "skipped" | "failed";
  verified: boolean;
  reason: string | null;
  commits: number;
  paths: number;
}

export function workNeeded(measure: Pick<WorkMeasure, "commits" | "paths">): boolean {
  return measure.commits > 0 || measure.paths > 0;
}

function must(cwd: string, args: string[], stage: WorkStage, opts: { env?: Record<string, string>; input?: string; timeoutMs?: number } = {}): string {
  const res = tryGit(cwd, args, opts);
  if (res.status !== 0) throw new WorkError(stage, "git_failed", `git ${args.join(" ")} exited ${res.status}: ${res.stderr.trim()}`);
  return res.stdout.trim();
}

function gitPath(repo: string, name: string): string | null {
  const res = tryGit(repo, ["rev-parse", "--path-format=absolute", "--git-path", name]);
  return res.status === 0 ? res.stdout.trim() : null;
}

function alternatesValue(dirs: string[]): string {
  return dirs.map((d) => (d.includes(delimiter) || d.startsWith('"') ? `"${d.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : d)).join(delimiter);
}

const IN_PROGRESS_MARKERS = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-merge", "rebase-apply"] as const;

/** Three git calls: the paths of every marker, the unmerged entries, the config keys a bundle cannot carry. */
export function workRefusal(spaceDir: string): { refusal: WorkRefusal; detail: string | null } | null {
  const names = [...IN_PROGRESS_MARKERS, "info/sparse-checkout", "shallow"];
  const located = tryGit(spaceDir, ["rev-parse", "--path-format=absolute", "--verify", "--quiet", "HEAD^{commit}", ...names.flatMap((n) => ["--git-path", n])]);
  if (located.status !== 0) return { refusal: "no_head", detail: null };
  const paths = located.stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (paths.length !== names.length + 1 || !SHA.test(paths[paths.length - 1] ?? "")) return { refusal: "no_head", detail: null };
  const pathOf = (name: string) => paths[names.indexOf(name)] ?? "";
  for (const marker of IN_PROGRESS_MARKERS) if (existsSync(pathOf(marker))) return { refusal: "operation_in_progress", detail: marker };
  const unmerged = tryGit(spaceDir, ["ls-files", "-u", "-z"]);
  if (unmerged.status !== 0 || unmerged.stdout.length > 0) return { refusal: "unmerged_index", detail: null };
  const config = tryGit(spaceDir, ["config", "--get-regexp", "^(core\\.sparsecheckout|extensions\\.partialclone|remote\\..*\\.promisor)$"]);
  const keys = config.status === 0 ? config.stdout.toLowerCase() : "";
  if (/^core\.sparsecheckout true$/m.test(keys) || existsSync(pathOf("info/sparse-checkout"))) return { refusal: "sparse_checkout", detail: null };
  if (/^extensions\.partialclone /m.test(keys) || /^remote\..*\.promisor true$/m.test(keys)) return { refusal: "partial_clone", detail: null };
  if (existsSync(pathOf("shallow"))) return { refusal: "shallow_clone", detail: null };
  return null;
}

function apparentBytes(path: string): number {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.size;
  let total = 0;
  const stack = [path];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry === ".git") continue;
      const child = join(current, entry);
      let info;
      try {
        info = lstatSync(child);
      } catch {
        continue;
      }
      if (info.isDirectory()) stack.push(child);
      else total += info.size;
    }
  }
  return total;
}

function stripSlash(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

/** Shas of every origin ref (peeled) that the Cell's object store holds: the boundary of what is work. */
export function originBoundary(spaceDir: string, originRepo: string): string[] {
  const listed = tryGit(originRepo, ["for-each-ref", "--format=%(objectname) %(*objectname)"]);
  if (listed.status !== 0) return [];
  const candidates = new Set<string>();
  for (const line of listed.stdout.split("\n")) {
    const [sha, peeled] = line.trim().split(" ");
    const pick = peeled && SHA.test(peeled) ? peeled : sha;
    if (pick && SHA.test(pick)) candidates.add(pick);
  }
  const head = revParse(originRepo, "HEAD");
  if (head) candidates.add(head);
  if (candidates.size === 0) return [];
  const check = tryGit(spaceDir, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], { input: [...candidates].join("\n") + "\n" });
  if (check.status !== 0) return [];
  const present: string[] = [];
  for (const line of check.stdout.split("\n")) {
    const [sha, type] = line.trim().split(" ");
    if (sha && type === "commit") present.push(sha);
  }
  return present;
}

function countLocalCommits(spaceDir: string, boundary: string[]): number {
  const res = tryGit(spaceDir, ["rev-list", "--count", "--branches", "HEAD", "--stdin"], { input: boundary.map((sha) => `^${sha}\n`).join("") });
  if (res.status !== 0) return 0;
  const n = Number.parseInt(res.stdout.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

export function measureWork(
  spaceDir: string,
  originRepo: string | null,
  opts: { tree?: WorkingTreeStatus; leftoverPatterns?: readonly string[] } = {},
): WorkMeasure {
  const tree = opts.tree ?? workingTreeStatus(spaceDir, opts.leftoverPatterns ?? DEFAULT_LEFTOVER_PATTERNS);
  const sized: Array<{ path: string; bytes: number }> = [];
  for (const path of tree.modified) sized.push({ path, bytes: apparentBytes(join(spaceDir, path)) });
  for (const path of tree.untracked) sized.push({ path: stripSlash(path), bytes: apparentBytes(join(spaceDir, path)) });
  const capturedBytes = sized.reduce((sum, e) => sum + e.bytes, 0);
  const largest = [...sized].sort((a, b) => b.bytes - a.bytes || (a.path < b.path ? -1 : 1)).slice(0, LARGEST);
  const commits = originRepo && existsSync(originRepo) ? countLocalCommits(spaceDir, originBoundary(spaceDir, originRepo)) : 0;
  const refused = commits > 0 || sized.length > 0 ? workRefusal(spaceDir) : null;
  return {
    commits,
    paths: sized.length,
    modified: tree.modified.length,
    untracked: tree.untracked.length,
    capturedBytes,
    largest,
    refusal: refused?.refusal ?? null,
    refusalDetail: refused?.detail ?? null,
  };
}

function seedIndex(spaceDir: string, index: string, env: Record<string, string>, stage: WorkStage): void {
  rmSync(index, { force: true });
  const real = gitPath(spaceDir, "index");
  if (real && existsSync(real)) {
    try {
      copyFileSync(real, index);
      const written = statSync(real);
      utimesSync(index, written.atime, written.mtime);
    } catch {
      rmSync(index, { force: true });
    }
  }
  if (!existsSync(index)) must(spaceDir, ["read-tree", "HEAD"], stage, { env });
}

function localBranches(repo: string): Array<{ name: string; sha: string }> {
  const res = tryGit(repo, ["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads/"]);
  if (res.status !== 0) return [];
  const out: Array<{ name: string; sha: string }> = [];
  for (const line of res.stdout.split("\n")) {
    const nul = line.indexOf("\0");
    if (nul <= 0) continue;
    const name = line.slice(0, nul);
    const sha = line.slice(nul + 1).trim();
    if (name.startsWith("refs/heads/") && SHA.test(sha)) out.push({ name: name.slice("refs/heads/".length), sha });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}

function headOf(repo: string): { sha: string; branch: string | null } | null {
  const sha = revParse(repo, "HEAD");
  if (sha == null) return null;
  const symbolic = tryGit(repo, ["symbolic-ref", "--quiet", "HEAD"]);
  const ref = symbolic.status === 0 ? symbolic.stdout.trim() : "";
  return { sha, branch: ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null };
}

/** The working tree as a tree object, built through a temporary index; the Cell's own index is never written. */
function workingTreeObject(spaceDir: string, index: string, env: Record<string, string>, excluded: readonly string[], stage: WorkStage): string {
  seedIndex(spaceDir, index, env, stage);
  const add = ["add", "-A", "--", ".", ...excluded.map((top) => `:(exclude,literal)${top}`)];
  if (tryGit(spaceDir, add, { env }).status !== 0) {
    rmSync(index, { force: true });
    must(spaceDir, ["read-tree", "HEAD"], stage, { env });
    must(spaceDir, add, stage, { env });
  }
  return must(spaceDir, ["write-tree"], stage, { env });
}

function stagedTreeObject(spaceDir: string, index: string, env: Record<string, string>, stage: WorkStage): string {
  rmSync(index, { force: true });
  const real = gitPath(spaceDir, "index");
  if (real && existsSync(real)) copyFileSync(real, index);
  else must(spaceDir, ["read-tree", "HEAD"], stage, { env });
  return must(spaceDir, ["write-tree"], stage, { env });
}

function bundlePrerequisites(bundle: string): string[] {
  const fd = openSync(bundle, "r");
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let n = 0;
    while (n < buf.length) {
      const got = readSync(fd, buf, n, buf.length - n, n);
      if (got === 0) break;
      n += got;
    }
    const text = buf.subarray(0, n).toString("latin1");
    const out: string[] = [];
    for (const line of text.split("\n")) {
      if (line.length === 0) break;
      if (line.startsWith("-")) {
        const sha = line.slice(1).split(" ")[0] ?? "";
        if (SHA.test(sha)) out.push(sha);
      }
    }
    return out;
  } finally {
    closeSync(fd);
  }
}

function fsyncPath(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } catch {
    return;
  } finally {
    closeSync(fd);
  }
}

function writeDurable(path: string, content: string): void {
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, content);
  fsyncPath(tmp);
  renameSync(tmp, path);
}

export function readWorkRecord(workRoot: string, cellId: string): WorkBundleRecord | null {
  const { record, bundle } = workBundlePaths(workRoot, cellId);
  if (!existsSync(record) || !existsSync(bundle)) return null;
  const parsed = JSON.parse(readFileSync(record, "utf8")) as Partial<WorkBundleRecord>;
  if (parsed.version !== WORK_RECORD_VERSION || parsed.cellId !== cellId || parsed.head == null || !Array.isArray(parsed.branches)) throw new WorkError("restore", "unreadable_record", record);
  return parsed as WorkBundleRecord;
}

export function dropWorkBundle(workRoot: string, cellId: string): boolean {
  const { record, bundle } = workBundlePaths(workRoot, cellId);
  let dropped = false;
  for (const path of [record, bundle]) {
    if (!existsSync(path)) continue;
    unlinkSync(path);
    dropped = true;
  }
  return dropped;
}

export function listWorkBundles(workRoot: string): Array<{ cellId: string; createdAt: number; bytes: number }> {
  if (!existsSync(workRoot)) return [];
  const out: Array<{ cellId: string; createdAt: number; bytes: number }> = [];
  for (const entry of readdirSync(workRoot)) {
    if (!entry.endsWith(".json")) continue;
    const cellId = entry.slice(0, -".json".length);
    if (!CELL_ID.test(cellId)) continue;
    try {
      const record = readWorkRecord(workRoot, cellId);
      if (record) out.push({ cellId, createdAt: record.createdAt, bytes: record.bundleBytes });
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Save everything git calls work in the Cell as one bundle under the work
 * root: every local commit no origin ref reaches, plus one commit holding
 * the working tree (tracked modifications and untracked, not ignored files)
 * and one holding the staged state when it differs. Built with a temporary
 * index and a shadow object store, so the Cell's worktree, index, HEAD,
 * refs and reflog are untouched. The bundle is verified by git, restored
 * into a throwaway repository backed by the origin's objects and compared
 * by tree hash, written with fsync and an atomic rename, and only then does
 * the record appear. The Cell is re-read afterwards: any change since the
 * capture discards the bundle and throws.
 */
export function bundleWork(
  spaceDir: string,
  originRepo: string,
  cellId: string,
  workRoot: string,
  opts: { leftoverPatterns?: readonly string[]; now?: () => number; maxBytes?: number | null; timeoutMs?: number; beforeVerify?: (bundlePath: string) => void } = {},
): WorkBundleRecord {
  const started = Date.now();
  const now = opts.now ?? Date.now;
  const refused = workRefusal(spaceDir);
  if (refused) throw new WorkError("bundle", refused.refusal, refused.detail ?? undefined);
  const head = headOf(spaceDir);
  if (head == null) throw new WorkError("bundle", "no_head");
  const cellObjects = gitPath(spaceDir, "objects");
  const originObjects = existsSync(originRepo) ? gitPath(originRepo, "objects") : null;
  if (cellObjects == null) throw new WorkError("bundle", "objects_unresolvable", spaceDir);
  if (originObjects == null) throw new WorkError("bundle", "origin_unreadable", originRepo);
  const leftoverPatterns = opts.leftoverPatterns ?? DEFAULT_LEFTOVER_PATTERNS;
  const paths = workBundlePaths(workRoot, cellId);
  mkdirSync(join(workRoot, "tmp"), { recursive: true });
  const scratch = mkdtempSync(join(workRoot, "tmp", `${cellId}-`));
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  try {
    const shadow = join(scratch, "shadow.git");
    must(scratch, ["init", "--quiet", "--bare", shadow], "bundle");
    const shadowObjects = join(shadow, "objects");
    mkdirSync(join(shadowObjects, "info"), { recursive: true });
    writeFileSync(join(shadowObjects, "info", "alternates"), `${cellObjects}\n`);
    const objectEnv = { GIT_OBJECT_DIRECTORY: shadowObjects, GIT_ALTERNATE_OBJECT_DIRECTORIES: alternatesValue([cellObjects]) };
    const inShadow = (args: string[], input?: string) => must(scratch, ["--git-dir", shadow, ...args], "bundle", { input, timeoutMs });

    const tree = workingTreeStatus(spaceDir, leftoverPatterns);
    const measure = measureWork(spaceDir, originRepo, { tree, leftoverPatterns });
    if (opts.maxBytes != null && measure.capturedBytes > opts.maxBytes) throw new WorkError("bundle", "over_cap", `${measure.capturedBytes} > ${opts.maxBytes}`);
    const excluded = leftoverTopLevels(tree.leftovers, leftoverPatterns);
    const workEnv = { ...objectEnv, GIT_INDEX_FILE: join(scratch, "work.index") };
    const stagedEnv = { ...objectEnv, GIT_INDEX_FILE: join(scratch, "staged.index") };
    const headTree = must(spaceDir, ["rev-parse", `${head.sha}^{tree}`], "bundle");
    const workTree = workingTreeObject(spaceDir, workEnv.GIT_INDEX_FILE, workEnv, excluded, "bundle");
    const indexTree = stagedTreeObject(spaceDir, stagedEnv.GIT_INDEX_FILE, stagedEnv, "bundle");
    const stamp = new Date(now()).toISOString();
    const work = workTree === headTree ? null : { sha: must(spaceDir, ["commit-tree", workTree, "-p", head.sha, "-m", `hive work ${cellId} ${stamp}`], "bundle", { env: objectEnv }), tree: workTree };
    const indexSha = indexTree === headTree || indexTree === workTree ? null : must(spaceDir, ["commit-tree", indexTree, "-p", head.sha, "-m", `hive index ${cellId} ${stamp}`], "bundle", { env: objectEnv });
    const branches = localBranches(spaceDir);
    const boundary = originBoundary(spaceDir, originRepo);
    const boundarySet = new Set(boundary);

    const refLines = [
      ...branches.map((b) => `update refs/heads/${b.name} ${b.sha}\n`),
      `update ${HEAD_REF} ${head.sha}\n`,
      ...(work ? [`update ${WORK_REF} ${work.sha}\n`] : []),
      ...(indexSha ? [`update ${INDEX_REF} ${indexSha}\n`] : []),
    ];
    inShadow(["update-ref", "--stdin"], refLines.join(""));
    const positives = [...branches.filter((b) => !boundarySet.has(b.sha)).map((b) => `refs/heads/${b.name}`), ...(boundarySet.has(head.sha) ? [] : [HEAD_REF]), ...(work ? [WORK_REF] : []), ...(indexSha ? [INDEX_REF] : [])];
    if (positives.length === 0) throw new WorkError("bundle", "nothing_to_bundle");
    const tmpBundle = join(scratch, "work.bundle");
    inShadow(["bundle", "create", "--quiet", tmpBundle, "--stdin"], [...positives.map((r) => `${r}\n`), ...boundary.map((sha) => `^${sha}\n`)].join(""));
    opts.beforeVerify?.(tmpBundle);
    inShadow(["bundle", "verify", "--quiet", tmpBundle]);
    const prerequisites = bundlePrerequisites(tmpBundle);

    const verify = join(scratch, "verify.git");
    must(scratch, ["init", "--quiet", "--bare", verify], "verify");
    mkdirSync(join(verify, "objects", "info"), { recursive: true });
    writeFileSync(join(verify, "objects", "info", "alternates"), `${originObjects}\n`);
    const inVerify = (args: string[], input?: string) => {
      const res = tryGit(scratch, ["--git-dir", verify, ...args], { input, timeoutMs });
      if (res.status !== 0) throw new WorkError("verify", "git_failed", `git ${args.join(" ")} exited ${res.status}: ${res.stderr.trim()}`);
      return res.stdout.trim();
    };
    inVerify(["bundle", "verify", "--quiet", tmpBundle]);
    inVerify(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", tmpBundle, "+refs/*:refs/*"]);
    const expectRef = (ref: string, sha: string) => {
      const got = inVerify(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
      if (got !== sha) throw new WorkError("verify", "ref_mismatch", `${ref} is ${got || "absent"}, expected ${sha}`);
    };
    for (const b of branches) if (!boundarySet.has(b.sha)) expectRef(`refs/heads/${b.name}`, b.sha);
    if (!boundarySet.has(head.sha)) expectRef(HEAD_REF, head.sha);
    if (work) {
      expectRef(WORK_REF, work.sha);
      const restoredTree = inVerify(["rev-parse", `${WORK_REF}^{tree}`]);
      if (restoredTree !== work.tree) throw new WorkError("verify", "tree_mismatch", `${restoredTree} != ${work.tree}`);
    }
    if (indexSha) {
      expectRef(INDEX_REF, indexSha);
      if (inVerify(["rev-parse", `${INDEX_REF}^{tree}`]) !== indexTree) throw new WorkError("verify", "tree_mismatch", "index");
    }
    inVerify(["rev-list", "--objects", "--missing=error", "--quiet", "--all", "--stdin"], prerequisites.map((sha) => `^${sha}\n`).join(""));

    const bundleBytes = statSync(tmpBundle).size;
    fsyncPath(tmpBundle);
    mkdirSync(workRoot, { recursive: true });
    const record: WorkBundleRecord = {
      version: WORK_RECORD_VERSION,
      cellId,
      createdAt: now(),
      head,
      branches,
      work,
      index: { sha: indexSha, tree: indexTree },
      prerequisites,
      excluded,
      infoExclude: (() => {
        const path = gitPath(spaceDir, "info/exclude");
        try {
          return path && existsSync(path) ? readFileSync(path, "utf8") : null;
        } catch {
          return null;
        }
      })(),
      commits: measure.commits,
      paths: measure.paths,
      capturedBytes: measure.capturedBytes,
      bundleBytes,
      elapsedMs: 0,
    };
    rmSync(paths.record, { force: true });
    renameSync(tmpBundle, paths.bundle);
    fsyncPath(workRoot);

    const recheckEnv = { ...objectEnv, GIT_INDEX_FILE: join(scratch, "recheck.index") };
    const again = workingTreeObject(spaceDir, recheckEnv.GIT_INDEX_FILE, recheckEnv, excluded, "write");
    const headAgain = headOf(spaceDir);
    const branchesAgain = JSON.stringify(localBranches(spaceDir));
    if (again !== workTree || headAgain?.sha !== head.sha || headAgain.branch !== head.branch || branchesAgain !== JSON.stringify(branches)) {
      unlinkSync(paths.bundle);
      throw new WorkError("write", "changed_during_capture");
    }
    record.elapsedMs = Date.now() - started;
    writeDurable(paths.record, JSON.stringify(record));
    fsyncPath(workRoot);
    return record;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function dropRestoreRefs(spaceDir: string): void {
  const listed = tryGit(spaceDir, ["for-each-ref", "--format=%(refname)", `${RESTORE_NS}/`]);
  if (listed.status !== 0) return;
  const lines = listed.stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith(`${RESTORE_NS}/`));
  if (lines.length === 0) return;
  tryGit(spaceDir, ["update-ref", "--stdin"], { input: lines.map((ref) => `delete ${ref}\n`).join("") });
}

/**
 * Put the bundled work back into a fresh checkout: local branches at their
 * recorded tips, HEAD where it was (branch or detached), the working tree as
 * captured and the index as staged, so `git status` and `git diff` read as
 * they did. The checkout must be clean and at the provisioned commit. The
 * result is verified by tree hash; only a verified restore lets the caller
 * drop the bundle.
 */
export function restoreWork(spaceDir: string, workRoot: string, cellId: string, opts: { expectedHead?: string | null; timeoutMs?: number } = {}): WorkRestoreOutcome {
  const skip = (reason: string): WorkRestoreOutcome => ({ status: "skipped", verified: false, reason, commits: 0, paths: 0 });
  let record: WorkBundleRecord | null;
  try {
    record = readWorkRecord(workRoot, cellId);
  } catch (err) {
    return { status: "failed", verified: false, reason: err instanceof Error ? err.message : String(err), commits: 0, paths: 0 };
  }
  if (record == null) return skip("no_bundle");
  const fail = (reason: string): WorkRestoreOutcome => ({ status: "failed", verified: false, reason, commits: record!.commits, paths: record!.paths });
  const { bundle } = workBundlePaths(workRoot, cellId);
  const head = revParse(spaceDir, "HEAD");
  if (head == null) return skip("no_head");
  if (opts.expectedHead != null && head !== opts.expectedHead) return skip("head_mismatch");
  const status = tryGit(spaceDir, ["status", "--porcelain", "--untracked-files=normal"]);
  if (status.status !== 0 || status.stdout.trim().length > 0) return skip("space_dirty");
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  try {
    const verify = tryGit(spaceDir, ["bundle", "verify", "--quiet", bundle], { timeoutMs });
    if (verify.status !== 0) return fail(`bundle_unverifiable: ${verify.stderr.trim()}`);
    const fetched = tryGit(spaceDir, ["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", bundle, `+refs/*:${RESTORE_NS}/*`], { timeoutMs });
    if (fetched.status !== 0) return fail(`fetch_failed: ${fetched.stderr.trim()}`);
    const present = (sha: string) => tryGit(spaceDir, ["cat-file", "-e", `${sha}^{commit}`]).status === 0;
    for (const b of record.branches) if (!present(b.sha)) return fail(`missing_commit: refs/heads/${b.name} ${b.sha}`);
    if (!present(record.head.sha)) return fail(`missing_commit: HEAD ${record.head.sha}`);
    if (record.work && !present(record.work.sha)) return fail(`missing_commit: work ${record.work.sha}`);
    if (record.index.sha && !present(record.index.sha)) return fail(`missing_commit: index ${record.index.sha}`);
    const treePresent = (tree: string) => tryGit(spaceDir, ["cat-file", "-e", `${tree}^{tree}`]).status === 0;
    if (!treePresent(record.index.tree)) return fail(`missing_tree: index ${record.index.tree}`);

    must(spaceDir, ["update-ref", "--stdin"], "restore", { input: record.branches.map((b) => `update refs/heads/${b.name} ${b.sha}\n`).join("") });
    if (record.head.branch != null) must(spaceDir, ["symbolic-ref", "HEAD", `refs/heads/${record.head.branch}`], "restore");
    else must(spaceDir, ["update-ref", "--no-deref", "HEAD", record.head.sha], "restore");
    must(spaceDir, ["reset", "--quiet", "--hard", "HEAD"], "restore", { timeoutMs });
    if (record.work) must(spaceDir, ["read-tree", "-m", "-u", record.work.tree], "restore", { timeoutMs });
    must(spaceDir, ["read-tree", record.index.tree], "restore", { timeoutMs });
    tryGit(spaceDir, ["update-index", "-q", "--refresh"], { timeoutMs });
    if (record.infoExclude != null) {
      const path = gitPath(spaceDir, "info/exclude");
      if (path) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, record.infoExclude);
      }
    }
    dropRestoreRefs(spaceDir);
    const verified = verifyRestoredWork(spaceDir, record);
    return { status: "restored", verified: verified == null, reason: verified, commits: record.commits, paths: record.paths };
  } catch (err) {
    dropRestoreRefs(spaceDir);
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** Null when the checkout reads exactly as the record says; else what differs. */
export function verifyRestoredWork(spaceDir: string, record: WorkBundleRecord): string | null {
  const head = headOf(spaceDir);
  if (head == null || head.sha !== record.head.sha || head.branch !== record.head.branch) return `head: ${JSON.stringify(head)} != ${JSON.stringify(record.head)}`;
  const branches = localBranches(spaceDir);
  for (const b of record.branches) {
    const got = branches.find((x) => x.name === b.name);
    if (got?.sha !== b.sha) return `branch ${b.name}: ${got?.sha ?? "absent"} != ${b.sha}`;
  }
  const scratch = mkdtempSync(join(tmpdir(), "hive-work-verify-"));
  try {
    const objects = gitPath(spaceDir, "objects");
    if (objects == null) return "objects_unresolvable";
    const shadowObjects = join(scratch, "objects");
    mkdirSync(join(shadowObjects, "info"), { recursive: true });
    writeFileSync(join(shadowObjects, "info", "alternates"), `${objects}\n`);
    const env = { GIT_OBJECT_DIRECTORY: shadowObjects, GIT_ALTERNATE_OBJECT_DIRECTORIES: alternatesValue([objects]), GIT_INDEX_FILE: join(scratch, "work.index") };
    const headTree = must(spaceDir, ["rev-parse", `${record.head.sha}^{tree}`], "verify");
    const expectWork = record.work?.tree ?? headTree;
    const gotWork = workingTreeObject(spaceDir, env.GIT_INDEX_FILE, env, record.excluded, "verify");
    if (gotWork !== expectWork) return `working tree ${gotWork} != ${expectWork}`;
    const stagedEnv = { ...env, GIT_INDEX_FILE: join(scratch, "staged.index") };
    const gotIndex = stagedTreeObject(spaceDir, stagedEnv.GIT_INDEX_FILE, stagedEnv, "verify");
    if (gotIndex !== record.index.tree) return `index ${gotIndex} != ${record.index.tree}`;
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
