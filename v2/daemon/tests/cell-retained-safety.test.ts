import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashCellOpRequest, openCoreStore, type CoreStore } from "../../core/src/index.ts";
import { localRepoIdentity } from "../../driver-cell/src/git.ts";
import { deleteCell } from "../../driver-cell/src/remove.ts";
import { commitInCell, g, makeOrigin } from "../../driver-cell/tests/helpers.ts";
import type { BeeMoveResult, CellCaptureResult, CellExecResult, CellRetainedRemoveResult, SpawnResult, ViewResult } from "../src/protocol.ts";
import { makeDaemonDir, startDaemon, waitFor } from "./helpers.ts";

async function retainedFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "hb-retained-safety-"));
  const origin = makeOrigin(root);
  const cellsRoot = join(root, "cells");
  mkdirSync(cellsRoot);
  const rig = makeDaemonDir({
    cells: { root: cellsRoot, allowStubMove: true },
    agents: { stub: { command: process.execPath, adapter: "stub", args: [fileURLToPath(new URL("../../driver-cell/test-agent/agent.mjs", import.meta.url))] } },
  });
  let daemon = await startDaemon(rig.dir);
  let client = await daemon.client();
  t.after(async () => {
    client.close();
    await daemon.stop();
    rig.cleanup();
    rmSync(root, { recursive: true, force: true });
  });
  const request = <T>(verb: Parameters<typeof client.request>[0], params: Record<string, unknown>) => client.request<T>(verb, params, 30_000);
  const spawned = await request<SpawnResult>("spawn", { name: "retained", agent: "stub", substrate: "cell", cell: { originRepo: origin.repo } });
  const view = () => request<ViewResult>("view", { beeId: spawned.beeId });
  const source = await waitFor(async () => {
    const row = await view();
    return row.view.runtimeState === "idle" && row.cell ? row : null;
  }, "Cell ready", 60_000);
  assert.ok(source.cell && source.bee);
  const cell = source.cell;
  const repository = localRepoIdentity(origin.repo);
  assert.ok(repository);
  const move = await request<BeeMoveResult>("bee.move", {
    beeId: spawned.beeId, idempotencyKey: "move",
    expected: { placementVersion: 0, cellId: cell.id },
    destination: { kind: "local_checkout", cwd: origin.repo, repository, observedHead: origin.sha },
  });
  await request("send", { beeId: spawned.beeId, body: "continue", idempotencyKey: "first-task" });
  await waitFor(async () => (await request<BeeMoveResult>("bee.move.get", { moveId: move.id })).phase === "complete", "move complete", 60_000);
  const restart = async (seed?: (store: CoreStore) => void) => {
    await daemon.kill();
    client.close();
    if (seed) {
      // Old durable evidence must not become proof of process absence merely
      // because the daemon's former timeout deadline has elapsed.
      const store = openCoreStore(join(rig.dir, "core.sqlite3"), { now: () => 1 });
      try { seed(store); } finally { store.close(); }
    }
    daemon = await startDaemon(rig.dir);
    client = await daemon.client();
  };
  return { cell, origin, request, view, restart, beeId: spawned.beeId };
}

test("retained capture resolves the registry after daemon restart", { timeout: 120_000 }, async (t) => {
  const f = await retainedFixture(t);
  const sha = commitInCell(f.cell.spaceDir, "kept.txt", "keep me\n", "retained work");
  await f.restart();
  const report = await f.request<CellCaptureResult>("cell.capture", { beeId: f.beeId, targetBranch: "retained-result", mode: "merge", idempotencyKey: "capture" });
  assert.equal(report.status, "landed", JSON.stringify(report));
  assert.equal(g(f.origin.repo, ["rev-parse", "retained-result"]), sha);
  assert.equal(existsSync(join(f.origin.repo, "kept.txt")), false);
});

test("legacy Cell removal refuses a stopped bee's retained allocation", { timeout: 120_000 }, async (t) => {
  const f = await retainedFixture(t);
  await f.request("stop", { beeId: f.beeId });
  await waitFor(async () => (await f.view()).view.runtimeState === "stopped", "destination stopped");
  await assert.rejects(f.request("cell.remove", { beeId: f.beeId, force: true, idempotencyKey: "legacy-remove" }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "invalid_request");
  assert.equal((await f.view()).bee?.lifecycle, "active");
  assert.equal(existsSync(f.cell.spaceDir), true);
});

test("capture is fenced while retained exec can still modify the Cell", { timeout: 120_000 }, async (t) => {
  const f = await retainedFixture(t);
  const pending = f.request<CellExecResult>("cell.exec", {
    cellId: f.cell.id, idempotencyKey: "exec", argv: [process.execPath, "-e", "require('node:fs').writeFileSync('started','yes'); setTimeout(()=>{},2500)"],
  });
  await waitFor(() => existsSync(join(f.cell.spaceDir, "started")), "exec started");
  try {
    await assert.rejects(f.request("cell.capture", { beeId: f.beeId, targetBranch: "concurrent", mode: "merge", idempotencyKey: "capture" }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "runtime_refused");
  } finally { await pending; }
});

test("an attempted exec without saved process identity is unknown and keeps the Cell gate", { timeout: 120_000 }, async (t) => {
  const f = await retainedFixture(t);
  const argv = [process.execPath, "-e", "require('node:fs').writeFileSync('replayed','bad')"];
  await f.restart((store) => {
    const op = store.putCellOp({ cellId: f.cell.id, kind: "exec", idempotencyKey: "lost", argv,
      requestHash: hashCellOpRequest({ cellId: f.cell.id, kind: "exec", argv, cwd: null, timeoutMs: null }) });
    store.updateCellOp(op.id, { status: "running" });
  });
  const old = await f.request<CellExecResult>("cell.exec", { cellId: f.cell.id, idempotencyKey: "lost", argv });
  assert.equal(old.status, "outcome_unknown");
  assert.equal(existsSync(join(f.cell.spaceDir, "replayed")), false);
  const next = await f.request<CellExecResult>("cell.exec", { cellId: f.cell.id, idempotencyKey: "new", argv: [process.execPath, "-e", "0"] });
  assert.equal(next.reason, "busy", JSON.stringify(next));
  await assert.rejects(f.request("cell.retained.remove", { cellId: f.cell.id, idempotencyKey: "remove", force: true }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "runtime_refused");
});

test("interrupted retained removal reconciles its directory instead of exec process identity", { timeout: 120_000 }, async (t) => {
  const f = await retainedFixture(t);
  await f.restart((store) => {
    const op = store.putCellOp({ cellId: f.cell.id, kind: "remove", idempotencyKey: "remove",
      requestHash: hashCellOpRequest({ cellId: f.cell.id, kind: "remove", force: true }) });
    store.updateCellOp(op.id, { status: "running" });
    // Crash boundary: the filesystem effect happened, its result was not saved.
    deleteCell(dirname(f.cell.spaceDir), { force: true });
  });
  const result = await f.request<CellRetainedRemoveResult>("cell.retained.remove", { cellId: f.cell.id, idempotencyKey: "remove", force: true });
  assert.equal(result.status, "deleted");
  assert.equal(result.forced, true);
  assert.equal(result.deduped, true);
  assert.equal((await f.view()).bee?.cellId, null);
  assert.equal((await f.view()).bee?.lifecycle, "active");
});
