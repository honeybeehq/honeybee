import { test } from "node:test";
import assert from "node:assert/strict";
import { assertConfinedSpawn, assertConfinedVerb, peerConfinement, peerUserNamespace, strictConfinementReasons, type ProcReader } from "../src/confinedPeer.ts";
import { RpcError } from "../src/protocol.ts";

const peer = {uid: 1000, pid: 42, processBirth: "linux:99"};
const reader = (changes: Partial<ProcReader> = {}): ProcReader => ({open: () => 7, birth: () => "linux:99", userns: () => "user:[1]", selfUserns: () => "user:[1]", close: () => {}, ...changes});
const refused = (error: unknown) => error instanceof RpcError && error.code === "confined_spawn_refused";

test("confinement uses pinned process birth and namespace, failing closed", () => {
  assert.equal(peerConfinement(peer, {proc: reader()}), "unconfined");
  assert.equal(peerConfinement(peer, {proc: reader({userns: () => "user:[2]"})}), "confined");
  assert.equal(peerConfinement(peer, {proc: reader(), substrate: () => "cell"}), "confined");
  assert.equal(peerConfinement(peer, {proc: reader({open: () => {throw new Error("gone");}})}), "confined");
  assert.equal(peerConfinement(peer, {proc: reader({birth: () => "linux:100"})}), "confined");
  let closed = false;
  assert.equal(peerUserNamespace(peer, reader({birth: () => {throw new Error("exited after open");}, close: fd => {assert.equal(fd, 7); closed = true;}})), "unavailable");
  assert.equal(closed, true);
  let reads = 0;
  assert.equal(peerConfinement(peer, {proc: reader({birth: () => ++reads === 1 ? "linux:99" : "linux:100"})}), "confined");
  assert.equal(peerConfinement(peer, {platform: "darwin", proc: reader({open: () => {throw new Error("must not read proc");}})}), "unknown");
});

test("strict mode triggers and trusted host exceptions", () => {
  assert.deepEqual(strictConfinementReasons(true, false, "different"), []);
  assert.deepEqual(strictConfinementReasons(false, false), ["cell_sandbox_off"]);
  assert.deepEqual(strictConfinementReasons(true, true), ["setuid_bwrap"]);
  assert.deepEqual(strictConfinementReasons(true, false, "same"), ["cell_userns_unisolated"]);
  assert.deepEqual(strictConfinementReasons(true, false, "unavailable"), ["cell_userns_unisolated"]);
  assert.equal(peerConfinement(peer, {proc: reader(), strict: true}), "confined");
  for (const options of [{registered: true}, {substrate: () => "hsr"}, {substrate: () => "tmux"}]) {
    assert.equal(peerConfinement(peer, {proc: reader(), strict: true, ...options}), "unconfined");
  }
});

const forbidden = [{}, {substrate: "hsr"}, {substrate: "tmux"}, {substrate: "cell", cell: {sandbox: false}}, {substrate: "cell", cwd: "/tmp"}, {substrate: "cell", node: "other"}, {substrate: "cell", nodeId: "other"}, {substrate: "cell", relay: "other"}];
test("confined spawn refuses every forbidden placement and permits sandboxed Cells and inbox", () => {
  for (const params of forbidden) assert.throws(() => assertConfinedSpawn(params, {confinement: "confined"}), refused);
  assert.throws(() => assertConfinedSpawn({substrate: "cell"}, {confinement: "confined", ingress: "node_relay"}), refused);
  for (const params of [{substrate: "cell"}, {substrate: "cell", cell: {sandbox: true}}, {agent: "inbox"}]) assert.doesNotThrow(() => assertConfinedSpawn(params, {confinement: "confined"}));
});

test("no false positives: host CLI, registered Apiary service, and host HSR bee", () => {
  for (const attribution of [undefined, "hsr"]) {
    const confinement = peerConfinement(peer, {proc: reader(), substrate: () => attribution ?? null});
    assert.equal(confinement, "unconfined");
    for (const params of forbidden) assert.doesNotThrow(() => assertConfinedSpawn(params, {confinement}));
  }
  for (const params of forbidden) {
    assert.doesNotThrow(() => assertConfinedSpawn(params, {confinement: "confined", spawnServiceAuthority: true}));
    assert.doesNotThrow(() => assertConfinedSpawn(params, {confinement: "unknown"}));
  }
});

test("confined credential and service registration verbs are refused", () => {
  for (const verb of ["account.lease.export", "account.credentials.export", "account.credentials.status", "account.credentials.refresh", "rpc.localTrust.challenge", "rpc.localTrust.register"]) {
    assert.throws(() => assertConfinedVerb(verb, "confined"), error => error instanceof RpcError && error.code === "confined_peer_refused");
    for (const state of ["unconfined", "unknown"] as const) assert.doesNotThrow(() => assertConfinedVerb(verb, state));
  }
});

test("runtime namespace follows the sandbox child rather than its host wrapper", async () => {
  const {runtimeUserNamespace} = await import("../src/confinedPeer.ts");
  for (const isolated of [true, false]) {
    const proc = reader({open: pid => pid, children: fd => fd === 1 ? [2] : [], userns: fd => fd === 2 && isolated ? "user:[2]" : "user:[1]"});
    assert.equal(runtimeUserNamespace(1, proc), isolated ? "different" : "same");
  }
});

test("confined allowlist denies every other verb including transcript and all placement indirections", async () => {
  const {ConfinedAdmission} = await import("../src/confinedPeer.ts");
  const {RPC_VERBS} = await import("../src/protocol.ts");
  const admission = new ConfinedAdmission();
  const identity = {beeId: "self", generation: 1, parentId: "parent", canSend: (id: string) => id === "parent"};
  const allowed = new Set(["view", "list", "send", "question.ask", "seal.create"]);
  for (const verb of [...RPC_VERBS, "bee.transcript", "future.verb"]) {
    if (allowed.has(verb)) continue;
    assert.throws(() => admission.admit(verb, {}, identity), error => error instanceof RpcError && error.code === "confined_peer_refused", verb);
  }
  for (const verb of ["view", "question.ask", "seal.create"]) {
    assert.equal(admission.admit(verb, {}, identity).beeId, "self");
    assert.throws(() => admission.admit(verb, {beeId: "other"}, identity));
  }
  assert.deepEqual(admission.admit("list", {}, identity), {});
  assert.throws(() => admission.admit("list", {beeId: "other"}, identity));
  assert.throws(() => admission.admit("send", {beeId: "other", body: "x"}, identity));
  assert.throws(() => admission.admit("send", {beeId: "parent", sender: "operator", body: "x"}, identity));
  assert.throws(() => admission.admit("send", {beeId: "parent", body: "x"}, {...identity, canSend: () => false}));
  assert.throws(() => admission.admit("send", {beeId: "parent", body: "x", node: "remote"}, identity));
  const sent = admission.admit("send", {beeId: "parent", body: "x", urgency: "now", idempotencyKey: "key"}, identity);
  assert.equal(sent.sender, "self");
  assert.equal(sent.urgency, "next");
  assert.notEqual(sent.idempotencyKey, "key");
  assert.equal(sent.idempotencyKey, admission.admit("send", {beeId: "parent", body: "x", idempotencyKey: "key"}, {...identity, generation: 2}).idempotencyKey);
});

test("confined writes enforce UTF-8 size and per-bee rate bounds across generations", async () => {
  const {ConfinedAdmission} = await import("../src/confinedPeer.ts");
  const identity = {beeId: "self", generation: 1, parentId: "parent", canSend: () => true};
  for (const [verb, limit, params] of [["send", 60, {beeId: "parent", body: "x"}], ["question.ask", 12, {text: "x"}], ["seal.create", 12, {title: "x"}]] as const) {
    const policy = new ConfinedAdmission();
    for (let i = 0; i < limit; i++) policy.admit(verb, params, {...identity, generation: i + 1}, 1000);
    assert.throws(() => policy.admit(verb, params, identity, 2000));
    assert.doesNotThrow(() => policy.admit(verb, params, identity, 61000));
  }
  const policy = new ConfinedAdmission();
  for (const [verb, params] of [["send", {beeId: "parent", body: "x".repeat(65537)}], ["question.ask", {text: "ø".repeat(4097)}], ["seal.create", {title: "x".repeat(513)}], ["question.ask", {text: "x", options: Array(33).fill("x")}], ["seal.create", {title: "x", refs: ["x".repeat(1025)]}], ["question.ask", {text: "x", id: "x".repeat(129)}]] as const) assert.throws(() => policy.admit(verb, params, identity));
});

test("bwrap mode detects the setuid bit on the resolved executable", async () => {
  const {bwrapMode} = await import("../src/confinedPeer.ts");
  const {mkdtempSync, writeFileSync, chmodSync, realpathSync} = await import("node:fs");
  const {tmpdir} = await import("node:os");
  const {join} = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "hb-bwrap-mode-"));
  const file = join(dir, "bwrap");
  writeFileSync(file, "fixture");
  chmodSync(file, 0o755);
  assert.deepEqual(bwrapMode(dir), {path: realpathSync(file), setuid: false});
  chmodSync(file, 0o4755);
  assert.deepEqual(bwrapMode(dir), {path: realpathSync(file), setuid: true});
});
