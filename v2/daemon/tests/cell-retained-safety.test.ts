import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashCellOpRequest, openCoreStore, type CoreStore } from "../../core/src/index.ts";
import { localRepoIdentity } from "../../driver-cell/src/git.ts";
import { deleteCell } from "../../driver-cell/src/remove.ts";
import { commitInCell, g, makeOrigin } from "../../driver-cell/tests/helpers.ts";
import type { CommandsResult, BeeMoveResult, CellCaptureResult, CellExecResult, CellRetainedRemoveResult, SpawnResult, ViewResult } from "../src/protocol.ts";
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
  return { cell, origin, request, view, restart, dataDir: rig.dir, beeId: spawned.beeId };
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
  const held=await f.request<CellRetainedRemoveResult>("cell.retained.remove",{cellId:f.cell.id,idempotencyKey:"remove",force:true});assert.equal(held.reason,"gate_busy");
});

test("legacy interrupted removal cannot authorize a new deletion or launder an absent wrapper", {timeout:120000},async t=>{
  const f=await retainedFixture(t);
  await f.restart(store=>{const op=store.putCellOp({cellId:f.cell.id,kind:"remove",idempotencyKey:"legacy-remove",requestHash:"legacy"});store.updateCellOp(op.id,{status:"running"});});
  const next=await f.request<CellRetainedRemoveResult>("cell.retained.remove",{cellId:f.cell.id,idempotencyKey:"new-remove",force:true});assert.equal(next.status,"refused");assert.equal(next.reason,"gate_busy");assert.ok(existsSync(f.cell.spaceDir));
  await f.restart(()=>{rmSync(dirname(f.cell.spaceDir),{recursive:true,force:true});});
  await assert.rejects(f.request("cell.retained.remove",{cellId:f.cell.id,idempotencyKey:"legacy-remove",force:true}));
  assert.equal((await f.view()).cell?.state,"retained","absence alone is never receipt authority");
});


test("surviving backup guard fences retained exec, landing and forced removal after restart", { timeout: 120_000 }, async (t) => {
  const f = await retainedFixture(t);
  await f.restart(store => {
    const op = store.putCellOp({ cellId: f.cell.id, kind: "backup", idempotencyKey: "capture-backup", requestHash: "fixture" });
    store.updateCellOp(op.id, { status: "running", pid: process.pid });
  });
  const exec = await f.request<CellExecResult>("cell.exec", { cellId: f.cell.id, idempotencyKey: "exec-after-backup", argv: [process.execPath, "-e", "0"] });
  assert.equal(exec.reason, "busy");
  await assert.rejects(f.request("cell.capture",{beeId:f.beeId,targetBranch:"concurrent",mode:"merge",idempotencyKey:"landing-after-backup"}),(error:unknown)=>error instanceof Error&&"code"in error&&error.code==="runtime_refused");
  const held=await f.request<CellRetainedRemoveResult>("cell.retained.remove",{cellId:f.cell.id,idempotencyKey:"remove-after-backup",force:true});assert.equal(held.reason,"gate_busy");
  assert.equal(existsSync(f.cell.spaceDir), true);
});


test("cell.backup uses owner configuration and refuses a busy retained Cell without starting tools", { timeout: 120_000 }, async t => {
  const f=await retainedFixture(t);
  const params={cellId:f.cell.id,idempotencyKey:"backup-request"};
  assert.deepEqual(await f.request("cell.backup",params),{status:"refused",reason:"invalid_request"});
  writeFileSync(join(f.dataDir,"backup.json"),JSON.stringify({repository:"rest:http://127.0.0.1:1/fixture/",passwordRef:"global/fleet-backup-fixture-repo-key",writerRef:"global/fleet-backup-fixture-writer"}));
  await f.restart(store=>{
    const op=store.putCellOp({cellId:f.cell.id,kind:"backup",idempotencyKey:"existing-guard",requestHash:"fixture"});
    store.updateCellOp(op.id,{status:"running",pid:process.pid});
  });
  assert.deepEqual(await f.request("cell.backup",params),{status:"refused",reason:"busy"});
  assert.equal(existsSync(f.cell.spaceDir),true);
});


test("mail waits behind an evicted Cell backup and boots afterward without charging the spawn budget", { timeout: 120_000 }, async t => {
  const f=await retainedFixture(t);
  const spawned=await f.request<SpawnResult>("spawn",{name:"backup-wake",agent:"stub",substrate:"cell",cell:{originRepo:f.origin.repo}});
  const view=()=>f.request<ViewResult>("view",{beeId:spawned.beeId});
  const ready=await waitFor(async()=>{const row=await view();return row.cell && row.view.runtimeState==="idle" ? row : null;},"backup wake fixture ready",60_000);
  await f.request("stop",{beeId:spawned.beeId});
  await waitFor(async()=>(await view()).view.runtimeState==="stopped","fixture stopped");
  // Model a historical eviction in disposable data; production eviction now requires a receipt.
  await f.restart(store=>{rmSync(dirname(ready.cell!.spaceDir),{recursive:true,force:true});store.evictCell(ready.cell!.id,{head:f.origin.sha,bytes:0,reason:"disposable_historical_fixture"});});
  let backupId="";
  await f.restart(store=>{
    const op=store.putCellOp({cellId:ready.cell!.id,kind:"backup",idempotencyKey:"wake-guard",requestHash:"fixture"});backupId=op.id;
    store.updateCellOp(op.id,{status:"running",pid:process.pid});
  });
  await f.request("send",{beeId:spawned.beeId,body:"after backup",idempotencyKey:"wake-during-backup"});
  const held=await waitFor(async()=>{const rows=await f.request<CommandsResult>("commands",{beeId:spawned.beeId});return rows.commands.find(row=>row.verb==="send_wake" && row.status==="queued");},"wake stays queued");
  assert.equal(held.attempts,0);
  assert.equal((await view()).bee?.spawnFailures,0);
  assert.equal(existsSync(ready.cell!.spaceDir),false,"backup hold does not recreate a Cell");
  await f.restart(store=>{store.updateCellOp(backupId,{status:"done",pid:null,failure:null});});
  const resumed=await waitFor(async()=>{const row=await view();return row.view.runtimeState==="idle" ? row : null;},"wake resumes after backup",60_000);
  assert.equal(resumed.bee?.spawnFailures,0);
  assert.ok(!resumed.view.flags.includes("spawn_failed"));
});
