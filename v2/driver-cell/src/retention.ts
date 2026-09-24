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
 *
 * Bytes are `du -sk` semantics (allocated blocks, symlinks not followed). On
 * APFS a pnpm `node_modules` copied by CoW shares blocks with its origin, so
 * du overstates what a deletion actually frees; callers label it as such.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { revParse } from "./git.ts";
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
  /** The wrapper directory exists and has the Cell shape. */
  present: boolean;
  /** Cell-shaped but no `.git` in the space (reservation only, never provisioned). */
  provisioned: boolean;
  head: string | null;
  report: DirtyReport | null;
  /** Allocated bytes (du -sk semantics); null when absent. */
  bytes: number | null;
  /** Fastest wall-clock cost of this inspection, for pass telemetry. */
  elapsedMs: number;
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

export function inspectCellWrapper(wrapperDir: string, opts: { measure?: boolean } = {}): CellWrapperInspection {
  const started = Date.now();
  const target = resolve(wrapperDir);
  const spaceDir = spaceDirIn(target);
  if (spaceDir == null) {
    return { wrapperDir: target, present: false, provisioned: false, head: null, report: null, bytes: null, elapsedMs: Date.now() - started };
  }
  const provisioned = existsSync(join(spaceDir, ".git"));
  const head = provisioned ? revParse(spaceDir, "HEAD") : null;
  const report = dirtyReport(target);
  const bytes = opts.measure === false ? null : measureDirectoryBytes(target);
  return { wrapperDir: target, present: true, provisioned, head, report, bytes, elapsedMs: Date.now() - started };
}

export interface EvictResult {
  /** Where the wrapper was parked; `sweepEvicting` deletes it. */
  parkedDir: string;
  head: string | null;
  report: DirtyReport | null;
  forced: boolean;
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
  opts: { force?: boolean; expectedHead?: string | null; now?: () => number } = {},
): EvictResult | null {
  const target = resolve(wrapperDir);
  if (!existsSync(target)) return null;
  const root = resolve(cellsRoot);
  if (!target.startsWith(`${root}/`) || basename(target) === EVICTING_DIR) {
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
  const parkRoot = join(root, EVICTING_DIR);
  mkdirSync(parkRoot, { recursive: true });
  const parkedDir = join(parkRoot, `${basename(target)}.${(opts.now ?? Date.now)()}.${process.pid}`);
  renameSync(target, parkedDir);
  return { parkedDir, head, report, forced: report.dirty };
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
