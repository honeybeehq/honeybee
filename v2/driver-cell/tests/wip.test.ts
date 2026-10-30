/**
 * H3 WIP capture on a fixture origin: a snapshot commits everything that is
 * not ignored (untracked included) on top of HEAD without touching the real
 * index; the push lands it on refs/hive/wip/<cell> in the origin and read-back
 * confirms it; restore puts the files back into a clean checkout at the same
 * HEAD and refuses anywhere else; drop removes the ref.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { g, makeOrigin } from "./helpers.ts";
import { WipError, confirmWip, dropWipRef, operationInProgress, pushWip, restoreWip, snapshotWip, sweepWipRefs, wipRefFor } from "../src/wip.ts";

function clone(origin: string, root: string, name: string): string {
  const dir = join(root, name);
  g(root, ["clone", "-q", origin, dir]);
  g(dir, ["checkout", "-q", "--detach", "HEAD"]);
  return dir;
}

test("wip.0: snapshot, push, confirm, restore and drop round-trip through the origin", () => {
  const root = mkdtempSync(join(tmpdir(), "hb-wip-"));
  try {
    const origin = makeOrigin(root);
    writeFileSync(join(origin.repo, ".gitignore"), ".next/\n");
    g(origin.repo, ["add", ".gitignore"]);
    g(origin.repo, ["commit", "-q", "-m", "ignores"]);
    const head = g(origin.repo, ["rev-parse", "HEAD"]);
    const space = clone(origin.repo, root, "a-space-1");
    const box = join(root, "box");
    const cellId = "cell-1";

    const clean = snapshotWip(space, box, cellId);
    assert.equal(clean.dirty, false);
    assert.equal(clean.sha, head);
    assert.equal(clean.complete, true);

    writeFileSync(join(space, "notes.md"), "draft\n");
    writeFileSync(join(space, "src", "app.ts"), "export const version = 2;\n");
    mkdirSync(join(space, ".next"), { recursive: true });
    writeFileSync(join(space, ".next", "built.js"), "x\n");
    const snap = snapshotWip(space, box, cellId, () => 1_700_000_000_000);
    assert.equal(snap.dirty, true);
    assert.equal(snap.head, head);
    assert.notEqual(snap.sha, head);
    assert.equal(g(space, ["rev-parse", "HEAD"]), head, "the checkout's HEAD does not move");
    assert.equal(g(space, ["diff", "--cached", "--name-only"]), "", "the real index is untouched");
    const files = g(space, ["ls-tree", "-r", "--name-only", snap.tree]).split("\n");
    assert.ok(files.includes("notes.md"), "untracked files are WIP");
    assert.ok(!files.includes(".next/built.js"), "ignored files are not");
    assert.equal(g(space, ["rev-parse", `${snap.sha}^`]), head);
    assert.equal(snap.complete, true);
    assert.ok(!existsSync(join(box, "wip.index")));
    assert.equal(g(space, ["status", "--porcelain", "--untracked-files=all"]).includes("wip.index"), false);

    assert.equal(confirmWip(origin.repo, cellId, snap.sha), false, "nothing confirmed before the push");
    pushWip(origin.repo, space, cellId, snap.sha);
    assert.equal(g(origin.repo, ["rev-parse", wipRefFor(cellId)]), snap.sha);
    assert.equal(confirmWip(origin.repo, cellId, snap.sha), true);
    assert.equal(confirmWip(origin.repo, cellId, head), false, "a stale sha is not confirmed");

    writeFileSync(join(space, "big.bin"), Buffer.alloc(4096, 1));
    writeFileSync(join(space, "src", "app.ts"), Buffer.alloc(4096, 2));
    const capped = snapshotWip(space, box, cellId, Date.now, 1024);
    assert.equal(capped.complete, false, "oversize changed files make the snapshot incomplete");
    assert.deepEqual(capped.skipped.map((s) => s.path).sort(), ["big.bin", "src/app.ts"]);
    const cappedFiles = g(space, ["ls-tree", "-r", "--name-only", capped.tree]).split("\n");
    assert.ok(!cappedFiles.includes("big.bin"), "an oversize untracked file is left out");
    assert.equal(g(space, ["rev-parse", `${capped.sha}:src/app.ts`]), g(space, ["rev-parse", `${head}:src/app.ts`]), "an oversize modified tracked file keeps its HEAD content in the tree");
    rmSync(join(space, "big.bin"));
    writeFileSync(join(space, "src", "app.ts"), "export const version = 2;\n");

    const fresh = clone(origin.repo, root, "b-space-2");
    assert.deepEqual(restoreWip(fresh, origin.repo, cellId, snap.sha), { restored: true, reason: null });
    assert.equal(readFileSync(join(fresh, "notes.md"), "utf8"), "draft\n");
    assert.equal(readFileSync(join(fresh, "src", "app.ts"), "utf8"), "export const version = 2;\n");
    assert.equal(g(fresh, ["rev-parse", "HEAD"]), head, "restore leaves HEAD where the Cell was");
    assert.ok(!existsSync(join(fresh, ".next")));
    const status = g(fresh, ["status", "--porcelain", "--untracked-files=all"]).split("\n").map((l) => l.trim()).sort();
    assert.deepEqual(status, ["?? notes.md", "M src/app.ts"], "restored WIP is plain working-tree state");
    assert.deepEqual(restoreWip(fresh, origin.repo, cellId, snap.sha), { restored: false, reason: "space_dirty" });

    const moved = clone(origin.repo, root, "c-space-3");
    writeFileSync(join(moved, "other.txt"), "o\n");
    g(moved, ["add", "-A"]);
    g(moved, ["commit", "-q", "-m", "moved on"]);
    assert.deepEqual(restoreWip(moved, origin.repo, cellId, snap.sha), { restored: false, reason: "head_mismatch" });
    assert.deepEqual(restoreWip(fresh, origin.repo, cellId, head), { restored: false, reason: "nothing_to_restore" });

    pushWip(origin.repo, space, "cell-gone", snap.sha);
    assert.deepEqual(sweepWipRefs(origin.repo, new Set([cellId])), [wipRefFor("cell-gone")], "refs of Cells that no longer exist are swept, live ones kept");
    assert.equal(confirmWip(origin.repo, cellId, snap.sha), true);
    assert.equal(dropWipRef(origin.repo, cellId), true);
    assert.equal(dropWipRef(origin.repo, cellId), false);
    assert.equal(confirmWip(origin.repo, cellId, snap.sha), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("wip.1: a push into something that is not a repository, or of a non-sha, is a typed refusal", () => {
  const root = mkdtempSync(join(tmpdir(), "hb-wip-"));
  try {
    const origin = makeOrigin(root);
    const space = clone(origin.repo, root, "a-space-1");
    const head = g(space, ["rev-parse", "HEAD"]);
    assert.throws(() => pushWip(join(root, "nowhere"), space, "cell-1", head), (err: unknown) => err instanceof WipError && err.stage === "push");
    assert.throws(() => pushWip(origin.repo, space, "cell-1", "HEAD"), (err: unknown) => err instanceof WipError && err.stage === "push");
    assert.equal(wipRefFor("Cell/With Spaces"), "refs/hive/wip/cell-with-spaces");
    assert.equal(operationInProgress(space), null);
    writeFileSync(join(space, ".git", "MERGE_HEAD"), `${head}\n`);
    assert.equal(operationInProgress(space), "MERGE_HEAD");
    assert.throws(() => snapshotWip(space, join(root, "box"), "cell-1"), (err: unknown) => err instanceof WipError && err.message.includes("operation_in_progress:MERGE_HEAD"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
