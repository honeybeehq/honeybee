import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { QUESTION_DISMISSAL_RESULTS, QUESTION_DISMISSAL_AUDITS, projectQuestionDismissalResult, projectQuestionDismissalDelta } from "../src/questionDismissalProjection.ts";
import { protocolTypeCensus } from "./protocolTypeCensus.ts";
import { deliveryText, deliveryPointer, QUESTION_DISMISSED_MARKER } from "../src/envelope.ts";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const protocol = resolve(root, "v2/daemon/src/protocol.ts"), daemon = resolve(root, "v2/daemon/src/daemon.ts"), store = resolve(root, "v2/core/src/store.ts");
const mirror = resolve(root, "v2/core/src/mirror.ts");
const census = (patches: ReadonlyMap<string, (source: string) => string> = new Map()) => protocolTypeCensus(["QuestionRow", "MirrorQuestionRow", "QuestionDismissedEvent"], patches, new Map([["mirror", mirror]]));
const sorted = (value: { values: readonly string[]; audits: readonly string[] }) => ({ values: [...new Set(value.values)].sort(), audits: [...new Set(value.audits)].sort() });
function assertCovered(actual: ReturnType<typeof census>): void {
  assert.deepEqual(actual.modules, {mirror: {MirrorQuestionRow: {values: [""], audits: []}, MirrorSnapshot: {values: ["questions[]"], audits: []}, MirrorDelta: {values: [], audits: [""]}, QuestionDismissedEvent: {values: [""], audits: []}}}, "Question mirror census differs from egress coverage");
  assert.deepEqual(actual.results, Object.fromEntries(Object.entries(QUESTION_DISMISSAL_RESULTS).map(([name, value]) => [name, sorted(value)])), "Question protocol census differs from egress coverage");
  assert.deepEqual(actual.audits, QUESTION_DISMISSAL_AUDITS, "Question audit census differs from egress coverage");
  assert.deepEqual(actual.dispatch, Object.fromEntries(Object.values(QUESTION_DISMISSAL_RESULTS).flatMap(value => value.verbs.map(verb => [verb, sorted(value)]))), "Question dispatch census differs from egress coverage");
}

test("dismissal census covers every typed result, dispatch and inferred row/event audit payload", () => {
  const actual = census(); assertCovered(actual); console.log(JSON.stringify({ questionDismissalTypeCensus: actual }));
});

test("dismissal census rejects uncovered question/result, dispatch and dismissal event paths", () => {
  for (const patches of [
    new Map([[mirror, (source: string) => source + '\nexport interface UncoveredMirrorResult {nested: MirrorQuestionRow}\n']]),
    new Map([[protocol, (source: string) => source + '\nexport interface UncoveredQuestionResult { nested: MirrorQuestionRow }\n']]),
    new Map([[daemon, (source: string) => source.replace('case "snapshot": {', 'case "uncovered": return { nested: this.mustStore().getQuestion("probe") };\n      case "snapshot": {')]]),
    new Map([[store, (source: string) => source + '\nfunction censusProbe(store: {audit: (...args: unknown[]) => void}, event: import("./mirror.ts").QuestionDismissedEvent) { store.audit("uncovered", null, {nested: event}); }\n']]),
  ]) assert.throws(() => assertCovered(census(patches)), /census differs from egress coverage/);
});

test("legacy projection removes new fields, transforms dismissal rows/events and never mutates shared objects or user output", () => {
  const question = Object.freeze({ id: "q", status: "dismissed", answer: null, answeredAt: null, answeredBy: null, deliveryMessageId: null, withdrawalReason: null, withdrawnAt: null, dismissedAt: 12, dismissedBy: "rpc", dismissalMessageId: 7 });
  const expected = { id: "q", status: "withdrawn", answer: null, answeredAt: null, answeredBy: null, deliveryMessageId: null, withdrawalReason: "Dismissed without an answer", withdrawnAt: 12 };
  const caller = Object.freeze({ uid: 1000 });
  const events = Object.freeze([
    Object.freeze({ seq: 1, ts: 10, beeId: "bee", kind: "question.asked", payload: Object.freeze({ question: Object.freeze({ ...question, status: "open", dismissedAt: null, dismissedBy: null, dismissalMessageId: null }) }) }),
    Object.freeze({ seq: 2, ts: 12, beeId: "bee", kind: "question.dismissed", payload: Object.freeze({ questionId: "q", dismissedAt: 12, dismissedBy: "rpc", dismissalMessageId: 7, rpcCaller: caller }) }),
    Object.freeze({ seq: 3, ts: 13, beeId: "bee", kind: "action.put", payload: Object.freeze({ outputs: question }) }),
  ]);
  const result = Object.freeze({ question, questions: Object.freeze([question]), rows: events, outputs: question });
  for (const coverage of Object.values(QUESTION_DISMISSAL_RESULTS)) for (const verb of coverage.verbs) {
    assert.equal(projectQuestionDismissalResult(verb, result, ["question.dismissed.v1"]), result);
    const old = projectQuestionDismissalResult(verb, result, []) as typeof result;
    assert.equal(old.outputs, question);
    if (coverage.values.length) { if ("question" in old && coverage.values.some(path => path === "question")) assert.deepEqual(old.question, expected); }
    assert.equal(projectQuestionDismissalResult(verb, old, []), old);
  }
  const delta = Object.freeze({ type: "delta", baseSeq: 0, seq: 3, events });
  const legacy = projectQuestionDismissalDelta(delta, []) as typeof delta;
  const askedPayload = legacy.events[0]!.payload;
  assert.ok("question" in askedPayload);
  assert.equal(askedPayload.question.status, "open");
  assert.equal(Object.hasOwn(askedPayload.question, "dismissedAt"), false);
  assert.deepEqual(legacy.events[1], { seq: 2, ts: 12, beeId: "bee", kind: "question.withdrawn", payload: { questionId: "q", withdrawalReason: "Dismissed without an answer", withdrawnAt: 12, rpcCaller: caller } });
  assert.equal(legacy.events[2], events[2]);
  assert.equal(projectQuestionDismissalDelta(delta, ["question.dismissed.v1"]), delta);
  assert.equal(question.status, "dismissed"); assert.equal(events[1]!.kind, "question.dismissed");
  const wrapped = { status: "committed", receipt: { verb: "question.dismiss", result: { question } } };
  assert.deepEqual(projectQuestionDismissalResult("rpc.effect.resolve", wrapped, []), { ...wrapped, receipt: { ...wrapped.receipt, result: { question: expected } } });
});

test("dismissal notice has its dedicated envelope and file pointer, separate from byte-stable answer delivery", () => {
  const message = { id: 7, beeId: "bee", priority: 0, deliveredAt: null, deliveredGeneration: null, sender: "rpc", senderKind: "automation" as const, body: "Your question was dismissed without an answer.", urgency: "next" as const, enqueuedAt: 1000 };
  const text = deliveryText(message, false, false, null, "q");
  const [marker, metadata, blank, body] = text.split("\n");
  assert.equal(marker, QUESTION_DISMISSED_MARKER); assert.equal(blank, ""); assert.equal(body, message.body);
  assert.deepEqual(JSON.parse(metadata!), {version: 1, kind: "question.dismissed", questionId: "q", from: "rpc", id: "7", sentAt: new Date(1000).toISOString()});
  assert.equal(text.includes("answer to your question"), false);
  assert.match(deliveryPointer(message, "/fixture/notice", false, null, "q"), /^\[Hive notice that your question was dismissed\]; full text: \/fixture\/notice$/);
  assert.equal(deliveryText({...message, senderKind: undefined}, false, false, "q").includes('"kind":"answer"'), true);
});

test("absence of the owner mutation capability refuses before the client sends a dismissal", async () => {
  const {RpcServer} = await import("../src/rpc.ts");
  const {RpcClient} = await import("../../cli/src/client.ts");
  const {mkdtempSync, rmSync} = await import("node:fs"); const {tmpdir} = await import("node:os"); const {join} = await import("node:path");
  class LegacyOwner extends RpcServer { override get capabilities() {return super.capabilities.filter(capability => capability !== "question.dismiss.v1");} }
  const root = mkdtempSync(join(tmpdir(), "dismiss-unsupported-")); let dispatched = 0;
  const server = new LegacyOwner({socketPath: join(root, "rpc.sock"), log: () => {}, dispatch: () => {dispatched++; return {};}});
  let client: Awaited<ReturnType<typeof RpcClient.connect>> | undefined;
  try {
    await server.listen(); client = await RpcClient.connect(join(root, "rpc.sock"));
    await assert.rejects(client.request("question.dismiss", {questionId: "q", idempotencyKey: "k"}), (error: unknown) => error !== null && typeof error === "object" && "code" in error && error.code === "question_dismiss_unsupported");
    assert.equal(dispatched, 0);
  } finally {client?.close(); await server.close(); rmSync(root, {recursive: true, force: true});}
});
