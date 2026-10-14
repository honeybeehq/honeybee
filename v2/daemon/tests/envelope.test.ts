/**
 * Sender-attribution envelope (contract B4a): bee-sent mail is delivered
 * wrapped in the v1-byte-compatible buz injection envelope; operator and
 * human mail is delivered bare. Unit tier on envelope.ts plus one loop-level
 * proof that the delivery loop hands the driver the enveloped text.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ANSWER_INJECTION_MARKER, AUTOMATION_INJECTION_MARKER, BUZ_INJECTION_MARKER, DELIVERY_INTERRUPT_NOTICE, REMOTE_SENDER_RE, deliveryText, isPeerSender, urgencyToTier } from "../src/envelope.ts";

const baseMsg = { id: 7, body: "shard 3 is yours", urgency: "next" as const, enqueuedAt: 1_787_000_000_000 };

test("envelope.1: bee-sent mail wraps in the v1 envelope — marker, one parseable meta line, blank line, body verbatim", () => {
  const text = deliveryText({ ...baseMsg, sender: "CL.6d44f" }, true);
  const lines = text.split("\n");
  assert.equal(lines[0], BUZ_INJECTION_MARKER);
  const meta = JSON.parse(lines[1] as string) as Record<string, unknown>;
  // The exact contract of Apiary's parseBuzInjectionMeta: version 1, from set.
  assert.equal(meta.version, 1);
  assert.equal(meta.from, "CL.6d44f");
  assert.equal(meta.tier, "next-tool");
  assert.equal(meta.id, "7");
  assert.equal(meta.sentAt, new Date(baseMsg.enqueuedAt).toISOString());
  assert.equal(lines[2], "");
  assert.equal(lines.slice(3).join("\n"), "shard 3 is yours");
});

test("envelope.2: only POSITIVELY-identified peers envelope — operator, humans, and answeredBy names stay bare", () => {
  assert.equal(deliveryText({ ...baseMsg, sender: "operator" }, false), baseMsg.body);
  const none = (): boolean => false;
  const knows = (id: string): boolean => id === "some-uuid";
  assert.equal(isPeerSender("operator", knows), false, "operator never envelopes, even if a bee had that id");
  assert.equal(isPeerSender("human:tormod", none), false);
  assert.equal(isPeerSender("tormod", none), false, "answeredBy names are people (v6.rpc.6)");
  assert.equal(isPeerSender("CO.a3f", none), true, "handle grammar is peer evidence");
  assert.equal(
    isPeerSender("b7cd0186-d02e-4337-87af-e6679402aa65", none),
    true,
    "a validated v2 bee id remains peer evidence after its bee is removed",
  );
  assert.equal(isPeerSender("some-uuid", knows), true, "a store-known bee id is peer evidence");
  assert.equal(isPeerSender("some-uuid", none), false);
});

test("envelope.3: tier mapping matches the Q2 amendment", () => {
  assert.equal(urgencyToTier("now"), "interrupt");
  assert.equal(urgencyToTier("next"), "next-tool");
  assert.equal(urgencyToTier("idle"), "queue");
});

test("envelope.remote: a relayed agent on another authority is a peer; malformed claims are not", () => {
  const none = (): boolean => false;
  assert.equal(isPeerSender("remote:trmd-studio/CL.527d", none), true);
  const text = deliveryText({ ...baseMsg, sender: "remote:trmd-studio/CL.527d" }, true);
  assert.equal(JSON.parse(text.split("\n")[1] as string).from, "remote:trmd-studio/CL.527d");
  for (const bad of ["remote:", "remote:studio", "remote:studio/", "remote:/CL.1", "remote:a b/CL.1", "remote:a/b/c", "remote:a/CL.1\n"]) {
    assert.equal(REMOTE_SENDER_RE.test(bad), false, bad);
  }
});

test("envelope.5: the interrupt notice sits between the blank line and the body, for peer mail only", () => {
  const msg = { ...baseMsg, urgency: "now" as const, sender: "CL.6d44f" };
  const plain = deliveryText(msg, true);
  const noticed = deliveryText(msg, true, true);
  assert.equal(deliveryText(msg, true, false), plain);
  assert.equal(noticed, plain.replace(/shard 3 is yours$/, `${DELIVERY_INTERRUPT_NOTICE}\n\nshard 3 is yours`));
  assert.equal(noticed.split("\n")[1], plain.split("\n")[1]);
  assert.equal(deliveryText({ ...msg, sender: "operator" }, false, true), baseMsg.body);
  assert.ok(!DELIVERY_INTERRUPT_NOTICE.includes("\n"));
});

test("envelope.answer: a question answer carries the answer marker and its questionId, for people and peers alike", () => {
  const msg = { ...baseMsg, sender: "tormod", body: "[answer to question q-1] rebase\n\n(question was: merge or rebase?)" };
  const text = deliveryText(msg, false, false, "q-1");
  const lines = text.split("\n");
  assert.equal(lines[0], ANSWER_INJECTION_MARKER);
  assert.deepEqual(JSON.parse(lines[1] as string), {
    version: 1,
    kind: "answer",
    questionId: "q-1",
    from: "tormod",
    id: "7",
    sentAt: new Date(baseMsg.enqueuedAt).toISOString(),
  });
  assert.equal(lines[2], "");
  assert.equal(lines.slice(3).join("\n"), msg.body);
  const peer = deliveryText({ ...msg, sender: "CL.6d44f" }, true, false, "q-1");
  assert.equal(peer.split("\n")[0], ANSWER_INJECTION_MARKER);
  assert.equal(JSON.parse(peer.split("\n")[1] as string).from, "CL.6d44f");
  assert.equal(deliveryText(msg, false, false, null), msg.body);
  assert.ok(!ANSWER_INJECTION_MARKER.includes("\n"));
  assert.notEqual(ANSWER_INJECTION_MARKER, BUZ_INJECTION_MARKER);
});

test("envelope.automation: an automated send carries the automation marker and its senderKind; human and unmarked sends stay bare", () => {
  const msg = { ...baseMsg, sender: "operator", senderKind: "automation" as const, body: "Nightly report ready." };
  const lines = deliveryText(msg, false).split("\n");
  assert.equal(lines[0], AUTOMATION_INJECTION_MARKER);
  assert.deepEqual(JSON.parse(lines[1] as string), {
    version: 1,
    kind: "automation",
    senderKind: "automation",
    from: "operator",
    id: "7",
    sentAt: new Date(baseMsg.enqueuedAt).toISOString(),
  });
  assert.equal(lines[2], "");
  assert.equal(lines.slice(3).join("\n"), msg.body);
  assert.equal(deliveryText({ ...msg, senderKind: "human" }, false), msg.body);
  assert.equal(deliveryText({ ...msg, senderKind: undefined }, false), msg.body);
  assert.equal(deliveryText({ ...msg, sender: "CL.6d44f" }, true).split("\n")[0], BUZ_INJECTION_MARKER);
  assert.equal(deliveryText(msg, false, false, "q-1").split("\n")[0], ANSWER_INJECTION_MARKER);
  assert.ok(!AUTOMATION_INJECTION_MARKER.includes("\n"));
  assert.notEqual(AUTOMATION_INJECTION_MARKER, BUZ_INJECTION_MARKER);
});
