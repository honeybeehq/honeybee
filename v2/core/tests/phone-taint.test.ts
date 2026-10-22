import {test} from "node:test";
import assert from "node:assert/strict";
import {harness} from "./helpers.ts";
import {PHONE_FORMAT, type PhoneOriginRequest} from "../src/phoneOrigin.ts";
import {replayAudit} from "../src/audit.ts";

const origin: PhoneOriginRequest = {format: PHONE_FORMAT, channel: "phone", issuerNodeId: "fixture", assigner: "fixture-listener", credentialRef: "opaque", target: {kind: "crew", id: "fixture-crew"}, contentKind: "message", assurance: "credential-possession-only", humanApproval: "not-verified", lane: "envelope-v1", parentSources: [], rootSources: [], ancestry: "complete"};

test("delivery taint, child inheritance, crew sources and exact no-bee sentinel survive replay", () => {
  const h = harness(); let store = h.open();
  try {
    const parent = store.createBee({id: "parent", name: "parent", agent: "inbox", substrate: "hsr", cwd: ""}).bee;
    const message = store.send(parent.id, "phone input", {phone: {origin, key: "input"}}).message;
    assert.equal(store.getBee(parent.id)?.phoneOperationOrigin, undefined);
    store.ackMail(parent.id, message.id);
    assert.equal(store.getBee(parent.id)?.phoneOperationOrigin?.humanApproval, "not-verified");
    const child = store.createBee({id: "child", name: "child", agent: "inbox", substrate: "hsr", cwd: "", phonePrincipal: parent.id}).bee;
    assert.equal(child.phoneOperationOrigin?.targetBeeId, child.id);
    const derived = store.send(child.id, "summary omits all refs", {phonePrincipal: parent.id}).message;
    assert.ok(derived.phoneInput?.envelope.rootSources.some(source => source.admissionId === message.phoneInput!.envelope.admissionId));
    const crew = store.admitPhoneContent("crew bio", "crew-key", {...origin, contentKind: "crew-bio"});
    assert.equal(crew.phoneInput.envelope.targetBeeId, "");
    assert.equal(store.getBee(""), null);
    assert.equal(store.listMessages(parent.id).some(row => row.phoneInput?.envelope.admissionId === crew.phoneInput.envelope.admissionId), false);
    assert.equal(store.listMessages(child.id).some(row => row.phoneInput?.envelope.admissionId === crew.phoneInput.envelope.admissionId), false);
    assert.deepEqual(store.admitPhoneContent("crew bio", "crew-key", {...origin, contentKind: "crew-bio"}), {...crew, deduped: true});
    assert.throws(() => store.admitPhoneContent("changed", "crew-key", {...origin, contentKind: "crew-bio"}), {code: "idempotency_conflict"});
    const source = crew.phoneInput.envelope;
    const briefing = store.send(child.id, "bio briefing", {phone: {origin: {...origin, parentSources: [{ownerStoreId: source.ownerStoreId, admissionId: source.admissionId, contentDigest: source.contentDigest, relation: "bio-briefing"}]}, key: "briefing"}}).message;
    assert.equal(briefing.phoneInput?.envelope.ancestry, "complete");
    assert.throws(() => store.send(child.id, "forged source", {phone: {origin: {...origin, parentSources: [{ownerStoreId: source.ownerStoreId, admissionId: source.admissionId, contentDigest: `sha256:${"0".repeat(64)}`, relation: "bio-briefing"}]}, key: "forged"}}), {code: "invalid_request"});
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.close(); store = h.open();
    assert.equal(store.getBee(child.id)?.phoneOperationOrigin?.humanApproval, "not-verified");
    assert.deepEqual(store.admitPhoneContent("crew bio", "crew-key", {...origin, contentKind: "crew-bio"}), {...crew, deduped: true});
  } finally {store.close(); h.cleanup();}
});
