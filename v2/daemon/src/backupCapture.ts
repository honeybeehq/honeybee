import type { VerifiedBackupReceipt } from "../../core/src/backupReceipt.ts";
/** Owner-only capture engine. No lifecycle effects, eviction authority or scheduler. */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { CellRow } from "../../core/src/types.ts";
import type { StoreBackupReceipt } from "../../core/src/storeBackup.ts";

export type BackupFailure = "invalid_request" | "busy" | "not_retained" | "source_changed" | "sensitive_file" | "database_in_tree" | "scratch_limit" | "secret_unavailable" | "tool_failed" | "interrupted" | "outcome_unknown" | "git_incomplete" | "git_listing_too_large" | "checkpoint_retired" | "service_required";
export class BackupError extends Error {
  readonly code: BackupFailure;
  readonly integrityFailure:boolean;
  constructor(code: BackupFailure,integrityFailure=false) { super(code); this.code = code;this.integrityFailure=integrityFailure; }
}
export interface BackupRequest {
  cellId: string;
  idempotencyKey: string;
  /** Non-secret rest: URL, exact repository path. HTTPS except numeric loopback fixtures. */
  repository: string;
  passwordRef: string;
  writerRef: string;
  maxScratchBytes: number;
}
export interface BackupEntry {
  /** Absolute source, restic restores it below --target with the leading / removed. */
  path: string;
  kind: "file" | "symlink" | "directory";
  mode: number;
  bytes: number;
  sha256: string;
  target?: string;
}
export interface BackupManifest {
  format: "honeybee.capture.v1";
  machine: string;
  cell: CellRow;
  generation: string;
  captureKind: "retained_checkout" | "evicted_stash";
  sourceRuntimeGeneration: number | null;
  git: { head: string; headRef: string; base: string; bundle: string; objects: string; index: string | null; refs: string; objectIdsHash: string; dependencies: [] };
  policy: { version: 1; excludedNames: string[]; evidenceNames: string[] };
  exclusions: { path: string; reason: string }[];
  databases: StoreBackupReceipt[];
  entries: BackupEntry[];
  files: number;
  bytes: number;
}
export interface BackupRecord {
  format: "honeybee.backup-draft.v1" | "honeybee.backup-record.v2";
  operationId: string;
  machine: string;
  cellId: string;
  generation: string;
  repository: string;
  manifestPath: string;
  manifestHash: string;
  snapshotId: string | null;
  state: "capturing" | "captured" | "uploading" | "snapshot_created";
  capturedAt: string | null;
  snapshotAt: string | null;
  verification: "not_verified" | "verified";
  receipt?: VerifiedBackupReceipt;
  tools: { node: string; git: string; restic: string };
  checkpointRetired?: boolean;
  processIdentity?: { pid: number; birth: string; bootId: string };
}
export type BackupResult = { status: "snapshot_created"; record: BackupRecord } | { status: "refused" | "failed" | "outcome_unknown"; reason: BackupFailure; operationId?: string };
export interface BackupTools { git: string; restic: string; hem: string }
export interface BackupOwner {
  probeOnly?: boolean;
  cell: CellRow;
  runtimeGeneration?: number | null;
  machine: string;
  operationId: string;
  scratch: string;
  keepRoot: string;
  tools: BackupTools;
  snapshotDatabases(destination: string, budget: number, signal?: AbortSignal): Promise<StoreBackupReceipt[]>;
  save(record: BackupRecord): void;
  /** Persist before returning from the synchronous spawn event. Never log child output. */
  child(pid: number | null): void;
  resolveSecret?(ref: string, field: string): Promise<string>;
  signal?: AbortSignal;
}
const EXCLUDED = ["node_modules", ".cache", ".npm", ".pnpm-store", "dist", "build", "out", "target", ".next", "updates", "honeybee-updates"];
const EVIDENCE = [".proof", ".audit", "evidence", ".evidence"];
const SECRET = /^(?:\.env(?:\..*)?|\.envrc|\.dev\.vars|auth\.json|credentials(?:\.json)?|id_(?:rsa|ed25519|ecdsa)|\.netrc|\.npmrc|\.pypirc|\.git-credentials|kubeconfig|.*\.(?:pem|key|p12))$/;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const secretRef = /^global\/fleet-backup-[a-zA-Z0-9._-]+-(?:repo-key|writer)$/;
export function validateBackupRequest(value: Record<string, unknown>): BackupRequest {
  for (const key of ["cellId", "idempotencyKey", "repository", "passwordRef", "writerRef"]) {
    if (typeof value[key] !== "string" || !(value[key] as string).length || (value[key] as string).length > 2048) throw new BackupError("invalid_request");
  }
  const repository = value.repository as string;
  let url: URL;
  try { if (!repository.startsWith("rest:")) throw 0; url = new URL(repository.slice(5)); } catch { throw new BackupError("invalid_request"); }
  if (url.username || url.password || url.search || url.hash || !/^\/[a-zA-Z0-9._/-]+\/$/.test(url.pathname)
    || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)))) throw new BackupError("invalid_request");
  if (!secretRef.test(value.passwordRef as string) || !(value.passwordRef as string).endsWith("-repo-key")
    || !secretRef.test(value.writerRef as string) || !(value.writerRef as string).endsWith("-writer")) throw new BackupError("invalid_request");
  const max = value.maxScratchBytes ?? 1024 ** 3;
  if (typeof max !== "number" || !Number.isSafeInteger(max) || max < 1024 || max > 10 * 1024 ** 3) throw new BackupError("invalid_request");
  return { cellId: value.cellId as string, idempotencyKey: value.idempotencyKey as string, repository,
    passwordRef: value.passwordRef as string, writerRef: value.writerRef as string, maxScratchBytes: max };
}
async function fileHash(path: string, signal?: AbortSignal): Promise<string> {
  const digest = createHash("sha256");
  for await (const bytes of createReadStream(path, { signal })) digest.update(bytes);
  return digest.digest("hex");
}
/** No ambient restic credentials, password commands, proxies, cloud keys or Git config. */
function toolEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" };
}
// The tool cannot start until the daemon has durably saved this guard's PID.
// Losing the IPC parent stops the tool and waits for its exit before releasing the guard.
const TOOL_GUARD = `
const {spawn}=require('node:child_process');
let child=null, stopping=false, timer=null;
function stop(){
  stopping=true;
  if(!child){process.exit(2);return;}
  child.kill('SIGTERM');
  timer=setTimeout(()=>child.kill('SIGKILL'),5000);
}
process.on('disconnect',stop);
process.on('SIGTERM',stop);
process.once('message',message=>{
  if(stopping || !process.connected) return;
  if(message.umask!==undefined)process.umask(message.umask);
  child=spawn(message.command,message.args,{env:message.env,stdio:['inherit','inherit','inherit']});
  child.once('error',()=>process.exit(2));
  child.once('close',code=>{if(timer)clearTimeout(timer);process.exit(code===0 && !stopping ? 0 : 2);});
});
`;
async function run(command: string, args: string[], owner: Pick<BackupOwner, "tools" | "child" | "signal">, options: { cwd?: string; env?: NodeJS.ProcessEnv; output?: string; limit?: number; input?: string; inputFile?: string; beforeStart?:(pid:number)=>Promise<void>;detachedGuard?:boolean;umask?:number;checkIntegrityOutput?:boolean } = {}): Promise<string> {
  if (owner.signal?.aborted) throw new BackupError("interrupted");
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, ["-e", TOOL_GUARD], { detached:options.detachedGuard??false,cwd: options.cwd, env: toolEnv(), stdio: ["pipe", "pipe", "pipe", "ipc"], signal: owner.signal, timeout: 60 * 60_000 });
    const stdin = child.stdin, stdout = child.stdout, stderr = child.stderr;
    if (!stdin || !stdout || !stderr) { child.kill(); reject(new BackupError("tool_failed")); return; }
    stdin.on("error", () => undefined);
    const input = options.inputFile ? createReadStream(options.inputFile, { signal: owner.signal }) : null;
    if (input) { input.on("error", () => child.kill("SIGTERM")); input.pipe(stdin); }
    else stdin.end(options.input);
    let bytes = 0, failed = false;
    const chunks: Buffer[] = [];
    const output = options.output ? createWriteStream(options.output, { flags: "wx", mode: 0o600 }) : null;
    const fail = () => { failed = true; child.kill("SIGTERM"); };
    output?.on("error", fail);
    child.once("spawn", () => {
      try {
        if (!child.pid) throw new BackupError("tool_failed");
        owner.child(child.pid);
        void Promise.resolve(options.beforeStart?.(child.pid)).then(()=>{if (!owner.signal?.aborted&&child.connected)child.send({ command, args, env: options.env ?? toolEnv(),umask:options.umask }, error => { if (error) fail(); });}).catch(fail);
      } catch { fail(); }
    });
    // Drain and discard diagnostics: tools and Hem may echo credentials or sensitive source names.
    let diagnostic="";const classify=(chunk:Buffer)=>{if(options.checkIntegrityOutput)diagnostic=(diagnostic+chunk.toString("utf8")).slice(-65536);};
    if(options.checkIntegrityOutput)stderr.on("data",classify);else stderr.resume();
    stdout.on("data", (chunk: Buffer) => {
      classify(chunk);bytes += chunk.length;
      if (bytes > (options.limit ?? 16 * 1024 * 1024)) { fail(); return; }
      if (output) { if (!output.write(chunk)) { stdout.pause(); output.once("drain", () => stdout.resume()); } }
      else chunks.push(chunk);
    });
    child.once("error", () => { failed = true; });
    child.once("close", (code) => {
      input?.destroy();
      try { owner.child(null); } catch { failed = true; }
      const finish = () => owner.signal?.aborted ? reject(new BackupError("interrupted"))
        : failed || code !== 0 ? reject(new BackupError(bytes > (options.limit ?? 16 * 1024 * 1024) ? options.output ? "scratch_limit" : command === owner.tools.git ? "git_listing_too_large" : "tool_failed" : "tool_failed",!!options.checkIntegrityOutput&&!failed&&code!==0&&(/(errors? (were )?found|integrity check failed|ciphertext verification failed|does not match|not found in (the )?repository|error for (pack|tree)|invalid data)/i.test(diagnostic)||!/(repository is already locked|unable to create lock|wrong password|no key found|connection refused|connection reset|context cancel|deadline exceeded|i\/o timeout|unexpected.*(403|409|429|50[0-9])|forbidden|unauthorized)/i.test(diagnostic))))
        : accept(Buffer.concat(chunks).toString("utf8"));
      if (output) output.end(finish); else finish();
    });
  });
}
async function secret(owner: Pick<BackupOwner, "tools" | "child" | "signal" | "resolveSecret">, ref: string, field: string): Promise<string> {
  try {
    const value = owner.resolveSecret ? await owner.resolveSecret(ref, field) : await run(owner.tools.hem, ["get", ref, field], owner,
      { env: { PATH: process.env.PATH, HOME: process.env.HOME, VALHALL_HEMD_ENDPOINT: process.env.VALHALL_HEMD_ENDPOINT, VALHALL_HEM_TOKEN: process.env.VALHALL_HEM_TOKEN }, limit: 8192 });
    const plain = value.replace(/\n$/, "");
    if (!plain || plain.length > 4096 || /[\x00-\x1f\x7f]/.test(plain)) throw 0;
    return plain;
  } catch { throw new BackupError(owner.signal?.aborted ? "interrupted" : "secret_unavailable"); }
}
async function entry(path: string, signal?: AbortSignal): Promise<BackupEntry> {
  if (await realpath(dirname(path)) !== dirname(path)) throw new BackupError("source_changed");
  const before = await lstat(path);
  const mode = before.mode & 0o7777;
  if (before.isSymbolicLink()) {
    const target = await readlink(path);
    return { path, kind: "symlink", mode, bytes: Buffer.byteLength(target), sha256: hash(target), target };
  }
  if (before.isDirectory()) return { path, kind: "directory", mode, bytes: 0, sha256: hash("") };
  if (!before.isFile()) throw new BackupError("source_changed");
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let sha256: string;
  try {
    const header = Buffer.alloc(128); await fd.read(header, 0, 128, 0);
    if (header.subarray(0,16).toString() === "SQLite format 3\0") throw new BackupError("database_in_tree");
    if ((basename(path) === ".gitattributes" && /\bfilter\s*=\s*lfs\b/.test(header.toString())) || header.toString().startsWith("version https://git-lfs.github.com/spec/v1")) throw new BackupError("git_incomplete");
    const digest = createHash("sha256");
    const attributes = basename(path) === ".gitattributes" || (basename(path) === "attributes" && basename(dirname(path)) === "info");
    let carry = "";
    for await (const bytes of fd.createReadStream({ start: 0, autoClose: false, signal })) {
      if (attributes) {
        const text = carry + bytes.toString();
        if (/\bfilter\s*=\s*lfs\b/.test(text)) throw new BackupError("git_incomplete");
        carry = text.slice(-64);
      }
      digest.update(bytes);
    }
    sha256 = digest.digest("hex");
  } finally { await fd.close(); }
  const after = await lstat(path);
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new BackupError("source_changed");
  return { path, kind: "file", mode, bytes: before.size, sha256 };
}
async function tree(root: string, tracked: Set<string>, owner: BackupOwner): Promise<{ entries: BackupEntry[]; exclusions: BackupManifest["exclusions"] }> {
  const entries: BackupEntry[] = [], exclusions: BackupManifest["exclusions"] = [];
  const trackedAncestors = new Set([""]);
  for (const path of tracked) {
    let parent = dirname(path);
    while (parent !== ".") { trackedAncestors.add(parent); parent = dirname(parent); }
  }
  async function walk(path: string, evidence: boolean, excluded: boolean): Promise<void> {
    if (owner.signal?.aborted) throw new BackupError("interrupted");
    const name = basename(path), rel = relative(root, path);
    if (name === ".git") { if (path !== join(owner.cell.spaceDir, ".git")) throw new BackupError("git_incomplete"); exclusions.push({ path, reason: "self_contained_git_bundle_and_object_pack" }); return; }
    const st = await lstat(path);
    const template = /\.(?:example|sample|template)$/.test(name) && tracked.has(rel);
    if (st.isFile() && SECRET.test(name) && !tracked.has(rel) && !template && (!excluded || evidence)) throw new BackupError("sensitive_file");
    evidence ||= EVIDENCE.includes(name);
    excluded ||= EXCLUDED.includes(name);
    const hasTracked = tracked.has(rel) || trackedAncestors.has(rel);
    if (excluded && !evidence && !hasTracked && ["node_modules", ".cache", ".npm", ".pnpm-store", "updates", "honeybee-updates"].includes(name)) {
      exclusions.push({ path, reason: "reproducible_dependency_cache_or_update" }); return;
    }
    if (st.isDirectory()) {
      if (!excluded || evidence || hasTracked) entries.push(await entry(path, owner.signal));
      for (const child of (await readdir(path)).sort()) await walk(join(path, child), evidence, excluded);
    } else if (excluded && !evidence && !tracked.has(rel)) exclusions.push({ path, reason: "generated_output" });
    else if (st.isFile() || st.isSymbolicLink()) entries.push(await entry(path, owner.signal));
    else exclusions.push({ path, reason: "socket_or_runtime_special_file" });
  }
  await walk(root, false, false);
  return { entries, exclusions };
}
async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.partial`;
  await writeFile(temporary, JSON.stringify(value) + "\n", { mode: 0o600 });
  const fd = await open(temporary, "r"); try { await fd.sync(); } finally { await fd.close(); }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r"); try { await directory.sync(); } finally { await directory.close(); }
}
/** Retire only generated artifacts of an owner-recorded failed operation, retaining its manifest. */
export async function retireBackupCheckpoint(root: string, operationId: string): Promise<void> {
  if (!/^[a-f0-9-]{36}$/.test(operationId)) throw new BackupError("invalid_request");
  const path = join(root, operationId);
  if (await lstat(path).then(info => info.isSymbolicLink(), error => { if (error.code === "ENOENT") return false; throw error; })) throw new BackupError("invalid_request");
  const { rm } = await import("node:fs/promises");
  for (const name of ["history.bundle", "objects.pack", "databases", "files.raw", "stash-recovery.git"]) await rm(join(path, name), { recursive: true, force: true });
}
/** Node-wide logical scratch budget; failed generations cannot accumulate without bound. */
export async function remainingBackupScratch(root: string, current: string, maximum: number): Promise<number> {
  const measure = async (path: string): Promise<number> => {
    if (basename(path) === "manifest.json") return 0; // durable catalogue metadata, not temporary bulk scratch
    const info = await lstat(path);
    if (!info.isDirectory()) return info.size;
    let bytes = 0;
    for (const name of await readdir(path)) bytes += await measure(join(path, name));
    return bytes;
  };
  await mkdir(root, { recursive: true, mode: 0o700 });
  let used = 0;
  for (const name of await readdir(root)) if (name !== current) used += await measure(join(root, name));
  const remaining = maximum - used;
  if (remaining < 1024) throw new BackupError("scratch_limit");
  return remaining;
}
/** A retry probes the repository by operation+manifest tags before issuing another backup. */
export async function captureAndSnapshot(request: BackupRequest, owner: BackupOwner, previous?: BackupRecord): Promise<BackupRecord> {
  if (owner.cell.state !== "retained" && owner.cell.state !== "evicted" && owner.cell.state !== "active") throw new BackupError("not_retained");
  const stashOnly = owner.cell.state === "evicted";
  const repositoryRoot = stashOnly ? owner.cell.originRepo : owner.cell.spaceDir;
  const root = await realpath(repositoryRoot);
  if (root !== resolve(repositoryRoot)) throw new BackupError("source_changed");
  if (stashOnly && (!owner.cell.evictedHead || await lstat(owner.cell.spaceDir).then(() => true, error => { if(error.code === "ENOENT") return false; throw error; }))) throw new BackupError("source_changed");
  if (owner.scratch === root || root.startsWith(resolve(owner.scratch) + sep) || resolve(owner.scratch).startsWith(root + sep)) throw new BackupError("invalid_request");
  await mkdir(owner.scratch, { recursive: true, mode: 0o700 });
  await chmod(owner.scratch, 0o700);
  const sourceGit = (args: string[], opts = {}) => run(owner.tools.git, ["-c", "safe.directory=" + root, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.allow=never", ...args], owner, { cwd: root, limit: 64 * 1024 * 1024, ...opts });
  const exportRepo = join(owner.scratch, "stash-recovery.git");
  const git = (args: string[], opts = {}) => sourceGit(stashOnly ? ["--git-dir=" + exportRepo, ...args] : args, opts);
  const objectList = () => git(stashOnly ? ["rev-list", "--objects", "--all", "--no-object-names"] : ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"]);
  let record = previous;
  let manifest: BackupManifest;
  const cleanScratch = async () => {
    const { rm } = await import("node:fs/promises");
    for (const path of ["history.bundle", "objects.pack", "databases", "files.raw", "stash-recovery.git"]) {
      await rm(join(owner.scratch, path), { recursive: true, force: true });
    }
  };
  if (record?.state === "snapshot_created") {
    if (await fileHash(record.manifestPath, owner.signal) !== record.manifestHash) throw new BackupError("source_changed");
    await cleanScratch();
    return record;
  }
  if (!record?.manifestHash) {
    const { rm } = await import("node:fs/promises");
    // Only this operation's incomplete scratch is replaceable; a checkpointed capture is reused.
    if (owner.scratch === root || root.startsWith(resolve(owner.scratch) + sep) || resolve(owner.scratch).startsWith(root + sep)) throw new BackupError("invalid_request");
    await rm(owner.scratch, { recursive: true, force: true });
    await mkdir(owner.scratch, { recursive: true, mode: 0o700 });
    if (stashOnly) {
      await sourceGit(["init", "--bare", exportRepo]);
      const objectDirectory = await realpath(resolve(root, (await sourceGit(["rev-parse", "--git-path", "objects"])).trim()));
      if (/[\r\n]/.test(objectDirectory)) throw new BackupError("invalid_request");
      await writeFile(join(exportRepo, "objects", "info", "alternates"), objectDirectory + "\n", { mode: 0o600 });
      try {
        await git(["update-ref", "refs/heads/recovery", owner.cell.evictedHead!]);
        await git(["update-ref", "refs/honeybee/base", owner.cell.sha]);
        await git(["symbolic-ref", "HEAD", "refs/heads/recovery"]);
      } catch { throw new BackupError("git_incomplete"); }
    }
    const head = (await git(["rev-parse", "HEAD"])).trim();
    try { await git(["cat-file", "-e", owner.cell.sha + "^{commit}"]); }
    catch { throw new BackupError("git_incomplete"); }
    const headRef = (await git(["rev-parse", "--symbolic-full-name", "HEAD"])).trim();
    const refs = await git(["for-each-ref", "--format=%(objectname) %(refname)"]);
    const indexPath = stashOnly ? null : resolve(root, (await git(["rev-parse", "--git-path", "index"])).trim());
    for (const revision of [head, owner.cell.sha]) {
      if ((await git(["ls-tree", "-r", "-z", revision])).split("\0").some(line => line.startsWith("160000 "))) throw new BackupError("git_incomplete");
      const attributes = (await git(["ls-tree", "-r", "--name-only", "-z", revision])).split("\0").filter(path => basename(path) === ".gitattributes");
      for (const path of attributes) if (/\bfilter\s*=\s*lfs\b/.test(await git(["show", revision + ":" + path]))) throw new BackupError("git_incomplete");
    }
    if (!stashOnly) {
      if ((await git(["ls-files", "--stage", "-z"])).split("\0").some(line => line.startsWith("160000 "))) throw new BackupError("git_incomplete");
      const gitDir = resolve(root, (await git(["rev-parse", "--git-dir"])).trim());
      for (const name of ["lfs", "rebase-apply", "rebase-merge", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "info/sparse-checkout"]) {
        if (await lstat(join(gitDir, name)).then(() => true, error => { if(error.code === "ENOENT") return false; throw error; })) throw new BackupError("git_incomplete");
      }
    }
    const tracked = stashOnly ? new Set<string>() : new Set((await git(["ls-files", "-z"])).split("\0").filter(Boolean));
    if (!stashOnly) {
      for (const path of [...tracked].filter(path => basename(path) === ".gitattributes")) {
        if (/\bfilter\s*=\s*lfs\b/.test(await git(["show", ":" + path]))) throw new BackupError("git_incomplete");
      }
      const attributes = resolve(root, (await git(["rev-parse", "--git-path", "info/attributes"])).trim());
      if (await lstat(attributes).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) await entry(attributes, owner.signal);
    }
    const selected = stashOnly ? { entries: [] as BackupEntry[], exclusions: [] as BackupManifest["exclusions"] } : await tree(root, tracked, owner);
    if (indexPath) selected.entries.push(await entry(indexPath, owner.signal));
    const kept = join(owner.keepRoot, owner.cell.spaceName);
    let hasKeep = false;
    try { await lstat(kept); hasKeep = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (stashOnly && !hasKeep) throw new BackupError("source_changed");
    if (hasKeep) {
      const keep = await tree(kept, new Set(), owner); selected.entries.push(...keep.entries); selected.exclusions.push(...keep.exclusions);
      selected.entries.push(await entry(`${kept}.json`, owner.signal));
    }
    selected.exclusions.push({ path: join(root, ".git/config"), reason: "credential_bearing_local_git_configuration_not_recovery_history" },
      { path: join(root, ".git/logs"), reason: "reflog_timeline_omitted_objects_preserved_for_retained_checkout" },
      { path: join(dirname(owner.keepRoot), "cell-env", owner.cell.spaceName), reason: "secret_environment_stash_requires_separate_hem_recovery" });
    const ledger = join(dirname(root), "box", "cell.json");
    if (!stashOnly) selected.entries.push(await entry(ledger, owner.signal));
    const bundle = join(owner.scratch, "history.bundle");
    // Recreate only incomplete scratch artifacts on retry; never modify the Cell.
    await rm(bundle, { force: true });
    await git(["bundle", "create", "-", "--all", "HEAD"], { output: bundle, limit: request.maxScratchBytes });
    await git(["bundle", "verify", bundle]);
    const objects = join(owner.scratch, "objects.pack");
    await rm(objects, { force: true });
    const objectIds = await objectList();
    await git(["pack-objects", "--stdout"], { input: objectIds, output: objects, limit: request.maxScratchBytes - (await stat(bundle)).size });
    const databases = await owner.snapshotDatabases(join(owner.scratch, "databases"), request.maxScratchBytes - (await stat(bundle)).size - (await stat(objects)).size, owner.signal);
    for (const db of databases) {
      if (await fileHash(db.backupPath, owner.signal) !== db.sha256 || db.integrityCheck !== "ok") throw new BackupError("source_changed");
      const st = await stat(db.backupPath);
      selected.entries.push({ path: db.backupPath, kind: "file", mode: st.mode & 0o7777, bytes: st.size, sha256: db.sha256 });
    }
    selected.entries.push(await entry(bundle, owner.signal), await entry(objects, owner.signal));
    const usage = async (path: string): Promise<number> => {
      if (owner.signal?.aborted) throw new BackupError("interrupted");
      const info = await lstat(path);
      if (!info.isDirectory()) return info.size;
      let bytes = 0;
      for (const name of await readdir(path)) bytes += await usage(join(path, name));
      return bytes;
    };
    const scratchBytes = await usage(owner.scratch);
    if (scratchBytes > request.maxScratchBytes) throw new BackupError("scratch_limit");
    selected.entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    manifest = { format: "honeybee.capture.v1", machine: owner.machine, cell: owner.cell, generation: owner.operationId, sourceRuntimeGeneration: owner.runtimeGeneration ?? null, captureKind: stashOnly ? "evicted_stash" : "retained_checkout",
      git: { head, headRef, base: owner.cell.sha, bundle, objects, index: indexPath, refs, objectIdsHash: hash(objectIds), dependencies: [] }, policy: { version: 1, excludedNames: EXCLUDED, evidenceNames: EVIDENCE },
      exclusions: selected.exclusions, databases, entries: selected.entries, files: selected.entries.filter(e => e.kind !== "directory").length,
      bytes: selected.entries.reduce((n, e) => n + e.bytes, 0) };
    const manifestPath = join(owner.scratch, "manifest.json");
    const metadataBytes = Buffer.byteLength(JSON.stringify(manifest) + "\n") + selected.entries.reduce((n,e) => n + Buffer.byteLength(e.path) + 1, Buffer.byteLength(manifestPath) + 1);
    if (scratchBytes + metadataBytes > request.maxScratchBytes) throw new BackupError("scratch_limit");
    await atomicJson(manifestPath, manifest);
    record = { format: "honeybee.backup-draft.v1", operationId: owner.operationId, machine: owner.machine, cellId: owner.cell.id, generation: owner.operationId,
      repository: request.repository, manifestPath, manifestHash: await fileHash(manifestPath, owner.signal), snapshotId: null, state: "captured",
      capturedAt: new Date().toISOString(), snapshotAt: null, verification: "not_verified",
      tools: { node: process.version, git: (await git(["--version"])).trim(), restic: (await run(owner.tools.restic, ["version"], owner)).trim() } };
    owner.save(record);
  } else {
    if (await fileHash(record.manifestPath, owner.signal) !== record.manifestHash) throw new BackupError("source_changed");
    manifest = JSON.parse(await readFile(record.manifestPath, "utf8")) as BackupManifest;
  }
  const check = async () => {
    if (stashOnly && await lstat(owner.cell.spaceDir).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) throw new BackupError("source_changed");
    for (const expected of manifest.entries) {
      // Database exports are closed files, checked by hash without treating them as a live source DB.
      if (manifest.databases.some(db => db.backupPath === expected.path)) {
        if (await fileHash(expected.path, owner.signal) !== expected.sha256) throw new BackupError("source_changed");
      } else if (JSON.stringify(await entry(expected.path, owner.signal)) !== JSON.stringify(expected)) throw new BackupError("source_changed");
    }
    if (!stashOnly) {
    const current = await tree(root, new Set((await git(["ls-files", "-z"])).split("\0").filter(Boolean)), owner);
    if (JSON.stringify(current.entries) !== JSON.stringify(manifest.entries.filter(e => e.path !== manifest.git.index && (e.path === root || e.path.startsWith(root + sep))))) {
      // Both traversals must use the same canonical path order.
      const canonical = (entries: BackupEntry[]) => JSON.stringify([...entries].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      if (canonical(current.entries) !== canonical(manifest.entries.filter(e => e.path !== manifest.git.index && (e.path === root || e.path.startsWith(root + sep))))) throw new BackupError("source_changed");
    }
    }
    const keepPath = join(owner.keepRoot, owner.cell.spaceName);
    const expectedKeep = manifest.entries.filter(e => e.path === keepPath || e.path.startsWith(keepPath + sep));
    let actualKeep: BackupEntry[] = [];
    try { actualKeep = (await tree(keepPath, new Set(), owner)).entries; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const canonicalKeep = (entries: BackupEntry[]) => JSON.stringify([...entries].sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    if (canonicalKeep(actualKeep) !== canonicalKeep(expectedKeep)) throw new BackupError("source_changed");
    if (await git(["for-each-ref", "--format=%(objectname) %(refname)"]) !== manifest.git.refs
      || hash(await objectList()) !== manifest.git.objectIdsHash) throw new BackupError("source_changed");
    if ((await git(["rev-parse", "HEAD"])).trim() !== manifest.git.head) throw new BackupError("source_changed");
  };
  await check();
  const password = await secret(owner, request.passwordRef, "password");
  const username = await secret(owner, request.writerRef, "username");
  const writerPassword = await secret(owner, request.writerRef, "password");
  const env = { ...toolEnv(), RESTIC_PASSWORD: password, RESTIC_REST_USERNAME: username, RESTIC_REST_PASSWORD: writerPassword };
  const restic = (args: string[]) => run(owner.tools.restic, ["--repo", request.repository, "--no-cache", "--limit-upload", "10240", ...args], owner, { env });
  const tag = `honeybee:${owner.operationId}:${record.manifestHash}`;
  const snapshots = JSON.parse(await restic(["snapshots", "--json", "--tag", tag])) as { id: string }[];
  if (snapshots.length > 1) throw new BackupError("outcome_unknown");
  let snapshotId = snapshots[0]?.id;
  if (!snapshotId) {
    if(owner.probeOnly)throw new BackupError("outcome_unknown");
    const files = join(owner.scratch, "files.raw");
    const paths: string[] = [];
    for (const item of manifest.entries) {
      if (item.kind !== "directory" || (await readdir(item.path)).length === 0) paths.push(item.path);
    }
    await writeFile(files, [...paths, record.manifestPath].join("\0") + "\0", { mode: 0o600 });
    record = { ...record, state: "uploading" }; owner.save(record);
    const output = await restic(["backup", "--json", "--host", owner.machine, "--tag", tag, "--files-from-raw", files]);
    const summary = output.trim().split("\n").map(line => JSON.parse(line) as { message_type?: string; snapshot_id?: string }).find(row => row.message_type === "summary");
    snapshotId = summary?.snapshot_id ?? "";
  }
  if (!snapshotId || !/^[a-f0-9]{64}$/.test(snapshotId)) throw new BackupError("tool_failed");
  await check();
  record = { ...record, state: "snapshot_created", snapshotId, snapshotAt: new Date().toISOString() };
  owner.save(record);
  await cleanScratch();
  return record;
}

// Shared constrained subprocess boundary for the independent verifier service.
export { run as runBackupTool, secret as resolveBackupSecret, toolEnv as backupToolEnv };
