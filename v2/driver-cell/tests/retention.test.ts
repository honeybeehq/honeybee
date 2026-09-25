/**
 * v31 Cell retention primitives: inspection facts, the eviction guard
 * (dirty / HEAD moved / shape), the atomic park, and the deferred sweep.
 * Temp dirs only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { cellPaths } from "../src/layout.ts";
import { provisionCell } from "../src/provision.ts";
import { CellDeleteRefused, CellShapeError } from "../src/remove.ts";
import {
  CellHeadMovedError,
  EVICTING_DIR,
  cellEnvRootForCells,
  evictCellWrapper,
  inspectCellWrapper,
  listEvicting,
  listIgnoredEnvFiles,
  listPreservedEnvFiles,
  measureDirectoryBytes,
  restoreEnvFiles,
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

test("retention.dirty: a stash and a branch the agent switched away from are data, not clean", () => {
  const rig = makeRig();
  try {
    const a = provisioned(rig, "a");
    writeFileSync(join(a.paths.spaceDir, "README.md"), "# stashed change\n");
    g(a.paths.spaceDir, ["stash", "push", "-q", "-m", "wip"]);
    const ia = inspectCellWrapper(a.paths.wrapperDir, { measure: false });
    assert.equal(ia.report?.uncommitted, false);
    assert.equal(ia.report?.stashed, true);
    assert.equal(ia.report?.dirty, true);
    assert.throws(() => evictCellWrapper(rig.cellsRoot, a.paths.wrapperDir), (err: unknown) => err instanceof CellDeleteRefused && /stashed changes/.test(err.message));

    const b = provisioned(rig, "b");
    g(b.paths.spaceDir, ["checkout", "-q", "-b", "feature/x"]);
    const tip = commitInCell(b.paths.spaceDir, "feature.txt", "x\n", "on a branch");
    g(b.paths.spaceDir, ["checkout", "-q", "--detach", rig.origin.sha]);
    const ib = inspectCellWrapper(b.paths.wrapperDir, { measure: false });
    assert.equal(ib.head, rig.origin.sha, "HEAD itself is landed");
    assert.equal(ib.report?.unpushed, true);
    assert.deepEqual(ib.report?.unlandedBranches, ["feature/x"]);
    assert.throws(() => evictCellWrapper(rig.cellsRoot, b.paths.wrapperDir), (err: unknown) => err instanceof CellDeleteRefused && /unlanded branches \(feature\/x\)/.test(err.message));
    assert.equal(existsSync(b.paths.spaceDir), true);
    // Once the origin holds the branch tip, the Cell is clean again.
    g(rig.origin.repo, ["fetch", "-q", b.paths.spaceDir, `${tip}:refs/heads/landed-x`]);
    assert.deepEqual(inspectCellWrapper(b.paths.wrapperDir, { measure: false }).report?.unlandedBranches, []);
    assert.equal(inspectCellWrapper(b.paths.wrapperDir, { measure: false }).report?.dirty, false);
  } finally {
    rig.cleanup();
  }
});

test("retention.env: ignored .env files are preserved (0600) on eviction and restored into a re-provisioned space", () => {
  const rig = makeRig();
  try {
    writeFileSync(join(rig.origin.repo, ".gitignore"), ".env\n.env.*\nnode_modules/\n*.env.txt\n");
    g(rig.origin.repo, ["add", ".gitignore"]);
    g(rig.origin.repo, ["commit", "-q", "-m", "ignore env"]);
    rig.origin.sha = g(rig.origin.repo, ["rev-parse", "HEAD"]);
    const a = provisioned(rig, "a");
    const space = a.paths.spaceDir;
    mkdirSync(join(space, "apps", "web"), { recursive: true });
    mkdirSync(join(space, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(space, ".env"), "TOP=1\n");
    writeFileSync(join(space, "apps", "web", ".env.local"), "WEB=2\n");
    writeFileSync(join(space, "node_modules", "pkg", ".env"), "IGNORED_DIR=3\n");
    writeFileSync(join(space, "apps", "web", "notes.env.txt"), "not an env file\n");
    assert.deepEqual(listIgnoredEnvFiles(space), [".env", "apps/web/.env.local"]);
    const i = inspectCellWrapper(a.paths.wrapperDir, { measure: false });
    assert.equal(i.report?.dirty, false, "ignored files do not make a Cell dirty");
    assert.deepEqual(i.envFiles, [".env", "apps/web/.env.local"]);

    const res = evictCellWrapper(rig.cellsRoot, a.paths.wrapperDir, { expectedHead: rig.origin.sha });
    assert.deepEqual(res?.envFiles, [".env", "apps/web/.env.local"]);
    const stash = join(cellEnvRootForCells(rig.cellsRoot), a.paths.spaceName);
    assert.equal(readFileSync(join(stash, "apps", "web", ".env.local"), "utf8"), "WEB=2\n");
    assert.equal(statSync(join(stash, ".env")).mode & 0o777, 0o600);
    assert.deepEqual(listPreservedEnvFiles(rig.cellsRoot, a.paths.spaceName), [".env", "apps/web/.env.local"]);
    sweepEvictingSync(rig.cellsRoot);

    // Re-provision the same wrapper (as a revive would) and restore.
    const again = provisionCell(rig.cellsRoot, a.req, "op-a2", OPTS);
    assert.equal(again.replayed, false);
    writeFileSync(join(space, ".env"), "ALREADY=here\n");
    const restored = restoreEnvFiles(rig.cellsRoot, space);
    assert.deepEqual(restored, ["apps/web/.env.local"], "an existing file is never overwritten");
    assert.equal(readFileSync(join(space, ".env"), "utf8"), "ALREADY=here\n");
    assert.equal(readFileSync(join(space, "apps", "web", ".env.local"), "utf8"), "WEB=2\n");
    assert.equal(statSync(join(space, "apps", "web", ".env.local")).mode & 0o777, 0o600);
    assert.equal(existsSync(stash), false, "the stash is dropped after restore");
    assert.deepEqual(restoreEnvFiles(rig.cellsRoot, space), [], "restore is idempotent");
  } finally {
    rig.cleanup();
  }
});
