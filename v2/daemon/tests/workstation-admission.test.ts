import { eligibilityPeer } from "./eligibility-fixture.ts";
import { execFileSync } from "node:child_process";
import { runV2Cli } from "../../cli/src/main.ts";
import { HiveDaemon } from "../src/daemon.ts";
import { RpcError } from "../src/protocol.ts";
import { makeOrigin } from "../../driver-cell/tests/helpers.ts";
import { createHmac } from "node:crypto";
import { localTrustMessage, type LocalTrustChallenge } from "../src/localRpcTrust.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { openCoreStore } from "../../core/src/index.ts";
import type { BeeRow } from "../../core/src/types.ts";
import type { RpcConn } from "../src/rpc.ts";
import { RpcClient } from "../../cli/src/client.ts";
import { hashCellOpRequest } from "../../core/src/cellMove.ts";
import { projectWorkstationAdmission } from "../src/workstationAdmissionProjection.ts";
import { newAdmissionBasis, startAdmissionAllowed, ownCellAdmission } from "../src/workstationAdmission.ts";
import { landingFixerPolicyOf } from "../src/config.ts";
import { makeDaemonDir, startDaemon, waitFor } from "./helpers.ts";
import type { SpawnResult, ViewResult, SnapshotResult, CommandsResult } from "../src/protocol.ts";

const human = { ingress: "local_unix", caller: { client: "hive-cli", runtimeBeeId: null, runtimeContext: false } } as RpcConn;
const automatic = (id = "parent") => ({ ...human, caller: { ...human.caller!, runtimeBeeId: id, runtimeContext: true } }) as RpcConn;
const denied = (error: unknown) => (error as { code?: string }).code === "workstation_heavy_work_denied";
const bee = (basis: BeeRow["admissionBasis"]) => ({ id: "parent", admissionBasis: basis }) as BeeRow;

test("automatic workstation admission falls back unless a satellite is positively confirmed", () => {
  const yes = { eligible: true as const, satellite: { nodeId: "worker", name: "Satellite" } };
  for (const c of [{} as RpcConn, automatic(), { ...human, ingress: "remote" } as RpcConn, { ...human, registeredApiary: true }]) {
    assert.equal(newAdmissionBasis("workstation", "spawn", c, null, 100), "automatic_local_fallback");
    assert.throws(() => newAdmissionBasis("workstation", "spawn", c, null, 100, yes), denied);
  }
  assert.equal(newAdmissionBasis("workstation", "spawn", human, null, 100, yes), "human");
  assert.equal(newAdmissionBasis("satellite", "spawn", automatic(), null, 100, yes), "automatic_nonworkstation");
  assert.equal(ownCellAdmission(bee("automatic_local_fallback"), automatic()), true);
});

test("fixer expiry is separate while already accepted automatic and mailbox-only work stays usable", () => {
  const policy = { policyId: "landing", owner: "T114" as const, expiresAt: 200 };
  const fixer = { ingress: "local_unix", registeredApiary: true, workstationAdmission: { version: 1, intent: "landing-fixer-local", requestKey: "k", policyId: "landing" } } as RpcConn;
  assert.equal(newAdmissionBasis("workstation", "spawn", fixer, policy, 100), "fixer:landing");
  assert.throws(() => newAdmissionBasis("workstation", "spawn", fixer, policy, 200), denied);
  assert.equal(startAdmissionAllowed(bee("fixer:landing"), false, policy, 200), false);
  assert.equal(startAdmissionAllowed(bee("fixer:landing"), true, null, 300), true);
  for (const basis of ["unadmitted", "inbox_only", "automatic_nonworkstation", "automatic_local_fallback"] as const) assert.equal(startAdmissionAllowed(bee(basis), false, null, 100), true);
  assert.throws(() => landingFixerPolicyOf({ workstationAdmission: { landingFixerPolicy: { ...policy, expiresAt: Infinity } } }));
});

test("schema migration preserves existing identities exactly once; newly missed creation remains unadmitted", () => {
  const rig = makeDaemonDir();
  const path = join(rig.dir, "core.sqlite3");
  let store = openCoreStore(path);
  store.createBee({ id: "old", name: "old", agent: "stub", substrate: "hsr", cwd: rig.dir });
  store.close();
  const db = new DatabaseSync(path);
  db.prepare("UPDATE meta SET value='51' WHERE key='schema_version'").run();
  db.close();
  store = openCoreStore(path);
  assert.equal(store.getBee("old")!.admissionBasis, "continuation");
  store.createBee({ id: "missed", name: "missed", agent: "stub", substrate: "hsr", cwd: rig.dir });
  assert.equal(store.getBee("missed")!.admissionBasis, "unadmitted");
  store.close();
  store = openCoreStore(path);
  assert.equal(store.getBee("missed")!.admissionBasis, "unadmitted");
  store.close(); rig.cleanup();
});

test("workstation RPC denies all automatic substrates before effects; local human starts and mail remain usable", async t => {
  const rig = makeDaemonDir({ nodeKind: "workstation", rpcLocalTrust: { requireObservationCaller: true } });
  const daemon = await startDaemon(rig.dir);
  await eligibilityPeer(t, rig.dir, daemon.socketPath);
  const raw = await RpcClient.connect(daemon.socketPath);
  const operator = await daemon.client();
  t.after(async () => { raw.close(); operator.close(); await daemon.stop(); rig.cleanup(); });
  for (const substrate of ["hsr", "cell", "tmux"]) {
    await assert.rejects(raw.request("spawn", { name: `deny-${substrate}`, agent: "stub", substrate, cwd: "/does-not-exist", account: "unavailable", cell: { originRepo: "/does-not-exist" } }), denied);
  }
  const repeated = { name: "secret-sentinel", agent: "stub", cwd: rig.dir, idempotencyKey: "same-denial" };
  await assert.rejects(raw.request("spawn", repeated), denied);
  await assert.rejects(raw.request("spawn", repeated), denied);
  const audit = await operator.request<{ rows: Array<{ kind: string; payload: Record<string, unknown> }> }>("audit.tail", { limit: 100 });
  assert.equal(audit.rows.filter(row => row.kind === "workstation.admission" && row.payload.requestKey === "same-denial").length, 1);
  assert.equal(JSON.stringify(audit).includes("secret-sentinel"), false);
  assert.equal((await operator.request<SnapshotResult>("snapshot")).views.length, 0);
  const owner = await operator.request<SpawnResult>("spawn", { name: "human", agent: "stub", cwd: rig.dir, idempotencyKey: "human" });
  await waitFor(async () => (await operator.request<ViewResult>("view", { beeId: owner.beeId })).view.runtimeState === "idle", "human stub idle");
  const saved = process.env.HIVE_BEE_ID;
  const cliErrors: string[] = [];
  const cliOutput: string[] = [];
  try {
    process.env.HIVE_BEE_ID = owner.beeId;
    const exit = await runV2Cli(["spawn", "cli-child", "--agent", "stub", "--cwd", rig.dir, "--data-dir", rig.dir, "--json"], { out: line => cliOutput.push(line), err: line => cliErrors.push(line) });
    assert.equal(exit, 1);
    assert.equal(JSON.parse(cliOutput.at(-1)!).error.code, "workstation_heavy_work_denied");
    assert.equal((await operator.request<SnapshotResult>("snapshot")).views.length, 1);
  } finally {
    if (saved === undefined) delete process.env.HIVE_BEE_ID;
    else process.env.HIVE_BEE_ID = saved;
  }
  const child = await RpcClient.connect(daemon.socketPath, 3000, undefined, { caller: { client: "hive-cli", runtimeBeeId: owner.beeId, runtimeContext: true, expectedInstanceId: null } });
  t.after(() => child.close());
  await assert.rejects(child.request("spawn", { name: "child", agent: "stub", cwd: rig.dir, parentId: owner.beeId }), denied);
  await assert.rejects(child.request("spawn", { name: "human", agent: "stub", cwd: rig.dir, idempotencyKey: "human" }), e => (e as { code?: string }).code === "idempotency_conflict");
  const replay = await operator.request<SpawnResult>("spawn", { name: "human", agent: "stub", cwd: rig.dir, idempotencyKey: "human" });
  assert.equal(replay.beeId, owner.beeId);
  await child.request("send", { beeId: owner.beeId, body: "ordinary mail" });
  const view = await operator.request<ViewResult>("view", { beeId: owner.beeId });
  assert.equal(view.bee!.admissionBasis, "human");
});

test("accepted queued work releases with no fleet query and preserves mailbox-only basis", async t => {
  const rig = makeDaemonDir({ nodeKind: "workstation" });
  const store = openCoreStore(join(rig.dir, "core.sqlite3"));
  store.createBee({ id:"accepted", name:"accepted", agent:"stub", substrate:"hsr", cwd:rig.dir });
  store.enqueueCommand("spawn", "accepted", {});
  store.setFlag("accepted", "resource_blocked", "workstation_heavy_work_denied");
  store.createBee({ id:"inbox", name:"inbox", agent:"inbox", substrate:"hsr", cwd:rig.dir, admissionBasis:"inbox_only" });
  store.createBee({id:"other-hold",name:"other-hold",agent:"stub",substrate:"hsr",cwd:rig.dir,admissionBasis:"continuation"});
  store.setFlag("other-hold","resource_blocked","other owner");
  store.close();
  const daemon = await startDaemon(rig.dir); const client = await daemon.client();
  t.after(async () => {client.close(); await daemon.stop(); rig.cleanup();});
  await waitFor(async () => (await client.request<ViewResult>("view", {beeId:"accepted"})).view.runtimeState === "idle", "accepted local stub");
  const view = await client.request<ViewResult>("view", {beeId:"accepted"});
  assert.equal(view.view.flags.includes("resource_blocked"), false);
  assert.equal(view.view.flags.includes("spawn_failed"), false);
  assert.equal((await client.request<ViewResult>("view",{beeId:"other-hold"})).view.flags.includes("resource_blocked"),true);
  assert.equal((await client.request<ViewResult>("view", {beeId:"inbox"})).bee!.admissionBasis,"inbox_only");
});


test("registered Apiary carrier binds intent and exact exec actor; untrusted and unmarked service cannot claim human", async t => {
  const rig = makeDaemonDir({ nodeKind: "workstation", rpcLocalTrust: { requireObservationCaller: true }, workstationAdmission: { landingFixerPolicy: { policyId: "temporary-landing", owner: "T114", expiresAt: Date.now() + 60_000 } } });
  const store = openCoreStore(join(rig.dir, "core.sqlite3"));
  store.createBee({ id: "reader", name: "reader", agent: "stub", substrate: "hsr", cwd: rig.dir, admissionBasis: "continuation" });
  const space = join(rig.dir, "cells", "fixture", "fixture-space-123456789abc");
  mkdirSync(space, { recursive: true });
  const cell = store.putCell({ sourceBeeId: "reader", originRepo: rig.dir, sha: "a".repeat(40), wrapper: "fixture", spaceName: "fixture-space-123456789abc", spaceDir: space, gitCommonDirRealpath: join(rig.dir, ".git"), objectFormat: "sha1", sandbox: false });
  store.close();
  const daemon = await startDaemon(rig.dir);
  const service = await RpcClient.connect(daemon.socketPath);
  t.after(async () => { service.close(); await daemon.stop(); rig.cleanup(); });
  const args = { name: "manual-apiary", agent: "stub", cwd: rig.dir, idempotencyKey: "manual-apiary" };
  const humanContext = { workstationAdmission: { version: 1 as const, intent: "human" as const, requestKey: args.idempotencyKey } };
  const untrusted = await service.request<SpawnResult>("spawn", {...args,idempotencyKey:"untrusted"}, 3000, {workstationAdmission:{...humanContext.workstationAdmission,requestKey:"untrusted"}});
  assert.equal(untrusted.notice?.code,"no_satellite_available");
  const challenge = await service.request<LocalTrustChallenge>("rpc.localTrust.challenge");
  // Only this disposable fixture's generated registration key is read.
  const key = readFileSync(join(rig.dir, "rpc-private", "registration.key"));
  const token = createHmac("sha256", key).update(localTrustMessage(challenge)).digest("hex"); key.fill(0);
  await service.request("rpc.localTrust.register", { pid: process.pid, challengeId: challenge.challengeId, token });
  const unmarked = await service.request<SpawnResult>("spawn", { ...args, idempotencyKey: "unmarked" });
  assert.equal(unmarked.notice?.code,"no_satellite_available");
  assert.equal((await service.request<SpawnResult>("spawn", { ...args, idempotencyKey: "agent-with-principal" }, 3000, { workstationAdmission: { version: 1, intent: "automatic", requestKey: "agent-with-principal" }, sessionPrincipal: { beeId: "reader" } })).notice?.code,"no_satellite_available");
  const spawned = await service.request<SpawnResult>("spawn", args, 5000, humanContext);
  assert.ok(spawned.beeId);
  await assert.rejects(service.request("spawn", { ...args, idempotencyKey: "wrong-key" }, 5000, humanContext), { code: "invalid_request" });
  await assert.rejects(service.request("spawn", args, 5000, { workstationAdmission: { ...humanContext.workstationAdmission, intent: "automatic" } }), { code: "idempotency_conflict" });
  const fixer = await service.request<SpawnResult>("spawn", { name: "fixer", agent: "stub", cwd: rig.dir, idempotencyKey: "fixer" }, 5000, { workstationAdmission: { version: 1, intent: "landing-fixer-local", requestKey: "fixer", policyId: "temporary-landing" } });
  assert.ok(fixer.beeId);
  const sentinel = join(space, "allowed-own-reader");
  const exec = { cellId: cell.id, idempotencyKey: "own-reader", argv: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1],'ok')", sentinel] };
  const other = await service.request<{status:string;admissionDiagnostic?:{reason:string}}>("cell.exec", { ...exec, idempotencyKey: "other" }, 3000, { sessionPrincipal: { beeId: "other" } });
  assert.equal(other.status,"done"); assert.equal(other.admissionDiagnostic?.reason,"criteria_unsupported");
  const own = await service.request<{ status: string }>("cell.exec", exec, 3000, { sessionPrincipal: { beeId: "reader" } });
  assert.equal(own.status, "done");
  assert.equal(readFileSync(sentinel, "utf8"), "ok");
});


test("satellite trust-off automatic metadata and unverifiable principals preserve existing admission", async t => {
  const rig = makeDaemonDir({ nodeKind: "satellite" });
  const daemon = await startDaemon(rig.dir);
  const service = await RpcClient.connect(daemon.socketPath);
  t.after(async () => { service.close(); await daemon.stop(); rig.cleanup(); });
  const spawned = await service.request<SpawnResult>("spawn", { name: "satellite-automatic", agent: "stub", cwd: rig.dir, idempotencyKey: "satellite-auto" }, 3000, { workstationAdmission: { version: 1, intent: "automatic", requestKey: "satellite-auto" }, sessionPrincipal: { beeId: "external-parent" } });
  assert.ok(spawned.beeId);
  const exec = await service.request<{ reason: string }>("cell.exec", { cellId: "missing", argv: ["false"], idempotencyKey: "satellite-exec" }, 3000, { sessionPrincipal: { beeId: spawned.beeId } });
  assert.equal(exec.reason, "no_cell");
  assert.ok((await service.request<SpawnResult>("spawn", { name: "spoof", agent: "stub", cwd: rig.dir, idempotencyKey: "spoof" }, 3000, { workstationAdmission: { version: 1, intent: "human", requestKey: "spoof" } })).beeId);
});

test("fork/import and dark execution paths cannot create a workstation runtime before admission", async t => {
  const rig = makeDaemonDir({ nodeKind: "workstation", rpcLocalTrust: { requireObservationCaller: true } });
  const daemon = await startDaemon(rig.dir);
  await eligibilityPeer(t, rig.dir, daemon.socketPath);
  const raw = await RpcClient.connect(daemon.socketPath);
  t.after(async () => { raw.close(); await daemon.stop(); rig.cleanup(); });
  for (const verb of ["bee.fork", "thread.fork", "thread.handoff", "import.fromFrozen"] as const) await assert.rejects(raw.request(verb, { beeId: "missing", idempotencyKey: verb }), denied);
  await assert.rejects(raw.request("rpc.execution.execute", { verb: "spawn" }), { code: "rpc_execution_fence_unsupported" });
});

test("real v51 migration preserves continuation revive, wake and legacy retained-exec receipt replay", async t => {
  const rig = makeDaemonDir({ nodeKind: "workstation" });
  const path = join(rig.dir, "core.sqlite3");
  const store = openCoreStore(path);
  store.createBee({ id: "continuing", name: "continuing", agent: "stub", substrate: "hsr", cwd: rig.dir });
  const cell = store.putCell({ sourceBeeId: "continuing", originRepo: rig.dir, sha: "a".repeat(40), wrapper: "fixture", spaceName: "fixture-space-123456789abc", spaceDir: rig.dir, gitCommonDirRealpath: join(rig.dir, ".git"), objectFormat: "sha1" });
  const argv = ["never-start"];
  const op = store.putCellOp({ cellId: cell.id, kind: "exec", idempotencyKey: "legacy-op", requestHash: hashCellOpRequest({ cellId: cell.id, kind: "exec", argv, cwd: null, timeoutMs: null }), argv, cwd: null, timeoutMs: null });
  store.updateCellOp(op.id, { status: "outcome_unknown", failure: "process_absent" });
  store.close();
  const db = new DatabaseSync(path); db.prepare("UPDATE meta SET value='51' WHERE key='schema_version'").run(); db.close();
  const daemon = await startDaemon(rig.dir);
  const raw = await RpcClient.connect(daemon.socketPath);
  t.after(async () => { raw.close(); await daemon.stop(); rig.cleanup(); });
  await raw.request("revive", { beeId: "continuing" });
  await waitFor(async () => (await raw.request<ViewResult>("view", { beeId: "continuing" })).view.runtimeState === "idle", "continued revive");
  await raw.request("stop", { beeId: "continuing" });
  await waitFor(async () => (await raw.request<ViewResult>("view", { beeId: "continuing" })).view.runtimeState === "stopped", "continued stopped");
  await raw.request("send", { beeId: "continuing", body: "wake existing work" });
  await waitFor(async () => (await raw.request<ViewResult>("view", { beeId: "continuing" })).view.runtimeState === "idle", "continued mailbox wake");
  const replay = await raw.request<{ status: string; deduped: boolean }>("cell.exec", { cellId: cell.id, argv, idempotencyKey: "legacy-op" });
  assert.equal(replay.status, "outcome_unknown");
  assert.equal(replay.deduped, true);
});

test("pre-capability wire leaf shapes stay unchanged while admission-aware clients get the basis", () => {
  const source = { result: { views: [{ bee: { id: "a", admissionBasis: "human" }, view: { beeId: "a", admissionBasis: "human" } }] } };
  assert.deepEqual(projectWorkstationAdmission(source, []), { result: { views: [{ bee: { id: "a" }, view: { beeId: "a" } }] } });
  assert.equal(projectWorkstationAdmission(source, ["workstation.admission.v1"]), source);
});


test("human workstation Cell admission materializes only its disposable origin", async t => {
  const rig = makeDaemonDir({ nodeKind: "workstation", cells: { sandbox: false } });
  const origin = makeOrigin(rig.dir);
  const daemon = await startDaemon(rig.dir);
  const operator = await daemon.client();
  t.after(async () => { operator.close(); await daemon.stop(); rig.cleanup(); });
  const result = await operator.request<SpawnResult>("spawn", { name: "manual-cell", agent: "stub", substrate: "cell", cell: { originRepo: origin.repo, sha: origin.sha, sandbox: false } });
  const view = await waitFor(async () => { const v = await operator.request<ViewResult>("view", { beeId: result.beeId }); return v.view.runtimeState === "idle" ? v : null; }, "human Cell idle");
  assert.equal(view.bee!.substrate, "cell");
  assert.ok(view.cell);
  assert.equal(existsSync(join(view.bee!.cwd, "README.md")), true);
});

test("dark fenced-spawn implementation preserves an admission refusal without marking an unknown effect", async () => {
  let unknown = 0;
  const fake = {
    mustStore: () => ({ beginFencedSpawn: () => ({ fresh: true, request: { args: {}, idempotencyKey: "fenced" } }), markSpawnUnknown: () => { unknown++; } }),
    rpcSpawnWithAccount: async () => { throw new RpcError("workstation_heavy_work_denied", "denied before effects"); },
  };
  const method = (HiveDaemon.prototype as unknown as { rpcFencedSpawn: (p: Record<string, unknown>, c: RpcConn) => Promise<unknown> }).rpcFencedSpawn;
  await assert.rejects(method.call(fake, {}, { executionCoordinatorUid: 1001 } as RpcConn), denied);
  assert.equal(unknown, 0);
});


test("standard test worker environment removes ambient runtime targets but retains explicit fixture overrides", () => {
  const module = new URL("../../../scripts/test-env.mjs", import.meta.url).href;
  const code = `import assert from 'node:assert/strict'; import {testEnv} from ${JSON.stringify(module)};
    const keys=['HIVE_BEE_ID','HIVE_BEE','HIVE_PARENT','HIVE_CELL','HIVE_CELL_SPACE','HIVE_V2_DATA_DIR','HIVE_V2_SOCKET_PATH'];
    for(const key of keys)process.env[key]='synthetic-runtime';
    const clean=testEnv();for(const key of keys)assert.equal(clean[key],undefined,key);
    const fixture=testEnv({HIVE_BEE_ID:'intentional-reader',HIVE_V2_DATA_DIR:'intentional-fixture'});
    assert.equal(fixture.HIVE_BEE_ID,'intentional-reader');assert.equal(fixture.HIVE_V2_DATA_DIR,'intentional-fixture');
    console.log('isolated');`;
  assert.equal(execFileSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" }).trim(), "isolated");
});
