/**
 * v31 Cell retention primitives: inspection facts, the eviction guard
 * (dirty / HEAD moved / shape), the atomic park, and the deferred sweep.
 * Temp dirs only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { cellPaths } from "../src/layout.ts";
import { provisionCell } from "../src/provision.ts";
import { CellDeleteRefused, CellShapeError } from "../src/remove.ts";
import {
  CellHeadMovedError,
  EVICTING_DIR,
  evictCellWrapper,
  inspectCellWrapper,
  listEvicting,
  measureDirectoryBytes,
  retentionWorkerUrl,
  sweepEvicting,
  sweepEvictingSync,
} from "../src/retention.ts";
import type { RetentionWorkerResult } from "../src/retentionWorker.ts";
import { commitInCell, g, makeRig } from "./helpers.ts";

const OPTS = { disableCow: true, useGitImages: false } as const;

function provisioned(rig: ReturnType<typeof makeRig>, id: string) {
  const req = { beeId: `bee-${id}`, originRepo: rig.origin.repo, sha: rig.origin.sha, wrapper: `w-${id}`, repoName: "repo", cellId: id };
  const cell = provisionCell(rig.cellsRoot, req, `op-${id}`, OPTS);
  return { req, cell, paths: cellPaths(rig.cellsRoot, req.wrapper, req.repoName, req.cellId) };
}

test("retention.inspect: clean provisioned Cell reports HEAD, not dirty, and du-style bytes", () => {
  const rig = makeRig();
  try {
    const { paths } = provisioned(rig, "a");
    const i = inspectCellWrapper(paths.wrapperDir);
    assert.equal(i.present, true);
    assert.equal(i.provisioned, true);
    assert.equal(i.head, rig.origin.sha);
    assert.equal(i.report?.dirty, false);
    assert.ok((i.bytes ?? 0) > 0);
    assert.equal(i.bytes, measureDirectoryBytes(paths.wrapperDir));
    const missing = inspectCellWrapper(join(rig.cellsRoot, "nope"));
    assert.equal(missing.present, false);
    assert.equal(missing.bytes, null);
    const fast = inspectCellWrapper(paths.wrapperDir, { measure: false });
    assert.equal(fast.bytes, null);
    assert.equal(fast.head, rig.origin.sha);
  } finally {
    rig.cleanup();
  }
});

test("retention.inspect: uncommitted and unlanded work are reported distinctly", () => {
  const rig = makeRig();
  try {
    const a = provisioned(rig, "a");
    writeFileSync(join(a.paths.spaceDir, "scratch.txt"), "wip\n");
    assert.equal(inspectCellWrapper(a.paths.wrapperDir, { measure: false }).report?.uncommitted, true);
    const b = provisioned(rig, "b");
    const sha = commitInCell(b.paths.spaceDir, "new.txt", "x\n", "unlanded");
    const ib = inspectCellWrapper(b.paths.wrapperDir, { measure: false });
    assert.equal(ib.report?.unpushed, true);
    assert.equal(ib.report?.uncommitted, false);
    assert.equal(ib.head, sha);
  } finally {
    rig.cleanup();
  }
});

test("retention.evict: a clean Cell is parked atomically under _evicting and the sweep deletes it", async () => {
  const rig = makeRig();
  try {
    const { paths } = provisioned(rig, "a");
    const res = evictCellWrapper(rig.cellsRoot, paths.wrapperDir, { expectedHead: rig.origin.sha, now: () => 42 });
    assert.ok(res);
    assert.equal(res.head, rig.origin.sha);
    assert.equal(res.forced, false);
    assert.equal(existsSync(paths.wrapperDir), false, "the bee's path is free immediately");
    assert.ok(res.parkedDir.startsWith(join(rig.cellsRoot, EVICTING_DIR)));
    assert.ok(existsSync(join(res.parkedDir, "box", "cell.json")), "parked wrapper is intact until swept");
    assert.deepEqual(listEvicting(rig.cellsRoot), [res.parkedDir]);
    const swept = await sweepEvicting(rig.cellsRoot);
    assert.deepEqual(swept.removed, [res.parkedDir]);
    assert.deepEqual(swept.failed, []);
    assert.equal(existsSync(res.parkedDir), false);
    assert.deepEqual(listEvicting(rig.cellsRoot), []);
    assert.equal(evictCellWrapper(rig.cellsRoot, paths.wrapperDir), null, "already absent → null");
  } finally {
    rig.cleanup();
  }
});

test("retention.evict: dirty refuses without force, force parks and reports forced", () => {
  const rig = makeRig();
  try {
    const { paths } = provisioned(rig, "a");
    writeFileSync(join(paths.spaceDir, "scratch.txt"), "wip\n");
    assert.throws(() => evictCellWrapper(rig.cellsRoot, paths.wrapperDir), CellDeleteRefused);
    assert.equal(existsSync(paths.spaceDir), true, "nothing changed on refusal");
    const forced = evictCellWrapper(rig.cellsRoot, paths.wrapperDir, { force: true });
    assert.equal(forced?.forced, true);
    assert.equal(forced?.report?.uncommitted, true);
    assert.equal(sweepEvictingSync(rig.cellsRoot).length, 1);
  } finally {
    rig.cleanup();
  }
});

test("retention.evict: HEAD moved since planning refuses; shape and containment are enforced", () => {
  const rig = makeRig();
  try {
    const { paths } = provisioned(rig, "a");
    assert.throws(() => evictCellWrapper(rig.cellsRoot, paths.wrapperDir, { expectedHead: "0000000" }), CellHeadMovedError);
    assert.equal(existsSync(paths.spaceDir), true);
    const stray = join(rig.cellsRoot, "not-a-cell");
    mkdirSync(join(stray, "plain"), { recursive: true });
    assert.throws(() => evictCellWrapper(rig.cellsRoot, stray), CellShapeError);
    assert.throws(() => evictCellWrapper(rig.cellsRoot, rig.origin.repo), CellShapeError, "outside the cells root");
    assert.equal(existsSync(join(rig.origin.repo, "README.md")), true);
    assert.equal(g(rig.origin.repo, ["rev-parse", "HEAD"]), rig.origin.sha);
  } finally {
    rig.cleanup();
  }
});

test("retention.worker: inspects a batch off-thread and reports per-wrapper errors", async () => {
  const rig = makeRig();
  try {
    const a = provisioned(rig, "a");
    const result = await new Promise<RetentionWorkerResult>((resolve, reject) => {
      const worker = new Worker(retentionWorkerUrl(), {
        execArgv: [],
        workerData: { wrappers: [{ key: "a", wrapperDir: a.paths.wrapperDir }, { key: "gone", wrapperDir: join(rig.cellsRoot, "gone") }], measure: true },
      });
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    assert.equal(result.inspections.length, 2);
    const byKey = new Map(result.inspections.map((i) => [i.key, i]));
    assert.equal(byKey.get("a")?.inspection?.head, rig.origin.sha);
    assert.equal(byKey.get("gone")?.inspection?.present, false);
  } finally {
    rig.cleanup();
  }
});
