import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { harness, makeBee } from "./helpers.ts";
import { EffectKeyError } from "../src/effectResolve.ts";

const error = (code: string) => (value: unknown) => value instanceof EffectKeyError && value.code === code;
const covered = (store: ReturnType<ReturnType<typeof harness>["open"]>, suffix: string) => `effect-v1:${store.effectCoverage().coverageId}:${suffix}`;

test("effect resolve fences before late admission and retires every open, including clean reopen", () => {
  const h = harness(); let store = h.open();
  try {
    const identity = store.effectCoverage(), key = covered(store, "late");
    assert.equal(store.resolveEffect(key, "spawn").status, "never_seen_fenced");
    assert.deepEqual(store.resolveEffect(key, "spawn"), store.resolveEffect(key, "spawn"));
    assert.throws(() => store.lookupRpcResult(key), error("rpc_effect_fenced"));
    assert.throws(() => store.recordRpcResult(key, "spawn", null, {}), error("rpc_effect_fenced"));
    assert.throws(() => store.resolveEffect(key, "send"), error("idempotency_conflict"));
    store.close(); store = h.open();
    assert.equal(store.effectCoverage().ownerStoreId, identity.ownerStoreId);
    assert.notEqual(store.effectCoverage().coverageId, identity.coverageId);
    assert.throws(() => store.resolveEffect(key, "spawn"), error("rpc_effect_history_unknown"));
    assert.throws(() => store.lookupRpcResult(key), error("rpc_effect_fenced"));
  } finally { store.close(); h.cleanup(); }
});

test("effect receipt and durable mail commit together, survive pruning and reopen", () => {
  const h = harness(); let store = h.open({ maxRpcIdempotencyRows: 1 });
  try {
    const { bee } = makeBee(store), key = covered(store, "mail");
    const send = store.transact(() => {
      const mail = store.send(bee.id, "once");
      store.recordRpcResult(key, "send", mail.wakeCommand?.id ?? null, { messageId: mail.message.id });
      return mail;
    });
    for (let i = 0; i < 5; i++) store.recordRpcResult(`other-${i}`, "view", null, {});
    const result = store.resolveEffect(key, "send");
    assert.equal(result.status, "committed");
    if (result.status === "committed") assert.deepEqual(result.receipt.result, { messageId: send.message.id });
    store.close(); store = h.open();
    assert.equal(store.resolveEffect(key, "send").status, "committed");
    assert.equal(store.listMessages(bee.id).length, 1);
    assert.throws(() => store.resolveEffect("unprovable-legacy", "send"), error("rpc_effect_history_unknown"));
  } finally { store.close(); h.cleanup(); }
});

test("effect admission rollback leaves neither mail nor receipt; query fences; forwarding stays absent", async () => {
  const h = harness(), store = h.open();
  try {
    const { bee } = makeBee(store), key = covered(store, "rollback"); let forwards = 0;
    assert.throws(() => store.transact(() => {
      store.send(bee.id, "must rollback");
      store.afterCommit(() => { forwards++; });
      store.recordRpcResult(key, "send", null, { messageId: 123 });
      throw new Error("fault-before-commit");
    }), /fault-before-commit/);
    await Promise.resolve();
    assert.equal(forwards, 0);
    assert.equal(store.listMessages(bee.id).length, 0);
    assert.equal(store.resolveEffect(key, "send").status, "never_seen_fenced");
  } finally { store.close(); h.cleanup(); }
});

test("effect query never fences in-flight work and command admission is committed, not in-flight", () => {
  const h = harness(), store = h.open();
  try {
    const { bee } = makeBee(store), key = covered(store, "archive");
    assert.equal(store.resolveEffect(key, "archive", true).status, "in_flight");
    store.transact(() => {
      const cmd = store.enqueueCommand("archive", bee.id, {}, { idempotencyKey: key });
      store.recordRpcResult(key, "archive", cmd.id, { commandId: cmd.id });
    });
    const result = store.resolveEffect(key, "archive", true);
    assert.equal(result.status, "committed");
    if (result.status === "committed") assert.equal(result.commandStatus, "queued");
    const fence = covered(store, "core-fallback"); store.resolveEffect(fence, "archive");
    assert.throws(() => store.enqueueCommand("archive", bee.id, {}, { idempotencyKey: fence }), error("rpc_effect_fenced"));
  } finally { store.close(); h.cleanup(); }
});

test("effect additive tables preserve schema44 and retained legacy positives bootstrap", () => {
  const h = harness(); let store = h.open(); store.close();
  const db = new DatabaseSync(h.path);
  db.exec("DROP TABLE rpc_effect_keys");
  db.prepare("INSERT INTO rpc_idempotency VALUES(?,?,?,?,?)").run("legacy-seen", "spawn", null, JSON.stringify({ beeId: "known" }), 1);
  db.close();
  store = h.open();
  try {
    assert.equal(store.resolveEffect("legacy-seen", "spawn").status, "committed");
    assert.throws(() => store.resolveEffect("legacy-absent", "spawn"), error("rpc_effect_history_unknown"));
  } finally { store.close(); }
  const inspect = new DatabaseSync(h.path, { readOnly: true });
  try { assert.equal(inspect.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value, "44"); }
  finally { inspect.close(); h.cleanup(); }
});

test("effect upgrade preserves legal long legacy keys and unrelated keyed verbs", () => {
  const h = harness(); let store = h.open(); store.close();
  const long = "legacy-" + "x".repeat(2048), db = new DatabaseSync(h.path);
  db.prepare("INSERT INTO rpc_idempotency VALUES(?,?,?,?,?)").run(long, "spawn", null, JSON.stringify({ beeId: "legacy-long" }), 1);
  db.close(); store = h.open();
  try {
    assert.equal(store.resolveEffect(long, "spawn").status, "committed");
    const unrelated = "other-" + "y".repeat(4096);
    store.recordRpcResult(unrelated, "bee.tag", null, { applied: true });
    assert.deepEqual(store.lookupRpcResult(unrelated)?.result, { applied: true });
    assert.throws(() => store.resolveEffect(unrelated, "send"), error("idempotency_conflict"));
  } finally { store.close(); h.cleanup(); }
});

test("effect owner corruption fails closed with the real ledger error, never second-writer", () => {
  const h = harness(), store = h.open(); store.close();
  const db = new DatabaseSync(h.path);
  db.prepare("UPDATE meta SET value='corrupt' WHERE key='rpc_effect_owner'").run(); db.close();
  try { assert.throws(() => h.open(), value => value instanceof EffectKeyError && /Corrupt effect owner/.test(value.message)); }
  finally { h.cleanup(); }
});
