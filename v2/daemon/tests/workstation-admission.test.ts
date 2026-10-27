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
import { newAdmissionBasis, startAdmissionAllowed, ownCellAdmission } from "../src/workstationAdmission.ts";
import { landingFixerPolicyOf } from "../src/config.ts";
import { makeDaemonDir, startDaemon, waitFor } from "./helpers.ts";
import type { SpawnResult, ViewResult, SnapshotResult, CommandsResult } from "../src/protocol.ts";

const human = { ingress: "local_unix", caller: { client: "hive-cli", runtimeBeeId: null, runtimeContext: false } } as RpcConn;
const automatic = (id = "parent") => ({ ...human, caller: { ...human.caller!, runtimeBeeId: id, runtimeContext: true } }) as RpcConn;
const denied = (error: unknown) => (error as { code?: string }).code === "workstation_heavy_work_denied";
const bee = (basis: BeeRow["admissionBasis"]) => ({ id: "parent", admissionBasis: basis }) as BeeRow;

test("new admission is fail closed for missing, remote and runtime context; human never grants its child", () => {
  for (const c of [{} as RpcConn, automatic(), { ...human, ingress: "remote" } as RpcConn, { ...human, registeredApiary: true }]) {
    assert.throws(() => newAdmissionBasis("workstation", "spawn", c, null, 100), denied);
  }
  assert.equal(newAdmissionBasis("workstation", "spawn", human, null, 100), "human");
  assert.equal(newAdmissionBasis("satellite", "spawn", automatic(), null, 100), "automatic_nonworkstation");
  assert.equal(newAdmissionBasis("cloud", "spawn", automatic(), null, 100), "automatic_nonworkstation");
  assert.equal(ownCellAdmission(bee("continuation"), automatic()), true);
  assert.equal(ownCellAdmission(bee("continuation"), automatic("other")), false);
});

test("finite Landing policy is spawn-only, own continuation survives expiry and unknown basis stays held", () => {
  const policy = { policyId: "landing", owner: "T114" as const, expiresAt: 200 };
  const fixer = { ingress: "local_unix", registeredApiary: true, workstationAdmission: { version: 1, intent: "landing-fixer-local", requestKey: "k", policyId: "landing" } } as RpcConn;
  assert.equal(newAdmissionBasis("workstation", "spawn", fixer, policy, 100), "fixer:landing");
  assert.throws(() => newAdmissionBasis("workstation", "cell.exec", fixer, policy, 100), denied);
  assert.throws(() => newAdmissionBasis("workstation", "spawn", fixer, policy, 200), denied);
  assert.equal(startAdmissionAllowed(bee("fixer:landing"), false, policy, 200), false);
  assert.equal(startAdmissionAllowed(bee("fixer:landing"), true, null, 300), true);
  for (const basis of ["unadmitted", "inbox_only", "automatic_nonworkstation"] as const) assert.equal(startAdmissionAllowed(bee(basis), false, policy, 100), false);
  for (const basis of ["human", "continuation"] as const) assert.equal(startAdmissionAllowed(bee(basis), false, null, 300), true);
  assert.throws(() => landingFixerPolicyOf({ workstationAdmission: { landingFixerPolicy: { ...policy, expiresAt: Infinity } } }));
  assert.deepEqual(landingFixerPolicyOf({ workstationAdmission: { landingFixerPolicy: policy } }), policy);
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
  const rig = makeDaemonDir({ nodeKind: "workstation" });
  const daemon = await startDaemon(rig.dir);
  const raw = await RpcClient.connect(daemon.socketPath);
  const operator = await daemon.client();
  t.after(async () => { raw.close(); operator.close(); await daemon.stop(); rig.cleanup(); });
  for (const substrate of ["hsr", "cell", "tmux"]) {
    await assert.rejects(raw.request("spawn", { name: `deny-${substrate}`, agent: "stub", substrate, cwd: "/does-not-exist", account: "unavailable", cell: { originRepo: "/does-not-exist" } }), denied);
  }
  assert.equal((await operator.request<SnapshotResult>("snapshot")).views.length, 0);
  const owner = await operator.request<SpawnResult>("spawn", { name: "human", agent: "stub", cwd: rig.dir, idempotencyKey: "human" });
  await waitFor(async () => (await operator.request<ViewResult>("view", { beeId: owner.beeId })).view.runtimeState === "idle", "human stub idle");
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

test("pending unadmitted starts hold without retry budget and cross-bee retained exec never starts its sentinel", async t => {
  const rig = makeDaemonDir({ nodeKind: "workstation" });
  const store = openCoreStore(join(rig.dir, "core.sqlite3"));
  const input = { agent: "stub", substrate: "hsr", cwd: rig.dir };
  store.createBee({ ...input, id: "held", name: "held" });
  store.enqueueCommand("spawn", "held", {});
  store.createBee({ ...input, id: "existing", name: "existing", admissionBasis: "continuation" });
  const cell = store.putCell({ sourceBeeId: "existing", originRepo: rig.dir, sha: "a".repeat(40), wrapper: "fixture", spaceName: "fixture-space-123456789abc", spaceDir: rig.dir, gitCommonDirRealpath: join(rig.dir, ".git"), objectFormat: "sha1", sandbox: false });
  store.close();
  const daemon = await startDaemon(rig.dir);
  const raw = await RpcClient.connect(daemon.socketPath);
  const operator = await daemon.client();
  t.after(async () => { raw.close(); operator.close(); await daemon.stop(); rig.cleanup(); });
  await waitFor(async () => (await operator.request<ViewResult>("view", { beeId: "held" })).view.flags.includes("resource_blocked"), "admission hold");
  const sentinel = join(rig.dir, "SHOULD-NOT-START");
  const request = { cellId: cell.id, idempotencyKey: "denied-exec", argv: ["sh", "-c", `touch ${sentinel}`] };
  await assert.rejects(raw.request("cell.exec", request), denied);
  await assert.rejects(raw.request("cell.exec", request), denied);
  assert.equal(existsSync(sentinel), false);
  const command = (await operator.request<CommandsResult>("commands", { beeId: "held" })).commands[0]!;
  assert.equal(command.attempts, 0);
  assert.equal(command.status, "queued");
  assert.equal((await operator.request<ViewResult>("view", { beeId: "held" })).view.flags.includes("spawn_failed"), false);
  await raw.request("send", { beeId: "held", body: "durable pending mail" });
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
  await assert.rejects(service.request("spawn", args, 1000, humanContext));
  const challenge = await service.request<LocalTrustChallenge>("rpc.localTrust.challenge");
  // Only this disposable fixture's generated registration key is read.
  const key = readFileSync(join(rig.dir, "rpc-private", "registration.key"));
  const token = createHmac("sha256", key).update(localTrustMessage(challenge)).digest("hex"); key.fill(0);
  await service.request("rpc.localTrust.register", { pid: process.pid, challengeId: challenge.challengeId, token });
  await assert.rejects(service.request("spawn", { ...args, idempotencyKey: "unmarked" }), denied);
  const spawned = await service.request<SpawnResult>("spawn", args, 1000, humanContext);
  assert.ok(spawned.beeId);
  await assert.rejects(service.request("spawn", { ...args, idempotencyKey: "wrong-key" }, 1000, humanContext), { code: "invalid_request" });
  await assert.rejects(service.request("spawn", args, 1000, { workstationAdmission: { ...humanContext.workstationAdmission, intent: "automatic" } }), { code: "idempotency_conflict" });
  const fixer = await service.request<SpawnResult>("spawn", { name: "fixer", agent: "stub", cwd: rig.dir, idempotencyKey: "fixer" }, 1000, { workstationAdmission: { version: 1, intent: "landing-fixer-local", requestKey: "fixer", policyId: "temporary-landing" } });
  assert.ok(fixer.beeId);
  const sentinel = join(space, "allowed-own-reader");
  const exec = { cellId: cell.id, idempotencyKey: "own-reader", argv: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1],'ok')", sentinel] };
  await assert.rejects(service.request("cell.exec", { ...exec, idempotencyKey: "other" }, 3000, { sessionPrincipal: { beeId: "other" } }), denied);
  const own = await service.request<{ status: string }>("cell.exec", exec, 3000, { sessionPrincipal: { beeId: "reader" } });
  assert.equal(own.status, "done");
  assert.equal(readFileSync(sentinel, "utf8"), "ok");
});
