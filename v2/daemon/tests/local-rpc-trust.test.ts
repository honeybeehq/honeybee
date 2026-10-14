import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync, symlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalRpcTrust, localTrustMessage, type LocalTrustChallenge } from "../src/localRpcTrust.ts";
import { LocalRpcRefusals } from "../src/localRpcRefusals.ts";
import type { PeerConnection } from "../src/peerCredentials.ts";
import { RPC_ACCESS } from "../src/rpcAccess.ts";
import { RPC_VERBS } from "../src/protocol.ts";
const peer = (pid: number, birth = "birth"): PeerConnection => ({state: "verified", peer: {uid: process.geteuid!(), pid, processBirth: birth}, current: () => true, close() {}});
const reason = (value: string) => (error: unknown) => (error as {details?: {reason?: string}}).details?.reason === value;

test("trust off never creates a key and access classification covers every verb", () => {
  const root = mkdtempSync(join(tmpdir(), "rpc-trust-off-"));
  const file = join(root, "private", "key");
  const trust = new LocalRpcTrust({requireObservationCaller: false, registrationKeyFile: file}, root, () => {});
  try {
    assert.equal(trust.state, "off");
    trust.require({state: "degraded", close() {}}, "local_unix");
    assert.equal(existsSync(file), false);
    assert.deepEqual(Object.keys(RPC_ACCESS).sort(), [...RPC_VERBS].sort());
  } finally { trust.close(); rmSync(root, {recursive: true, force: true}); }
});

test("birth-bound registration consumes its challenge, replaces another PID, and expires", () => {
  const root = mkdtempSync(join(tmpdir(), "rpc-trust-register-"));
  const file = join(root, "private", "key");
  let now = 1000;
  const audits: Array<{kind: string; data: Record<string, unknown>}> = [];
  const trust = new LocalRpcTrust({requireObservationCaller: true, registrationKeyFile: file}, root, (kind, data) => audits.push({kind, data}), () => now);
  try {
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(root, "private")).mode & 0o777, 0o700);
    const key = readFileSync(file);
    const a = peer(101), b = peer(202);
    const identity = {};
    const challenge = trust.challenge(a, identity, "local_unix");
    const token = createHmac("sha256", key).update(localTrustMessage(challenge)).digest("hex");
    assert.throws(() => trust.register({pid: 101, challengeId: challenge.challengeId, token}, a, {}, "local_unix"), reason("challenge_connection_mismatch"));
    trust.register({pid: 101, challengeId: challenge.challengeId, token}, a, identity, "local_unix");
    trust.require(a, "local_unix");
    assert.throws(() => trust.register({pid: 101, challengeId: challenge.challengeId, token}, a, identity, "local_unix"), reason("challenge_consumed"));
    assert.throws(() => trust.require(peer(101, "reused"), "local_unix"), reason("registration_required"));
    const second = trust.challenge(b, identity, "local_unix");
    trust.register({pid: 202, challengeId: second.challengeId, token: createHmac("sha256", key).update(localTrustMessage(second)).digest("hex")}, b, identity, "local_unix");
    assert.throws(() => trust.require(a, "local_unix"), reason("registration_required"));
    trust.require(b, "local_unix");
    assert.equal(audits[1]?.data.replacedPid, 101);
    now += 300_001;
    assert.throws(() => trust.require(b, "local_unix"), reason("registration_required"));
    const expired = trust.challenge(b, identity, "local_unix");
    now += 60_001;
    assert.throws(() => trust.register({pid: 202, challengeId: expired.challengeId, token: "0".repeat(64)}, b, identity, "local_unix"), reason("challenge_expired"));
    assert.equal(JSON.stringify(audits).includes(token), false);
    key.fill(0);
  } finally { trust.close(); rmSync(root, {recursive: true, force: true}); }
});

test("a corrupt key is never regenerated and unavailable credentials fail phase two", () => {
  const root = mkdtempSync(join(tmpdir(), "rpc-trust-corrupt-"));
  const file = join(root, "key");
  writeFileSync(file, "corrupt", {mode: 0o600});
  const trust = new LocalRpcTrust({requireObservationCaller: true, registrationKeyFile: file}, root, () => {});
  try {
    assert.equal(trust.state, "registration_key_unavailable");
    assert.throws(() => trust.require(peer(101), "local_unix"), reason("registration_key_unavailable"));
    assert.equal(readFileSync(file, "utf8"), "corrupt");
  } finally { trust.close(); rmSync(root, {recursive: true, force: true}); }
});

test("refusal audits have at most 128 keys and one overflow per window", () => {
  const rows: Array<Record<string, unknown>> = [];
  const refusals = new LocalRpcRefusals((_kind, data) => rows.push(data));
  for (let uid = 0; uid < 1000; uid++) for (let i = 0; i < 3; i++) refusals.record("local_peer_uid_mismatch", uid, uid + 1);
  refusals.flush();
  assert.equal(rows.length, 129);
  assert.equal(rows.reduce((sum, row) => sum + Number(row.count), 0), 3000);
  refusals.close();
  assert.equal(rows.length, 129);
});

test("reload invalidates registration, closes the owned key buffer, and keeps the stored key", () => {
  const root = mkdtempSync(join(tmpdir(), "rpc-trust-reload-"));
  const config = {requireObservationCaller: true, registrationKeyFile: join(root, "private", "key")};
  const trust = new LocalRpcTrust(config, root, () => {});
  const identity = {};
  const connection = peer(101);
  try {
    const challenge = trust.challenge(connection, identity, "local_unix");
    const key = readFileSync(config.registrationKeyFile);
    trust.register({pid: 101, challengeId: challenge.challengeId, token: createHmac("sha256", key).update(localTrustMessage(challenge)).digest("hex")}, connection, identity, "local_unix");
    trust.require(connection, "local_unix");
    const owned = (trust as unknown as {key: Buffer}).key;
    trust.reload(config, root);
    assert.equal(owned.every(byte => byte === 0), true);
    assert.ok(readFileSync(config.registrationKeyFile).equals(key), "reload preserves the private key");
    assert.throws(() => trust.require(connection, "local_unix"), reason("registration_required"));
    key.fill(0);
  } finally { trust.close(); rmSync(root, {recursive: true, force: true}); }
});


test("registration refuses a symlink or permissive parent without replacing the key", () => {
  for (const mode of ["symlink", "permissions"] as const) {
    const root = mkdtempSync(join(tmpdir(), "rpc-trust-path-"));
    const file = join(root, "key");
    const actual = join(root, "actual");
    writeFileSync(actual, Buffer.alloc(32, 7), {mode: 0o600});
    if (mode === "symlink") symlinkSync(actual, file);
    else { writeFileSync(file, Buffer.alloc(32, 9), {mode: 0o600}); chmodSync(root, 0o755); }
    const trust = new LocalRpcTrust({requireObservationCaller: true, registrationKeyFile: file}, root, () => {});
    try { assert.equal(trust.state, "registration_key_unavailable"); assert.ok(readFileSync(actual).every(byte => byte === 7)); }
    finally { trust.close(); rmSync(root, {recursive: true, force: true}); }
  }
});

test("other connections cannot exhaust challenge capacity before a fresh registration", () => {
  const root = mkdtempSync(join(tmpdir(), "rpc-trust-flood-"));
  const config = {requireObservationCaller: true, registrationKeyFile: join(root, "private", "key")};
  const trust = new LocalRpcTrust(config, root, () => {});
  try {
    for (let i = 0; i < 1000; i++) trust.challenge(peer(100 + i), {}, "local_unix");
    const identity = {};
    const connection = peer(9999);
    const challenge = trust.challenge(connection, identity, "local_unix");
    const key = readFileSync(config.registrationKeyFile);
    const token = createHmac("sha256", key).update(localTrustMessage(challenge)).digest("hex"); key.fill(0);
    trust.register({pid: 9999, challengeId: challenge.challengeId, token}, connection, identity, "local_unix");
    trust.require(connection, "local_unix");
    const pending = (trust as unknown as {challenges: Map<string, {connection: object; challenge: LocalTrustChallenge}>}).challenges;
    assert.ok(pending.size <= 128);
    const flood = {};
    for (let i = 0; i < 100; i++) trust.challenge(peer(8888), flood, "local_unix");
    assert.ok([...pending.values()].filter(value => value.connection === flood).length <= 2);
    for (let i = 0; i < 100; i++) trust.challenge(peer(7777), {}, "local_unix");
    assert.ok([...pending.values()].filter(value => value.challenge.pid === 7777).length <= 4);
  } finally { trust.close(); rmSync(root, {recursive: true, force: true}); }
});

test("global eviction chooses a busy process before a lone legitimate challenge", () => {
  const root = mkdtempSync(join(tmpdir(), "rpc-trust-fair-"));
  const config = {requireObservationCaller: true, registrationKeyFile: join(root, "private", "key")};
  const trust = new LocalRpcTrust(config, root, () => {});
  try {
    const identity = {}, connection = peer(9999);
    const challenge = trust.challenge(connection, identity, "local_unix");
    for (let i = 0; i < 4; i++) trust.challenge(peer(5555), {}, "local_unix");
    for (let i = 0; i < 123; i++) trust.challenge(peer(100 + i), {}, "local_unix");
    trust.challenge(peer(10000), {}, "local_unix");
    const key = readFileSync(config.registrationKeyFile);
    const token = createHmac("sha256", key).update(localTrustMessage(challenge)).digest("hex"); key.fill(0);
    trust.register({pid: 9999, challengeId: challenge.challengeId, token}, connection, identity, "local_unix");
    trust.require(connection, "local_unix");
  } finally { trust.close(); rmSync(root, {recursive: true, force: true}); }
});
