/**
 * Cell retention primitives (v31).
 *
 * Honeybee owns Cells, so Honeybee reclaims them. The daemon's retention
 * pass decides WHICH Cells go (policy over registry + bee facts, see
 * v2/daemon/src/cellRetention.ts); this module owns the disk effects and the
 * facts a decision needs:
 *
 *  - `inspectCellWrapper`: presence, the A2 dirty report (uncommitted changes,
 *    commits the origin has never seen, unknown origin), HEAD, and du-style
 *    bytes. Read-only; safe against the live store.
 *  - `evictCellWrapper`: the reclaim. Re-runs the dirty guard on shape-checked
 *    paths, requires HEAD to still be the planned one, then PARKS the wrapper
 *    by an atomic rename into `<cells-root>/_evicting/`. The bee's path is free
 *    the instant the rename lands, so a concurrent revive re-provisions a
 *    fresh Cell at the same cwd with no race against the (slow) deletion.
 *  - `sweepEvicting`: asynchronous deletion of parked wrappers, at boot and
 *    after every pass. Anything under `_evicting/` is by construction already
 *    evicted; deleting it is idempotent.
 *  - `trimCellWrapper`: reclaim rebuildable build output (`.next`, `target`,
 *    `DerivedData`, …) from a Cell that stays in place, by the same atomic
 *    park into `_evicting/`.
 *
 * Git-ignored content falls into four classes (`classifyIgnored`): env files
 * (copied to `cell-env/`), build output (trimmed or deleted), installable
 * dependencies (`node_modules`, deleted), and everything else, which eviction
 * moves to `cell-keep/<spaceName>/` and revive moves back. Nothing that is not
 * known to be rebuildable is ever deleted by retention.
 *
 * Bytes are `du -sk` semantics (allocated blocks, symlinks not followed). On
 * APFS a pnpm `node_modules` copied by CoW shares blocks with its origin, so
 * du overstates what a deletion actually frees; callers label it as such.
 */
import { chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { GitError, revParse, tryGit } from "./git.ts";
import { CELL_SPACE_DIRECTORY, looksLikeCellWrapper } from "./layout.ts";
import { CellDeleteRefused, CellShapeError, dirtyReport, type DirtyReport } from "./remove.ts";

/** Reserved wrapper under the cells root where evicted wrappers wait for deletion. */
export const EVICTING_DIR = "_evicting";

/** The inspection worker entrypoint: source in dev/tests, the staged bundle sibling in production. */
export function retentionWorkerUrl(): URL {
  return import.meta.url.endsWith(".ts")
    ? new URL("./retentionWorker.ts", import.meta.url)
    : new URL("./retention-worker.js", import.meta.url);
}

export interface CellWrapperInspection {
  wrapperDir: string;
  /** Git-ignored `.env` / `.env.*` files (space-relative) that eviction would preserve. */
  envFiles: string[];
  /** The wrapper directory exists and has the Cell shape. */
  present: boolean;
  /** Cell-shaped but no `.git` in the space (reservation only, never provisioned). */
  provisioned: boolean;
  head: string | null;
  report: DirtyReport | null;
  /** Allocated bytes (du -sk semantics); null when absent. */
  bytes: number | null;
  trim: PathBytes[];
  keep: PathBytes[];
  /** Fastest wall-clock cost of this inspection, for pass telemetry. */
  elapsedMs: number;
}

export interface PathBytes {
  path: string;
  bytes: number | null;
}

/** `du -sk`-equivalent: allocated blocks of every entry beneath `dir`, symlinks not followed. */
export function measureDirectoryBytes(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry);
      let st;
      try {
        st = lstatSync(path);
      } catch {
        continue;
      }
      total += st.blocks * 512;
      if (st.isDirectory()) stack.push(path);
    }
  }
  try {
    total += lstatSync(dir).blocks * 512;
  } catch {
    // The root vanished mid-walk: the partial sum is still an honest lower bound.
  }
  return total;
}

export const DEFAULT_TRIM_PATTERNS: readonly string[] = [
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".parcel-cache",
  ".gradle",
  ".test-dist",
  "DerivedData",
  "target",
  "build",
  "dist",
  "out",
  "*.tsbuildinfo",
];

const INSTALL_DIRECTORY_NAMES = new Set(["node_modules", ".venv", "venv", "Pods"]);
const DISPOSABLE_FILE_NAMES = new Set([".DS_Store"]);

export interface IgnoredEntries {
  env: string[];
  trim: string[];
  keep: string[];
}

export function matchesTrimPattern(name: string, isDirectory: boolean, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => (pattern.startsWith("*.") ? !isDirectory && name.endsWith(pattern.slice(1)) : isDirectory && name === pattern));
}

export function classifyIgnored(spaceDir: string, trimPatterns: readonly string[] = DEFAULT_TRIM_PATTERNS): IgnoredEntries {
  const out: IgnoredEntries = { env: [], trim: [], keep: [] };
  if (!existsSync(join(spaceDir, ".git"))) return out;
  const args = ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--ignored=matching", "--untracked-files=normal"];
  const result = tryGit(spaceDir, args);
  if (result.status !== 0) throw new GitError(args, result.status, result.stderr);
  const records = result.stdout.split("\0");
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if ("RC".includes(record[0] ?? " ") || "RC".includes(record[1] ?? " ")) i += 1;
    if (!record.startsWith("!! ")) continue;
    const entry = record.slice(3);
    const isDirectory = entry.endsWith("/");
    const path = isDirectory ? entry.slice(0, -1) : entry;
    const name = basename(path);
    if (path.split("/").some((part) => INSTALL_DIRECTORY_NAMES.has(part))) continue;
    if (!isDirectory && DISPOSABLE_FILE_NAMES.has(name)) continue;
    if (!isDirectory && (name === ".env" || name.startsWith(".env."))) out.env.push(path);
    else if (matchesTrimPattern(name, isDirectory, trimPatterns)) out.trim.push(path);
    else out.keep.push(path);
  }
  out.env.sort();
  out.trim.sort();
  out.keep.sort();
  return out;
}

/**
 * Git-ignored `.env` and `.env.*` files at any depth (outside fully-ignored
 * directories such as node_modules, which git collapses). They are often
 * per-Cell and unique, so eviction preserves them and revive restores them.
 */
export function listIgnoredEnvFiles(spaceDir: string): string[] {
  return classifyIgnored(spaceDir).env;
}

export function measurePathBytes(path: string): number {
  const st = lstatSync(path);
  return st.isDirectory() ? measureDirectoryBytes(path) : st.blocks * 512;
}

/** Durable home for preserved env files: `<data-dir>/cell-env/<spaceName>/<relative path>`, beside cells/. */
export function cellEnvRootForCells(cellsRoot: string): string {
  return join(dirname(resolve(cellsRoot)), "cell-env");
}

function envStashDir(cellsRoot: string, spaceName: string): string {
  if (!CELL_SPACE_DIRECTORY.test(spaceName)) throw new CellShapeError(spaceName, "not a -space- name");
  return join(cellEnvRootForCells(cellsRoot), spaceName);
}

function ensureEnvParent(root: string, target: string): void {
  const rel = relative(root, target);
  if (rel === "" || rel === ".." || rel.startsWith("../")) throw new CellShapeError(target, "env path escapes its root");
  const dirs = [root];
  for (const part of relative(root, dirname(target)).split("/").filter(Boolean)) dirs.push(join(dirs[dirs.length - 1]!, part));
  for (const dir of dirs) {
    try { mkdirSync(dir); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
    if (!lstatSync(dir).isDirectory()) throw new CellShapeError(dir, "env parent is not a directory");
  }
}

function removeRestoredEnv(stash: string, source: string): void {
  unlinkSync(source);
  let dir = dirname(source);
  while (dir === stash || dir.startsWith(`${stash}/`)) {
    try { rmdirSync(dir); }
    catch (err) {
      if (["ENOTEMPTY", "EEXIST"].includes((err as NodeJS.ErrnoException).code ?? "")) return;
      throw err;
    }
    if (dir === stash) return;
    dir = dirname(dir);
  }
}

/** Copy the Cell's ignored env files out (mode 0600). Returns the space-relative paths preserved. */
export function preserveEnvFiles(cellsRoot: string, spaceDir: string, files: string[] = listIgnoredEnvFiles(spaceDir)): string[] {
  if (files.length === 0) return [];
  const stash = envStashDir(cellsRoot, basename(resolve(spaceDir)));
  for (const rel of files) {
    const target = join(stash, rel);
    const source = join(spaceDir, rel);
    mkdirSync(cellEnvRootForCells(cellsRoot), { recursive: true });
    ensureEnvParent(stash, target);
    if (!lstatSync(source).isFile()) throw new CellShapeError(source, "env source is not a regular file");
    try { copyFileSync(source, target, constants.COPYFILE_EXCL); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (!lstatSync(target).isFile() || !readFileSync(source).equals(readFileSync(target))) {
        throw new CellShapeError(target, "conflicting preserved env file; both copies retained");
      }
    }
    chmodSync(target, 0o600);
  }
  return files;
}

/** Preserved env files for a space name, space-relative; empty when none were preserved. */
export function listPreservedEnvFiles(cellsRoot: string, spaceName: string): string[] {
  const stash = envStashDir(cellsRoot, spaceName);
  if (!existsSync(stash)) return [];
  if (!lstatSync(stash).isDirectory()) throw new CellShapeError(stash, "env stash is not a directory");
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) out.push(relative(stash, path));
    }
  };
  walk(stash);
  return out.sort();
}

/**
 * Put preserved env files back into a re-provisioned space (mode 0600),
 * never overwriting a file that already exists there, retaining conflicting originals.
 * Returns the paths restored.
 */
export function restoreEnvFiles(cellsRoot: string, spaceDir: string): string[] {
  const spaceName = basename(resolve(spaceDir));
  const files = listPreservedEnvFiles(cellsRoot, spaceName);
  if (files.length === 0) return [];
  const stash = envStashDir(cellsRoot, spaceName);
  const restored: string[] = [];
  for (const rel of files) {
    const target = join(spaceDir, rel);
    ensureEnvParent(spaceDir, target);
    try { copyFileSync(join(stash, rel), target, constants.COPYFILE_EXCL); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw err;
    }
    chmodSync(target, 0o600);
    removeRestoredEnv(stash, join(stash, rel));
    restored.push(rel);
  }
  return restored;
}

export function cellKeepRootForCells(cellsRoot: string): string {
  const root = resolve(cellsRoot);
  return join(dirname(existsSync(root) ? realpathSync(root) : root), "cell-keep");
}

function keepStashDir(cellsRoot: string, spaceName: string): string {
  if (!CELL_SPACE_DIRECTORY.test(spaceName)) throw new CellShapeError(spaceName, "not a -space- name");
  return join(cellKeepRootForCells(cellsRoot), spaceName);
}

function keepManifestPath(cellsRoot: string, spaceName: string): string {
  return `${keepStashDir(cellsRoot, spaceName)}.json`;
}

interface KeepManifest {
  version: 1;
  paths: string[];
}

function readKeepManifest(path: string): KeepManifest | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<KeepManifest>;
  if (parsed.version !== 1 || !Array.isArray(parsed.paths) || !parsed.paths.every((p) => typeof p === "string")) {
    throw new CellShapeError(path, "unreadable keep manifest");
  }
  return { version: 1, paths: parsed.paths };
}

function writeKeepManifest(path: string, paths: string[]): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify({ version: 1, paths } satisfies KeepManifest));
  renameSync(temporary, path);
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function assertInsideRealDir(root: string, rel: string): string {
  const path = join(root, rel);
  const relToRoot = relative(root, path);
  if (relToRoot === "" || relToRoot === ".." || relToRoot.startsWith("../")) throw new CellShapeError(path, "path escapes its root");
  if (realpathSync(dirname(path)) !== join(realpathSync(root), dirname(relToRoot))) {
    throw new CellShapeError(path, "path has a symlinked parent");
  }
  return path;
}

function removeEmptyTree(dir: string): void {
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyTree(join(dir, entry.name));
    else if (entry.isFile() && DISPOSABLE_FILE_NAMES.has(entry.name)) unlinkSync(join(dir, entry.name));
  }
  try { rmdirSync(dir); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw err; }
}

export function hasPendingKeep(cellsRoot: string, spaceName: string): boolean {
  return existsSync(keepManifestPath(cellsRoot, spaceName)) || existsSync(keepStashDir(cellsRoot, spaceName));
}

export function listPendingKeeps(cellsRoot: string): string[] {
  const root = cellKeepRootForCells(cellsRoot);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => entry.slice(0, -".json".length))
    .filter((spaceName) => CELL_SPACE_DIRECTORY.test(spaceName))
    .sort();
}

export function listKeptPaths(cellsRoot: string, spaceName: string): string[] {
  return readKeepManifest(keepManifestPath(cellsRoot, spaceName))?.paths.filter((rel) => pathExists(join(keepStashDir(cellsRoot, spaceName), rel))) ?? [];
}

export function preserveKeptPaths(cellsRoot: string, spaceDir: string, paths: string[]): string[] {
  if (paths.length === 0) return [];
  const spaceName = basename(resolve(spaceDir));
  const stash = keepStashDir(cellsRoot, spaceName);
  const manifest = keepManifestPath(cellsRoot, spaceName);
  if (hasPendingKeep(cellsRoot, spaceName)) {
    throw new CellShapeError(stash, "kept files from an earlier eviction were never restored; restore or remove them before evicting again");
  }
  mkdirSync(cellKeepRootForCells(cellsRoot), { recursive: true });
  writeKeepManifest(manifest, paths);
  mkdirSync(stash);
  const moved: string[] = [];
  try {
    for (const rel of paths) {
      if (!pathExists(join(spaceDir, rel))) throw new CellShapeError(join(spaceDir, rel), "ignored path listed by git is not on disk");
      const source = assertInsideRealDir(spaceDir, rel);
      const target = join(stash, rel);
      ensureEnvParent(stash, target);
      renameSync(source, target);
      moved.push(rel);
    }
  } catch (err) {
    for (const rel of moved.reverse()) renameSync(join(stash, rel), join(spaceDir, rel));
    removeEmptyTree(stash);
    unlinkSync(manifest);
    throw err;
  }
  writeKeepManifest(manifest, moved);
  return moved;
}

export function restoreKeptPaths(cellsRoot: string, spaceDir: string): { restored: string[]; conflicts: string[] } {
  const spaceName = basename(resolve(spaceDir));
  const manifestPath = keepManifestPath(cellsRoot, spaceName);
  const manifest = readKeepManifest(manifestPath);
  if (manifest == null) return { restored: [], conflicts: [] };
  const stash = keepStashDir(cellsRoot, spaceName);
  const restored: string[] = [];
  const conflicts: string[] = [];
  for (const rel of manifest.paths) {
    const source = join(stash, rel);
    if (!pathExists(source)) continue;
    const target = join(spaceDir, rel);
    try {
      ensureEnvParent(spaceDir, target);
      if (pathExists(target)) {
        conflicts.push(rel);
        continue;
      }
      renameSync(source, target);
      restored.push(rel);
    } catch {
      conflicts.push(rel);
    }
  }
  if (conflicts.length === 0) {
    removeEmptyTree(stash);
    if (existsSync(stash)) throw new CellShapeError(stash, "keep stash holds files outside its manifest");
    unlinkSync(manifestPath);
  } else {
    writeKeepManifest(manifestPath, conflicts);
  }
  return { restored, conflicts };
}

export interface TrimResult {
  parkedDir: string | null;
  trimmed: string[];
  skipped: TrimSkip[];
}

export interface TrimSkip {
  path: string;
  why: string;
}

function trimPathRefusal(spaceDir: string, rel: string): string | null {
  if (!pathExists(join(spaceDir, rel))) return "absent";
  let path: string;
  try {
    path = assertInsideRealDir(spaceDir, rel);
  } catch {
    return "unsafe_path";
  }
  const st = lstatSync(path);
  if (st.isSymbolicLink()) return "symlink";
  if (st.isDirectory() && pathExists(join(path, ".git"))) return "nested_repository";
  return null;
}

function newestModification(path: string): number {
  const st = lstatSync(path);
  let newest = st.mtimeMs;
  if (st.isDirectory()) {
    for (const entry of readdirSync(path)) {
      try {
        newest = Math.max(newest, lstatSync(join(path, entry)).mtimeMs);
      } catch {
        continue;
      }
    }
  }
  return newest;
}

function trimTarget(cellsRoot: string, wrapperDir: string): { root: string; target: string; spaceDir: string } {
  const target = resolve(wrapperDir);
  const root = resolve(cellsRoot);
  if (dirname(target) !== root || basename(target) === EVICTING_DIR) {
    throw new CellShapeError(target, "not a wrapper directly under the cells root");
  }
  const spaceDir = spaceDirIn(target);
  if (spaceDir == null) throw new CellShapeError(target, "no -space- checkout inside");
  return { root, target, spaceDir };
}

export function verifyTrimPaths(
  wrapperDir: string,
  planned: string[],
  opts: { trimPatterns?: readonly string[]; modifiedSinceMs?: number } = {},
): { confirmed: string[]; skipped: TrimSkip[] } {
  const spaceDir = spaceDirIn(resolve(wrapperDir));
  if (spaceDir == null) return { confirmed: [], skipped: planned.map((path) => ({ path, why: "absent" })) };
  const current = new Set(classifyIgnored(spaceDir, opts.trimPatterns ?? DEFAULT_TRIM_PATTERNS).trim);
  const confirmed: string[] = [];
  const skipped: TrimSkip[] = [];
  for (const rel of planned) {
    const why = !current.has(rel) ? "not_ignored_build_output" : trimPathRefusal(spaceDir, rel);
    if (why != null) skipped.push({ path: rel, why });
    else if (opts.modifiedSinceMs != null && newestModification(join(spaceDir, rel)) >= opts.modifiedSinceMs) skipped.push({ path: rel, why: "recently_modified" });
    else confirmed.push(rel);
  }
  return { confirmed, skipped };
}

export function parkTrimPaths(cellsRoot: string, wrapperDir: string, confirmed: string[], opts: { now?: () => number } = {}): TrimResult {
  const { root, target, spaceDir } = trimTarget(cellsRoot, wrapperDir);
  const result: TrimResult = { parkedDir: null, trimmed: [], skipped: [] };
  for (const rel of confirmed) {
    const why = trimPathRefusal(spaceDir, rel);
    if (why != null) {
      result.skipped.push({ path: rel, why });
      continue;
    }
    if (result.parkedDir == null) {
      result.parkedDir = join(root, EVICTING_DIR, `${basename(target)}.trim.${(opts.now ?? Date.now)()}.${process.pid}`);
      mkdirSync(result.parkedDir, { recursive: true });
    }
    renameSync(join(spaceDir, rel), join(result.parkedDir, String(result.trimmed.length)));
    result.trimmed.push(rel);
  }
  return result;
}

export function trimCellWrapper(
  cellsRoot: string,
  wrapperDir: string,
  planned: string[],
  opts: { trimPatterns?: readonly string[]; modifiedSinceMs?: number; now?: () => number } = {},
): TrimResult {
  trimTarget(cellsRoot, wrapperDir);
  const verified = verifyTrimPaths(wrapperDir, planned, opts);
  const parked = parkTrimPaths(cellsRoot, wrapperDir, verified.confirmed, opts);
  return { ...parked, skipped: [...verified.skipped, ...parked.skipped] };
}

function spaceDirIn(wrapperDir: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(wrapperDir);
  } catch {
    return null;
  }
  if (!looksLikeCellWrapper(wrapperDir, entries)) return null;
  return join(wrapperDir, entries.find((e) => CELL_SPACE_DIRECTORY.test(e)) as string);
}

export function inspectCellWrapper(wrapperDir: string, opts: { measure?: boolean; trimPatterns?: readonly string[] } = {}): CellWrapperInspection {
  const started = Date.now();
  const target = resolve(wrapperDir);
  const spaceDir = spaceDirIn(target);
  if (spaceDir == null) {
    return { wrapperDir: target, envFiles: [], present: false, provisioned: false, head: null, report: null, bytes: null, trim: [], keep: [], elapsedMs: Date.now() - started };
  }
  const provisioned = existsSync(join(spaceDir, ".git"));
  const head = provisioned ? revParse(spaceDir, "HEAD") : null;
  const report = dirtyReport(target);
  const ignored = classifyIgnored(spaceDir, opts.trimPatterns ?? DEFAULT_TRIM_PATTERNS);
  const measure = opts.measure !== false;
  const sized = (paths: string[]): PathBytes[] => paths.map((path) => ({ path, bytes: measure ? measurePathBytes(join(spaceDir, path)) : null }));
  const bytes = measure ? measureDirectoryBytes(target) : null;
  return { wrapperDir: target, envFiles: ignored.env, present: true, provisioned, head, report, bytes, trim: sized(ignored.trim), keep: sized(ignored.keep), elapsedMs: Date.now() - started };
}

export interface EvictResult {
  /** Where the wrapper was parked; `sweepEvicting` deletes it. */
  parkedDir: string;
  head: string | null;
  report: DirtyReport | null;
  forced: boolean;
  /** Ignored env files copied to `cell-env/<spaceName>/` before the park; revive restores them. */
  envFiles: string[];
  keptPaths: string[];
}

export class CellHeadMovedError extends Error {
  constructor(wrapperDir: string, expected: string | null, actual: string | null) {
    super(`cell ${wrapperDir} HEAD is ${actual ?? "none"}, planned ${expected ?? "none"}; refusing to evict a Cell that changed since planning`);
    this.name = "CellHeadMovedError";
  }
}

/**
 * Park a Cell wrapper for deletion. Throws CellDeleteRefused for a dirty Cell
 * without `force`, CellHeadMovedError when `expectedHead` is given and no
 * longer matches, CellShapeError for anything not Cell-shaped. Returns null
 * when the wrapper is already absent.
 */
export function evictCellWrapper(
  cellsRoot: string,
  wrapperDir: string,
  opts: { force?: boolean; expectedHead?: string | null; now?: () => number; trimPatterns?: readonly string[] } = {},
): EvictResult | null {
  const target = resolve(wrapperDir);
  if (!existsSync(target)) return null;
  const root = resolve(cellsRoot);
  if (dirname(target) !== root || basename(target) === EVICTING_DIR) {
    throw new CellShapeError(target, "not a wrapper directly under the cells root");
  }
  const spaceDir = spaceDirIn(target);
  if (spaceDir == null) throw new CellShapeError(target, "no -space- checkout inside");
  const report = dirtyReport(target);
  const force = opts.force ?? false;
  if (report.dirty && !force) throw new CellDeleteRefused(target, report);
  const head = existsSync(join(spaceDir, ".git")) ? revParse(spaceDir, "HEAD") : null;
  if (opts.expectedHead !== undefined && head !== opts.expectedHead) {
    throw new CellHeadMovedError(target, opts.expectedHead, head);
  }
  const ignored = classifyIgnored(spaceDir, opts.trimPatterns ?? DEFAULT_TRIM_PATTERNS);
  const envFiles = preserveEnvFiles(root, spaceDir, ignored.env);
  const keptPaths = preserveKeptPaths(root, spaceDir, ignored.keep);
  const parkedDir = join(root, EVICTING_DIR, `${basename(target)}.${(opts.now ?? Date.now)()}.${process.pid}`);
  try {
    mkdirSync(dirname(parkedDir), { recursive: true });
    renameSync(target, parkedDir);
  } catch (err) {
    restoreKeptPaths(root, spaceDir);
    throw err;
  }
  return { parkedDir, head, report, forced: report.dirty, envFiles, keptPaths };
}

/** Parked wrappers awaiting deletion. */
export function listEvicting(cellsRoot: string): string[] {
  const parkRoot = join(resolve(cellsRoot), EVICTING_DIR);
  if (!existsSync(parkRoot)) return [];
  return readdirSync(parkRoot)
    .filter((entry) => {
      try {
        return statSync(join(parkRoot, entry)).isDirectory();
      } catch {
        return false;
      }
    })
    .map((entry) => join(parkRoot, entry));
}

/**
 * Delete every parked wrapper, off the event loop (libuv threadpool). Each
 * deletion is independent; one failure never stops the rest. Returns the
 * directories that were removed and the ones that failed.
 */
export async function sweepEvicting(cellsRoot: string): Promise<{ removed: string[]; failed: Array<{ dir: string; error: string }> }> {
  const removed: string[] = [];
  const failed: Array<{ dir: string; error: string }> = [];
  for (const dir of listEvicting(cellsRoot)) {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 2 });
      removed.push(dir);
    } catch (err) {
      failed.push({ dir, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { removed, failed };
}

/** Synchronous variant for tests and the CLI; production uses `sweepEvicting`. */
export function sweepEvictingSync(cellsRoot: string): string[] {
  const dirs = listEvicting(cellsRoot);
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  return dirs;
}
