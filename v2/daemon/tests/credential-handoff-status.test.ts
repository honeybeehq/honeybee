import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openCoreStore, type CredentialHandoffRecord, type CredentialHandoffLocalSnapshot, type CredentialHandoffLocalFact } from "../../core/src/index.ts";
import { AccountsService } from "../src/accountsService.ts";
import { loadNodeConfig } from "../src/config.ts";
import { RpcError } from "../src/protocol.ts";
import { RpcClient } from "../../cli/src/client.ts";
import { makeDaemonDir, startDaemon, forceStopTestDaemon, waitFor } from "./helpers.ts";

const from = { nodeId: "dummy-source", deviceKey: "private-source-identity-marker" };
const to = { nodeId: "dummy-destination", deviceKey: "private-target-identity-marker" };
function fixture() {
  const rig = makeDaemonDir();
  const store = openCoreStore(join(rig.dir, "core.sqlite3"));
  const accounts = new AccountsService({ store, cfg: loadNodeConfig(rig.dir), now: () => Date.now(), log: () => {} });
  const account = store.createAccount({ id: "claude-precheck-example.com", harness: "claude", homePath: join(rig.dir, "homes", "claude-precheck-example.com"), label: "test" });
  const put = (handoffId: string, role: CredentialHandoffRecord["role"], state: CredentialHandoffRecord["state"]): CredentialHandoffRecord => store.putCredentialHandoff({
    handoffId, role, state, account: account.id, binding: { handoffId, sourceAccount: account.id, harness: "claude", generation: 1, epoch: 1, from, to,
      sourceKey: "private-source-key-marker", targetKey: "private-target-key-marker", materialDigest: "private-digest-marker", since: Date.now(), prepareBy: Date.now() + 3600000, claimId: "dummy-claim", targetAccount: account.id },
    receipt: null, generation: null, expiresAt: null, scrubbed: true,
  });
  return { rig, store, accounts, account, put, service: accounts.credentialHandoff, close: () => { store.close(); rig.cleanup(); } };
}
function snapshot(service: AccountsService["credentialHandoff"]): CredentialHandoffLocalSnapshot {
  return service.status({}) as CredentialHandoffLocalSnapshot;
}
function assertRedacted(value: unknown) {
  const text = JSON.stringify(value);
  for (const marker of [from.deviceKey, to.deviceKey, "private-source-key-marker", "private-target-key-marker", "private-digest-marker", "private-signature-marker"]) assert.ok(!text.includes(marker), "summary omits identity, keys, digest and signatures");
}

test("handoff status: both roles/all durable phases, confirmation evidence and retained summaries", async () => {
  const f = fixture();
  try {
    assert.deepEqual(snapshot(f.service), { handoffs: [], identityReplacing: false, reconciled: false });
    const states: CredentialHandoffRecord["state"][] = ["exported", "preparing", "prepared", "committed", "adopting", "adopted", "failed", "aborted", "confirmed", "stood_down"];
    for (const role of ["source", "destination"] as const) for (const state of states) {
      const row = f.put(`${role}-${state}`, role, state);
      const adopted = { kind: "adopted" as const, binding: row.binding, signature: "private-signature-marker" };
      f.store.putCredentialHandoff({ ...row, ...(role === "source" && state === "confirmed" ? { peerReceipt: adopted } : role === "destination" && state === "adopted" ? { receipt: adopted } : {}) });
    }
    f.put("legacy-confirmed", "source", "confirmed");
    const settled = f.put("settled-confirmed", "source", "confirmed");
    f.store.putCredentialHandoff({ ...settled, peerReceipt: { kind: "retained_discard_request", binding: settled.binding, signature: "private-signature-marker" } });
    const retained = f.put("retained", "destination", "adopting");
    f.store.putCredentialHandoff({ ...retained, adoptionRecovery: { retainedGeneration: 4, retainedUnusableCount: 3 } });
    const result = snapshot(f.service);
    assert.equal(result.handoffs.length, 23);
    for (const row of result.handoffs) {
      assert.equal(row.activeLane, null);
      assert.equal(row.peerNodeId, row.role === "source" ? to.nodeId : from.nodeId);
      assert.equal(row.confirmed, row.handoffId === "source-confirmed" || row.handoffId === "destination-adopted");
      assert.deepEqual(f.service.status({ handoffId: row.handoffId, role: row.role, summary: true }), { ...row, identityReplacing: false, reconciled: false });
    }
    assertRedacted(result);
    assert.throws(() => f.service.status({ handoffId: "missing", summary: true }), e => e instanceof RpcError && e.code === "credential_handoff_not_found");
    assert.throws(() => f.service.status({ role: "destination" }), e => e instanceof RpcError && e.code === "invalid_request");
    await f.service.reconcileStartup();
    assert.equal(snapshot(f.service).reconciled, true);
    console.log("both roles x ten phases; held adoption evidence only, settled/legacy false; retained/capped summaries redacted; missing is not_found");
  } finally { f.close(); }
});

test("handoff status: actual matching lane remains visible across a refused competing operation", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    f.put("held", "source", "committed"); f.put("other", "source", "committed");
    const authority = f.accounts.authorityFor(f.account)!;
    const held = authority.handoffLane(f.account, "adopt:held", () => gate, { kind: "adopt", handoffId: "held" });
    assert.deepEqual(snapshot(f.service).handoffs.find(row => row.handoffId === "held")!.activeLane, { kind: "adopt", handoffId: "held" });
    assert.equal(snapshot(f.service).handoffs.find(row => row.handoffId === "other")!.activeLane, null);
    await assert.rejects(f.service.exportCommit({ handoffId: "other", claimId: "dummy-claim" }), e => e instanceof RpcError && e.code === "credential_handoff_unavailable");
    assert.deepEqual(snapshot(f.service).handoffs.find(row => row.handoffId === "held")!.activeLane, { kind: "adopt", handoffId: "held" });
    release(); await held;
    assert.ok(snapshot(f.service).handoffs.every(row => row.activeLane === null));
    console.log("actual owning lane+claim visible, historical claim null, refused admission cannot overwrite owner; completed lane null");
  } finally { release(); f.close(); }
});

test("handoff status: identity replacement observable during its real lane and with zero rows", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    f.store.setCredentialHandoffIdentity(from);
    f.put("replacement", "source", "exported");
    f.store.putAccountCredentialAuthority({ account: f.account.id, phase: "handing_off", generation: 1, expiresAt: Date.now() + 3600000, operationKey: null });
    const authority = f.accounts.authorityFor(f.account)!;
    const original = authority.handoffLane.bind(authority);
    authority.handoffLane = (account, kind, run, handoff) => original(account, kind, async () => { await gate; return run(); }, handoff);
    const replacement = f.service.setIdentity({ identity: to, replace: true });
    const during = snapshot(f.service);
    assert.equal(during.identityReplacing, true);
    assert.deepEqual(during.handoffs[0]!.activeLane, { kind: "identity-abort", handoffId: "replacement" });
    assertRedacted(during);
    release(); await replacement;
    assert.equal(snapshot(f.service).identityReplacing, false);
  } finally { release(); f.close(); }
  const empty = fixture();
  try {
    const original = empty.store.setCredentialHandoffIdentity.bind(empty.store);
    let seen: CredentialHandoffLocalSnapshot | undefined;
    empty.store.setCredentialHandoffIdentity = identity => { seen = snapshot(empty.service); original(identity); };
    await empty.service.setIdentity({ identity: from });
    assert.deepEqual(seen, { handoffs: [], identityReplacing: true, reconciled: false });
  } finally { empty.close(); }
  console.log("live identity replacement visible with held source lane and empty wrapper; no self/identity/signing on summary read");
});

test("handoff status: startup reconciliation stays unknown while held or failing", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    const row = f.put("boot-cleanup", "destination", "failed"); f.store.putCredentialHandoff({ ...row, scrubbed: false });
    f.accounts.scrubHandoff = async () => { await gate; };
    const boot = f.service.reconcileStartup();
    await waitFor(() => snapshot(f.service).handoffs[0]!.activeLane !== null, "startup cleanup holds lane");
    assert.equal(snapshot(f.service).reconciled, false);
    release(); await boot;
    assert.equal(snapshot(f.service).reconciled, true);
    assert.equal(snapshot(f.service).handoffs[0]!.activeLane, null);
  } finally { release(); f.close(); }
  const failed = fixture();
  try {
    failed.store.pendingCredentialHandoffs = () => { throw new Error("test storage refusal"); };
    await assert.rejects(failed.service.reconcileStartup(), /test storage refusal/);
    assert.equal(snapshot(failed.service).reconciled, false);
  } finally { failed.close(); }
  console.log("startup held/failing stays reconciled:false; completed cleanup sets true after lane release");
});

test("handoff status: isolated daemon capability, CLI list, missing/relay refusals and restart", { timeout: 60000 }, async () => {
  const f = fixture();
  f.put("durable-claim", "source", "committed");
  for (const role of ["source", "destination"] as const) for (const state of ["exported", "preparing", "prepared", "committed", "adopting", "adopted", "failed", "aborted", "confirmed", "stood_down"] as const) f.put(`restart-${role}-${state}`, role, state);
  const pending = f.put("boot-held", "destination", "failed"); f.store.putCredentialHandoff({ ...pending, scrubbed: false }); f.store.close();
  const gate = join(f.rig.dir, "startup-gate"), marker = join(f.rig.dir, "startup-held"), preload = join(f.rig.dir, "startup-preload.mjs");
  writeFileSync(gate, "");
  writeFileSync(preload, `import fs from 'node:fs';import{AccountsService}from${JSON.stringify(fileURLToPath(new URL("../src/accountsService.ts", import.meta.url)))};const original=AccountsService.prototype.scrubHandoff;AccountsService.prototype.scrubHandoff=async function(account){if(fs.existsSync(${JSON.stringify(gate)})){fs.writeFileSync(${JSON.stringify(marker)},'');while(fs.existsSync(${JSON.stringify(gate)}))await new Promise(r=>setTimeout(r,10));}return original.call(this,account);};`);
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  let client: RpcClient | undefined;
  try {
    daemon = await startDaemon(f.rig.dir, { env: { NODE_OPTIONS: `--import=${preload}`, HIVE_NO_KEYCHAIN: "1" } });
    client = await daemon.client();
    await waitFor(() => existsSync(marker), "startup cleanup held while RPC listens");
    const held = await client.request<CredentialHandoffLocalSnapshot>("account.credentials.handoffStatus", {});
    assert.equal(held.reconciled, false);
    assert.deepEqual(held.handoffs.find(row => row.handoffId === "boot-held")!.activeLane, { kind: "cleanup", handoffId: "boot-held" });
    unlinkSync(gate);
    assert.ok(client.capabilities.includes("account.credentials.handoff_status.v2"));
    const before = await waitFor(async () => { const result = await client!.request<CredentialHandoffLocalSnapshot>("account.credentials.handoffStatus", {}); return result.reconciled ? result : null; }, "startup handoffs reconciled");
    assert.equal(before.handoffs.length, 22); assert.equal(before.handoffs[0]!.handoffId, "durable-claim"); assert.equal(before.handoffs[0]!.activeLane, null);
    assertRedacted(before);
    await assert.rejects(client.request("account.credentials.handoffStatus", { handoffId: "missing", summary: true }), e => e instanceof RpcError && e.code === "credential_handoff_not_found");
    for (const lane of ["node_relay", "remote"] as const) {
      const relayed = await RpcClient.connect(daemon.socketPath, 3000, lane);
      try { for (const params of [{}, { handoffId: "durable-claim", summary: true }]) await assert.rejects(relayed.request("account.credentials.handoffStatus", params), e => e instanceof RpcError && e.code === "credential_handoff_conflict"); }
      finally { relayed.close(); }
    }
    const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../../cli/src/bin.ts", import.meta.url)), "account", "credentials", "handoff-status", "--data-dir", f.rig.dir, "--json"]);
    assert.deepEqual(JSON.parse(stdout), before);
    await daemon.kill(); client.close(); daemon = await startDaemon(f.rig.dir); client = await daemon.client();
    const after = await waitFor(async () => { const result = await client!.request<CredentialHandoffLocalSnapshot>("account.credentials.handoffStatus", {}); return result.reconciled ? result : null; }, "restarted handoffs reconciled");
    assert.deepEqual(after, before);
    const summary = await client.request<CredentialHandoffLocalFact>("account.credentials.handoffStatus", { handoffId: "durable-claim", summary: true });
    assertRedacted(summary);
    console.log("isolated Unix daemon/CLI list, capability, missing-not_found, remote/relay refused; durable state survives restart, no stale lane");
  } finally { if (existsSync(gate)) unlinkSync(gate); client?.close(); if (daemon) await forceStopTestDaemon(daemon); f.rig.cleanup(); }
});
