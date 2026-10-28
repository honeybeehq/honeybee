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
