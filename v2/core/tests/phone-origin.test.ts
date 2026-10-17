import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { harness, makeBee } from "./helpers.ts";
import { PHONE_FORMAT, parsePhoneOrigin, phoneDigest, renderPhoneInput, type PhoneOriginRequest } from "../src/phoneOrigin.ts";
import { replayAudit, SCHEMA_VERSION } from "../src/index.ts";

const corpusBytes = readFileSync(new URL("./fixtures/phone-origin-vectors.json", import.meta.url));
const corpus = JSON.parse(corpusBytes.toString()) as { vectors: { id: string; input: string; expectedFrame: string }[] };
test("shared phone fixture is the exact Queen-approved 42-vector corpus", () => {
  assert.equal(createHash("sha256").update(corpusBytes).digest("hex"), "8c899e78b2d176b17ac9724e61e22ca1ef14d77cee0faedf39d69c2a91ee3515");
  assert.equal(corpus.vectors.length, 42);
});
for (const vector of corpus.vectors) test(`phone frame exact UTF-8: ${vector.id}`, () => {
  assert.deepEqual(Buffer.from(renderPhoneInput(vector.input)), Buffer.from(vector.expectedFrame));
});
export function origin(id: string): PhoneOriginRequest {
  return { format: PHONE_FORMAT, channel: "phone", issuerNodeId: "test-node", assigner: "listener/1", credentialRef: "opaque-device", target: { kind: "bee", id }, contentKind: "message", assurance: "credential-possession-only", humanApproval: "not-verified", lane: "envelope-v1", parentSources: [], rootSources: [], ancestry: "complete" };
}
test("phone schema refuses positive assurance and caller digests; overflow is unknown", () => {
  for (const extra of [{ assurance: "verified" }, { humanApproval: "verified" }, { channel: "human" }, { contentDigest: "caller" }, { assignerRole: "coordinator" }]) assert.throws(() => parsePhoneOrigin({ ...origin("b"), ...extra }));
  const parent = { ownerStoreId: "o", admissionId: "a", contentDigest: phoneDigest("x"), relation: "forward" };
  const result = parsePhoneOrigin({ ...origin("b"), parentSources: Array.from({ length: 9 }, () => parent) });
  assert.equal(result.ancestry, "unknown-overflow");
  assert.equal(result.parentSources.length, 8);
  assert.throws(() => renderPhoneInput("\ud800"));
});
test("phone data, shadow, history, audit replay and key bindings survive reopen without a schema bump", () => {
  const h = harness(); let store = h.open();
  try {
    const { bee } = makeBee(store);
    const body = "a\0<&\t\n😀";
    const message = store.transact(() => {
      store.bindPhoneAdmission("k", "send", "envelope-v1", "digest");
      const sent = store.send(bee.id, body, { phone: { origin: origin(bee.id), key: "k" } });
      store.recordRpcResult("k", "send", sent.wakeCommand?.id ?? null, { messageId: sent.message.id });
      return sent.message;
    });
    assert.equal(SCHEMA_VERSION, 44);
    assert.equal(message.body, renderPhoneInput(body));
    assert.equal(message.phoneInput?.originalContent, body);
    assert.equal(message.phoneInput?.envelope.contentDigest, phoneDigest(body));
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    assert.throws(() => store.checkPhoneBinding("k", "send", "interim-v1", "digest"));
    assert.throws(() => store.checkPhoneBinding("k", "send", "envelope-v1", "changed"));
    store.close(); store = h.open();
    assert.deepEqual(store.getMessage(message.id), message);
    assert.deepEqual(store.mailHistory().messages[0]?.phoneOrigin, message.phoneInput!.envelope);
    assert.deepEqual(store.pendingMail(bee.id).messages[0]?.phoneOrigin, message.phoneInput!.envelope);
    store.checkPhoneBinding("k", "send", "envelope-v1", "digest");
    assert.equal(store.resolveEffect("k", "send").status, "committed");
  } finally { store.close(); h.cleanup(); }
});
test("phone admission rollback leaves no mail, binding or effect; ordinary mail stays origin unknown", () => {
  const h = harness(), store = h.open();
  try {
    const { bee } = makeBee(store);
    assert.throws(() => store.transact(() => { store.bindPhoneAdmission("rollback", "send", "envelope-v1", "d"); store.send(bee.id, "x", { phone: { origin: origin(bee.id), key: "rollback" } }); throw Error("crash"); }));
    assert.equal(store.listMessages(bee.id).length, 0);
    assert.equal(store.lookupRpcResult("rollback"), null);
    store.checkPhoneBinding("rollback", "send", "interim-v1", "other");
    const legacy = store.send(bee.id, "hello").message;
    assert.equal(legacy.phoneInput, undefined);
  } finally { store.close(); h.cleanup(); }
});
test("forward and summary preserve durable roots and never claim unresolved ancestry is clean", () => {
  const h = harness(), store = h.open();
  try {
    const { bee } = makeBee(store);
    const first = store.send(bee.id, "root", { phone: { origin: origin(bee.id), key: "root" } }).message.phoneInput!;
    const ref = { ownerStoreId: first.envelope.ownerStoreId, admissionId: first.envelope.admissionId, contentDigest: first.envelope.contentDigest, relation: "summary" as const };
    const next = store.send(bee.id, "summary", { phone: { origin: { ...origin(bee.id), parentSources: [ref], rootSources: [] }, key: "summary" } }).message;
    assert.deepEqual(next.phoneInput!.envelope.rootSources, first.envelope.rootSources);
    assert.equal(next.phoneInput!.envelope.humanApproval, "not-verified");
    const unknown = store.send(bee.id, "unknown", { phone: { origin: { ...origin(bee.id), parentSources: [{ ...ref, admissionId: "missing" }] }, key: "missing" } }).message;
    assert.equal(unknown.phoneInput!.envelope.ancestry, "unknown-overflow");
  } finally { store.close(); h.cleanup(); }
});
