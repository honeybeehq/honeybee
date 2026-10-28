import { test } from "node:test";
import assert from "node:assert/strict";
import { SatelliteEligibility, eligibilityFields, eligibilityDigest, type EligibilityQuery } from "../src/satelliteEligibility.ts";

const registration = () => ({ daemonInstanceId: "daemon", registrationEpoch: "epoch", expiresAtMs: Date.now() + 60_000 });
const answer = (q: EligibilityQuery, eligible: boolean) => ({ ...q, fields: undefined, eligible, ...(eligible ? { satellite: { nodeId: "worker", name: "Satellite" } } : {}) });
function reply(q: EligibilityQuery, eligible: boolean) { const { fields: _fields, operation: _operation, ...value } = answer(q, eligible); return value; }

test("no subscriber admits immediately; raw forwarding keeps exact values and field presence", async () => {
  const broker = new SatelliteEligibility();
  assert.deepEqual(await broker.request("spawn", { agent: "stub" }), { eligible: false, reason: "no_subscription" });
  assert.deepEqual(eligibilityFields({ agent: "stub", account: "auto", requiredCapability: " custom:value ", prompt: "not sent", env: { secret: "not sent" } }), { agent: "stub", account: "auto", requiredCapability: " custom:value " });
  assert.notEqual(eligibilityDigest(registration(), "local", "spawn", {}), eligibilityDigest(registration(), "local", "spawn", { account: null }));
  assert.equal(eligibilityFields({ requiredCapability: "" }), null);
});

test("a registered subscription carries positive and negative answers for one request only", async () => {
  const broker = new SatelliteEligibility(); const identity = {}; const reg = registration();
  for (const eligible of [true, false]) {
    const poll = broker.subscribe(identity, "local", reg, () => true);
    const pending = broker.request("spawn", { agent: "stub", idempotencyKey: "same-key" });
    const [q] = (await poll).queries;
    assert.equal(q!.fields.agent, "stub");
    assert.deepEqual(broker.answer(identity, reply(q!, eligible)), { accepted: true });
    assert.deepEqual(await pending, eligible ? { eligible: true, satellite: { nodeId: "worker", name: "Satellite" } } : { eligible: false, reason: "no_candidate" });
    assert.deepEqual(broker.answer(identity, reply(q!, true)), { accepted: false });
  }
  broker.drop("no_subscription");
});

test("unreachable subscriber times out, replacement drops pending queries, and late answers cannot deny", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const broker = new SatelliteEligibility(1500); const identity = {}; const reg = registration();
  const poll = broker.subscribe(identity, "local", reg, () => true);
  const pending = broker.request("spawn", { agent: "stub" });
  const [q] = (await poll).queries;
  t.mock.timers.tick(1500);
  assert.deepEqual(await pending, { eligible: false, reason: "timeout" });
  assert.deepEqual(broker.answer(identity, reply(q!, true)), { accepted: false });
  const poll2 = broker.subscribe(identity, "local", reg, () => true);
  const pending2 = broker.request("spawn", { agent: "stub" });
  await poll2;
  broker.drop("registration_expired");
  assert.deepEqual(await pending2, { eligible: false, reason: "registration_expired" });
  assert.throws(() => broker.answer(identity, reply(q!, true)), { code: "caller_not_trusted" });
});

test("disconnect and queue overflow fall back; stale digest and self-candidate never deny", async () => {
  const broker = new SatelliteEligibility(1500, 1); const identity = {}; const reg = registration();
  let poll = broker.subscribe(identity, "local", reg, () => true);
  let pending = broker.request("spawn", { agent: "stub" });
  let [q] = (await poll).queries;
  assert.deepEqual(await broker.request("spawn", {}), { eligible: false, reason: "queue_full" });
  broker.answer(identity, { ...reply(q!, true), requestDigest: "wrong" });
  assert.deepEqual(await pending, { eligible: false, reason: "digest_mismatch" });
  poll = broker.subscribe(identity, "local", reg, () => true);
  pending = broker.request("spawn", { agent: "stub" }); [q] = (await poll).queries;
  broker.answer(identity, { ...reply(q!, true), satellite: { nodeId: "local", name: "self" } });
  assert.deepEqual(await pending, { eligible: false, reason: "malformed" });
  poll = broker.subscribe(identity, "local", reg, () => true);
  pending = broker.request("spawn", {}); await poll;
  broker.disconnect(identity);
  assert.deepEqual(await pending, { eligible: false, reason: "no_subscription" });
});


test("keyed concurrent queries share only their pending attempt, never the later fleet answer", async () => {
  const broker = new SatelliteEligibility(); const identity = {}; const reg = registration();
  const poll = broker.subscribe(identity,"local",reg,() => true);
  const first = broker.request("spawn",{agent:"stub",idempotencyKey:"retry"});
  const joined = broker.request("spawn",{agent:"stub",idempotencyKey:"retry"});
  assert.equal(first,joined);
  const {queries} = await poll; assert.equal(queries.length,1);
  broker.answer(identity,reply(queries[0]!,true)); assert.equal((await first).eligible,true);
  const poll2 = broker.subscribe(identity,"local",reg,() => true);
  const later = broker.request("spawn",{agent:"stub",idempotencyKey:"retry"});
  const {queries:next} = await poll2; broker.answer(identity,reply(next[0]!,false));
  assert.deepEqual(await later,{eligible:false,reason:"no_candidate"});
  broker.drop("no_subscription");
});


test("carried answers are single-use and competing subscriptions cannot take over", async () => {
  const broker = new SatelliteEligibility(); const reg = registration();
  const fields = eligibilityFields({agent:"stub",idempotencyKey:"carried"})!;
  const value = {version:1,queryId:"one-use",daemonInstanceId:reg.daemonInstanceId,registrationEpoch:reg.registrationEpoch,destinationNodeId:"local",requestDigest:eligibilityDigest(reg,"local","spawn",fields,"apiary-routed"),expiresAtMs:Date.now()+1500,eligible:true,satellite:{nodeId:"worker",name:"Worker"}};
  assert.equal((await broker.request("spawn",fields,{value,registration:reg},"apiary-routed")).eligible,true);
  assert.deepEqual(await broker.request("spawn",fields,{value,registration:reg},"apiary-routed"),{eligible:false,reason:"digest_mismatch"});
  const identity = {}; const poll = broker.subscribe(identity,"local",reg,()=>true);
  assert.throws(()=>broker.subscribe({},"local",reg,()=>true),{code:"caller_not_trusted"});
  assert.throws(()=>broker.subscribe(identity,"local",reg,()=>true),{code:"invalid_request"});
  broker.drop("no_subscription"); assert.deepEqual(await poll,{queries:[]});
});
