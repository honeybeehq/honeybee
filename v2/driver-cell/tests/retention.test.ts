/**
 * v31 Cell retention primitives: inspection facts, the eviction guard
 * (dirty / HEAD moved / shape), the atomic park, and the deferred sweep.
 * Temp dirs only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { cellPaths } from "../src/layout.ts";
import { provisionCell } from "../src/provision.ts";
import { CellDeleteRefused, CellShapeError } from "../src/remove.ts";
import {
  CellHeadMovedError,
  EVICTING_DIR,
  cellEnvRootForCells,
  cellKeepRootForCells,
  classifyIgnored,
  evictCellWrapper,
  inspectCellWrapper,
  listEvicting,
  listIgnoredEnvFiles,
  listKeptPaths,
  listPendingKeeps,
  listPreservedEnvFiles,
  measureDirectoryBytes,
  preserveEnvFiles,
  restoreEnvFiles,
  restoreKeptPaths,
  retentionWorkerUrl,
  sweepEvicting,
  sweepEvictingSync,
  trimCellWrapper,
  verifyTrimPaths,
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
    assert.equal(readFileSync(join(stash, ".env"), "utf8"), "TOP=1\n", "conflicting original remains recoverable");
    assert.deepEqual(listPreservedEnvFiles(rig.cellsRoot, a.paths.spaceName), [".env"]);
    assert.throws(() => preserveEnvFiles(rig.cellsRoot, space), /preserved|conflict/, "later eviction cannot overwrite the original");
    assert.deepEqual(restoreEnvFiles(rig.cellsRoot, space), [], "restore is idempotent");
  } finally {
    rig.cleanup();
  }
});


test("retention refuses an unreadable Git index before parking a Cell", () => {
  const rig = makeRig();
  try {
    const { paths } = provisioned(rig, "broken");
    writeFileSync(join(paths.spaceDir, ".git", "index"), "broken index");
    assert.throws(() => evictCellWrapper(rig.cellsRoot, paths.wrapperDir));
    assert.equal(existsSync(paths.wrapperDir), true);
  } finally { rig.cleanup(); }
});

test("retention refuses wrappers nested below the direct Cell root", () => {
  const rig = makeRig();
  try {
    const { paths } = provisioned(rig, "nested");
    const parent = join(rig.cellsRoot, "nested-parent");
    mkdirSync(parent);
    const moved = join(parent, "wrapper");
    renameSync(paths.wrapperDir, moved);
    assert.throws(() => evictCellWrapper(rig.cellsRoot, moved), CellShapeError);
    assert.equal(existsSync(moved), true);
  } finally { rig.cleanup(); }
});

test("retention env restore refuses symlinked parent directories", () => {
  const rig = makeRig();
  try {
    const { paths } = provisioned(rig, "link");
    const stash = join(cellEnvRootForCells(rig.cellsRoot), paths.spaceName, "nested");
    mkdirSync(stash, { recursive: true });
    writeFileSync(join(stash, ".env"), "PRIVATE=retained\n");
    const outside = join(rig.root, "outside-env");
    mkdirSync(outside);
    symlinkSync(outside, join(paths.spaceDir, "nested"));
    assert.throws(() => restoreEnvFiles(rig.cellsRoot, paths.spaceDir));
    assert.equal(existsSync(join(outside, ".env")), false);
    assert.equal(readFileSync(join(stash, ".env"), "utf8"), "PRIVATE=retained\n");
  } finally { rig.cleanup(); }
});


test("retention env paths retain leading whitespace and repeated preservation is idempotent", () => {
  const rig = makeRig();
  try {
    mkdirSync(join(rig.origin.repo, " leading"));
    writeFileSync(join(rig.origin.repo, " leading", "tracked.txt"), "tracked\n");
    writeFileSync(join(rig.origin.repo, ".gitignore"), ".env\n");
    g(rig.origin.repo, ["add", "."]);
    g(rig.origin.repo, ["commit", "-q", "-m", "env path"]);
    rig.origin.sha = g(rig.origin.repo, ["rev-parse", "HEAD"]);
    const { paths } = provisioned(rig, "spaces");
    writeFileSync(join(paths.spaceDir, " leading", ".env"), "VALUE=kept\n");
    assert.deepEqual(listIgnoredEnvFiles(paths.spaceDir), [" leading/.env"]);
    assert.deepEqual(preserveEnvFiles(rig.cellsRoot, paths.spaceDir), [" leading/.env"]);
    assert.deepEqual(preserveEnvFiles(rig.cellsRoot, paths.spaceDir), [" leading/.env"]);
    assert.equal(readFileSync(join(cellEnvRootForCells(rig.cellsRoot), paths.spaceName, " leading", ".env"), "utf8"), "VALUE=kept\n");
  } finally { rig.cleanup(); }
});

function ignoringOrigin(rig: ReturnType<typeof makeRig>): void {
  writeFileSync(join(rig.origin.repo, ".gitignore"), [".env", ".next/", "build/", "dist/", "node_modules/", ".venv/", ".proof/", "tmp/", "out", "*.tsbuildinfo", ".DS_Store", ""].join("\n"));
  g(rig.origin.repo, ["add", ".gitignore"]);
  g(rig.origin.repo, ["commit", "-q", "-m", "ignores"]);
  rig.origin.sha = g(rig.origin.repo, ["rev-parse", "HEAD"]);
}

function put(dir: string, rel: string, content = "x\n"): void {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), content);
}

function populateIgnored(spaceDir: string): void {
  put(spaceDir, ".env", "SECRET=1\n");
  put(spaceDir, "apps/app/.next/server/page.js");
  put(spaceDir, "apps/ios/build/App.app/App");
  put(spaceDir, "tsconfig.tsbuildinfo");
  put(spaceDir, "node_modules/pkg/index.js");
  put(spaceDir, "apps/app/node_modules/dep/index.js");
  put(spaceDir, "tools/.venv/bin/python");
  put(spaceDir, ".DS_Store");
  put(spaceDir, ".proof/shot.png", "png\n");
  put(spaceDir, "tmp/promo/final.mp4", "video\n");
  put(spaceDir, "out", "a file named like a build directory\n");
}

test("retention.classify: ignored entries split into env files, build output and kept files; installs and .DS_Store are disposable", () => {
  const rig = makeRig();
  try {
    ignoringOrigin(rig);
    const { paths } = provisioned(rig, "classify");
    populateIgnored(paths.spaceDir);
    assert.deepEqual(classifyIgnored(paths.spaceDir), {
      env: [".env"],
      trim: ["apps/app/.next", "apps/ios/build", "tsconfig.tsbuildinfo"],
      keep: [".proof", "out", "tmp"],
    });
    assert.deepEqual(classifyIgnored(paths.spaceDir, ["*.tsbuildinfo"]).trim, ["tsconfig.tsbuildinfo"]);
    const inspection = inspectCellWrapper(paths.wrapperDir);
    assert.deepEqual(inspection.trim.map((e) => e.path), ["apps/app/.next", "apps/ios/build", "tsconfig.tsbuildinfo"]);
    assert.ok(inspection.trim.every((e) => (e.bytes ?? 0) > 0));
    assert.deepEqual(inspection.keep.map((e) => e.path), [".proof", "out", "tmp"]);
    assert.equal(inspection.report?.dirty, false, "ignored files never make a Cell dirty");
    assert.deepEqual(inspectCellWrapper(paths.wrapperDir, { measure: false }).trim.map((e) => e.bytes), [null, null, null]);
    renameSync(join(paths.spaceDir, "README.md"), join(paths.spaceDir, "Rmoved.md"));
    g(paths.spaceDir, ["add", "-N", "Rmoved.md"]);
    assert.match(g(paths.spaceDir, ["status", "--porcelain"]), /^R README\.md -> Rmoved\.md$/m, "worktree rename (status ' R')");
    assert.deepEqual(classifyIgnored(paths.spaceDir).keep, [".proof", "out", "tmp"], "a worktree rename record never swallows the next entry");
  } finally {
    rig.cleanup();
  }
});

test("retention.trim: parks build output and leaves source, kept files, installs and git state untouched", async () => {
  const rig = makeRig();
  try {
    ignoringOrigin(rig);
    const { paths } = provisioned(rig, "trim");
    populateIgnored(paths.spaceDir);
    const statusBefore = g(paths.spaceDir, ["status", "--porcelain", "--ignored"]);
    const res = trimCellWrapper(rig.cellsRoot, paths.wrapperDir, ["apps/app/.next", "apps/ios/build", "tsconfig.tsbuildinfo"], { now: () => 7 });
    assert.deepEqual(res.trimmed, ["apps/app/.next", "apps/ios/build", "tsconfig.tsbuildinfo"]);
    assert.deepEqual(res.skipped, []);
    assert.ok(res.parkedDir?.startsWith(join(rig.cellsRoot, EVICTING_DIR)));
    for (const gone of ["apps/app/.next", "apps/ios/build", "tsconfig.tsbuildinfo"]) assert.equal(existsSync(join(paths.spaceDir, gone)), false, gone);
    for (const kept of ["README.md", "src/app.ts", ".env", ".proof/shot.png", "tmp/promo/final.mp4", "out", "node_modules/pkg/index.js", "apps/app/node_modules/dep/index.js"]) {
      assert.equal(existsSync(join(paths.spaceDir, kept)), true, kept);
    }
    assert.equal(g(paths.spaceDir, ["status", "--porcelain"]), "");
    assert.notEqual(g(paths.spaceDir, ["status", "--porcelain", "--ignored"]), statusBefore);
    assert.deepEqual((await sweepEvicting(rig.cellsRoot)).removed, [res.parkedDir]);
    assert.equal(existsSync(paths.spaceDir), true, "the Cell stays");
  } finally {
    rig.cleanup();
  }
});

test("retention.trim: build output modified inside the idle window is skipped as recently modified", () => {
  const rig = makeRig();
  try {
    ignoringOrigin(rig);
    const { paths } = provisioned(rig, "recent");
    put(paths.spaceDir, "apps/app/.next/page.js");
    const hourAgo = Date.now() - 3_600_000;
    assert.deepEqual(verifyTrimPaths(paths.wrapperDir, ["apps/app/.next"], { modifiedSinceMs: hourAgo }), {
      confirmed: [],
      skipped: [{ path: "apps/app/.next", why: "recently_modified" }],
    });
    const twoDaysAgo = (Date.now() - 2 * 86_400_000) / 1000;
    for (const p of ["apps/app/.next/page.js", "apps/app/.next"]) utimesSync(join(paths.spaceDir, p), twoDaysAgo, twoDaysAgo);
    assert.deepEqual(verifyTrimPaths(paths.wrapperDir, ["apps/app/.next"], { modifiedSinceMs: hourAgo }).confirmed, ["apps/app/.next"]);
  } finally {
    rig.cleanup();
  }
});

test("retention.trim: re-classifies at apply time and skips nested repositories, symlinks and paths that are no longer ignored build output", () => {
  const rig = makeRig();
  try {
    ignoringOrigin(rig);
    const { paths } = provisioned(rig, "trimguard");
    put(paths.spaceDir, "apps/app/.next/page.js");
    put(paths.spaceDir, "dist/bundle.js");
    g(join(paths.spaceDir, "dist"), ["init", "-q"]);
    const outside = join(rig.root, "outside-build");
    mkdirSync(outside);
    writeFileSync(join(outside, "precious.txt"), "not ours\n");
    mkdirSync(join(paths.spaceDir, "pkg"));
    symlinkSync(outside, join(paths.spaceDir, "pkg", "build"));
    g(paths.spaceDir, ["add", "-f", "apps/app/.next/page.js"]);
    const res = trimCellWrapper(rig.cellsRoot, paths.wrapperDir, ["apps/app/.next", "dist", "pkg/build", "../outside-build", "missing/.next"]);
    assert.deepEqual(res.trimmed, []);
    assert.equal(res.parkedDir, null);
    assert.deepEqual(res.skipped, [
      { path: "apps/app/.next", why: "not_ignored_build_output" },
      { path: "dist", why: "nested_repository" },
      { path: "pkg/build", why: "not_ignored_build_output" },
      { path: "../outside-build", why: "not_ignored_build_output" },
      { path: "missing/.next", why: "not_ignored_build_output" },
    ]);
    assert.equal(existsSync(join(paths.spaceDir, "apps/app/.next/page.js")), true);
    assert.equal(existsSync(join(paths.spaceDir, "dist/bundle.js")), true);
    assert.equal(readFileSync(join(outside, "precious.txt"), "utf8"), "not ours\n");
    assert.throws(() => trimCellWrapper(rig.cellsRoot, rig.origin.repo, ["src"]), CellShapeError);
  } finally {
    rig.cleanup();
  }
});

test("retention.evict: ignored files outside the trim patterns move to cell-keep and return on re-provision", () => {
  const rig = makeRig();
  try {
    ignoringOrigin(rig);
    const { req, paths } = provisioned(rig, "keep");
    populateIgnored(paths.spaceDir);
    const res = evictCellWrapper(rig.cellsRoot, paths.wrapperDir, { expectedHead: rig.origin.sha });
    assert.ok(res);
    assert.deepEqual(res.keptPaths, [".proof", "out", "tmp"]);
    assert.deepEqual(res.envFiles, [".env"]);
    const stash = join(cellKeepRootForCells(rig.cellsRoot), paths.spaceName);
    assert.equal(readFileSync(join(stash, "tmp/promo/final.mp4"), "utf8"), "video\n");
    assert.equal(existsSync(join(res.parkedDir, paths.spaceName, ".proof")), false, "kept files left the parked wrapper");
    assert.equal(existsSync(join(res.parkedDir, paths.spaceName, "apps/app/.next")), true, "build output goes with the wrapper");
    assert.deepEqual(listPendingKeeps(rig.cellsRoot), [paths.spaceName]);
    assert.deepEqual(listKeptPaths(rig.cellsRoot, paths.spaceName), [".proof", "out", "tmp"]);
    sweepEvictingSync(rig.cellsRoot);

    provisionCell(rig.cellsRoot, req, "op-keep-again", OPTS);
    const { restored, conflicts } = restoreKeptPaths(rig.cellsRoot, paths.spaceDir);
    assert.deepEqual(restored, [".proof", "out", "tmp"]);
    assert.deepEqual(conflicts, []);
    assert.equal(readFileSync(join(paths.spaceDir, ".proof/shot.png"), "utf8"), "png\n");
    assert.equal(readFileSync(join(paths.spaceDir, "out"), "utf8"), "a file named like a build directory\n");
    assert.equal(existsSync(stash), false);
    assert.deepEqual(listPendingKeeps(rig.cellsRoot), []);
    assert.deepEqual(restoreKeptPaths(rig.cellsRoot, paths.spaceDir), { restored: [], conflicts: [] }, "idempotent");
  } finally {
    rig.cleanup();
  }
});

test("retention.evict: a failed park moves kept files back, and an unrestored keep refuses the next eviction", () => {
  const rig = makeRig();
  try {
    ignoringOrigin(rig);
    const { req, paths } = provisioned(rig, "keepfail");
    populateIgnored(paths.spaceDir);
    writeFileSync(join(rig.cellsRoot, EVICTING_DIR), "not a directory\n");
    assert.throws(() => evictCellWrapper(rig.cellsRoot, paths.wrapperDir));
    assert.equal(readFileSync(join(paths.spaceDir, "tmp/promo/final.mp4"), "utf8"), "video\n");
    assert.equal(existsSync(join(paths.spaceDir, ".proof/shot.png")), true);
    assert.deepEqual(listPendingKeeps(rig.cellsRoot), []);
    assert.equal(existsSync(join(cellKeepRootForCells(rig.cellsRoot), paths.spaceName)), false);
    rmSync(join(rig.cellsRoot, EVICTING_DIR));

    assert.ok(evictCellWrapper(rig.cellsRoot, paths.wrapperDir));
    provisionCell(rig.cellsRoot, req, "op-keepfail-again", OPTS);
    populateIgnored(paths.spaceDir);
    assert.throws(() => evictCellWrapper(rig.cellsRoot, paths.wrapperDir), CellShapeError);
    assert.equal(existsSync(paths.spaceDir), true, "refused before the park");
    assert.equal(readFileSync(join(paths.spaceDir, "tmp/promo/final.mp4"), "utf8"), "video\n");
  } finally {
    rig.cleanup();
  }
});

test("retention.restoreKept: a path that already exists in the new space stays in cell-keep and in the manifest", () => {
  const rig = makeRig();
  try {
    ignoringOrigin(rig);
    const { req, paths } = provisioned(rig, "keepconflict");
    populateIgnored(paths.spaceDir);
    assert.ok(evictCellWrapper(rig.cellsRoot, paths.wrapperDir));
    provisionCell(rig.cellsRoot, req, "op-keepconflict-again", OPTS);
    put(paths.spaceDir, "tmp/new.txt", "new\n");
    writeFileSync(join(cellKeepRootForCells(rig.cellsRoot), paths.spaceName, ".DS_Store"), "finder\n");
    const first = restoreKeptPaths(rig.cellsRoot, paths.spaceDir);
    assert.deepEqual(first, { restored: [".proof", "out"], conflicts: ["tmp"] });
    assert.equal(readFileSync(join(paths.spaceDir, "tmp/new.txt"), "utf8"), "new\n");
    assert.deepEqual(listKeptPaths(rig.cellsRoot, paths.spaceName), ["tmp"]);
    assert.equal(readFileSync(join(cellKeepRootForCells(rig.cellsRoot), paths.spaceName, "tmp/promo/final.mp4"), "utf8"), "video\n");
    rmSync(join(paths.spaceDir, "tmp"), { recursive: true });
    assert.deepEqual(restoreKeptPaths(rig.cellsRoot, paths.spaceDir), { restored: ["tmp"], conflicts: [] });
    assert.deepEqual(listPendingKeeps(rig.cellsRoot), [], "a stray .DS_Store never strands a restored keep");
    assert.equal(existsSync(join(cellKeepRootForCells(rig.cellsRoot), paths.spaceName)), false);
  } finally {
    rig.cleanup();
  }
});

test("retention.restoreKept: a path whose parent is now unsafe becomes a conflict instead of stranding the rest", () => {
  const rig = makeRig();
  try {
    ignoringOrigin(rig);
    const { req, paths } = provisioned(rig, "keepparent");
    put(paths.spaceDir, "a/.proof/shot.png", "a\n");
    put(paths.spaceDir, "tmp/z.txt", "z\n");
    assert.deepEqual(evictCellWrapper(rig.cellsRoot, paths.wrapperDir)?.keptPaths, ["a/.proof", "tmp"]);
    provisionCell(rig.cellsRoot, req, "op-keepparent-again", OPTS);
    const outside = join(rig.root, "outside-keep");
    mkdirSync(outside);
    symlinkSync(outside, join(paths.spaceDir, "a"));
    assert.deepEqual(restoreKeptPaths(rig.cellsRoot, paths.spaceDir), { restored: ["tmp"], conflicts: ["a/.proof"] });
    assert.equal(existsSync(join(outside, ".proof")), false);
    assert.equal(readFileSync(join(cellKeepRootForCells(rig.cellsRoot), paths.spaceName, "a/.proof/shot.png"), "utf8"), "a\n");
    assert.deepEqual(listKeptPaths(rig.cellsRoot, paths.spaceName), ["a/.proof"]);
  } finally {
    rig.cleanup();
  }
});
