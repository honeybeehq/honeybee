import assert from "node:assert/strict";
import { mkdtempSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { openCoreStore, replayAudit } from "../../v2/core/src/index.ts";
import { MAIL_DELIVERY_CONFIRMATION_CAPABILITY as capability, MAIL_DELIVERY_RESULTS as registry, MAIL_DELIVERY_HIDDEN_AUDITS as hidden, projectMailDeliveryResult as project, projectMailDeliveryDelta as delta } from "../../v2/daemon/src/mailDeliveryProjection.ts";

const dir = mkdtempSync(join(process.env.TMPDIR, "legacy-"));
chmodSync(dir, 0o700);
let now = 1000;
const store = openCoreStore(join(dir, "core.sqlite"), { now: () => now++ });
const caps = process.argv.includes("--unprojected") ? [capability] : [];
const beeId = "projection-lab";
const body = '{"deliveryConfirmation":"user content","queueOrder":99,"lifecycle":{"state":"replaced"}}';
store.createBee({ id: beeId, name: beeId, agent: "stub", substrate: "hsr", cwd: dir });
store.updateRuntimeState(beeId, 1, "running");
const first = store.send(beeId, body, { urgency: "idle" }).message;
store.prepareUnknownDeliveryConfirmationIntent({ beeId, messageId: first.id, generation: 1 });
const heldView = store.view(beeId);
const heldPending = store.pendingMail(beeId);
const heldMailbox = { messages: store.listMessages(beeId) };
const later = store.send(beeId, body, { urgency: "idle" }).message;
const receipt = store.resolveDeliveryConfirmation({ action: "resend_anyway", beeId, messageId: first.id, generation: 1, idempotencyKey: "replace" });
const replacement = store.getMessage(receipt.replacementMessageId);
assert.equal(replacement.queueOrder, first.id);
assert.equal(replacement.replacesMessageId, first.id);
assert.deepEqual(store.pendingMail(beeId).messages.map(message => message.id), [replacement.id, later.id]);
const history = store.mailHistory();
const rows = store.auditRows();
const viewResult = { view: heldView, bee: store.getBee(beeId) };
const fixtures = {
  ViewResult: viewResult,
  ListResult: { views: [viewResult] },
  ChildrenResult: { children: [viewResult] },
  SnapshotResult: { seq: store.lastAuditSeq(), views: [viewResult] },
  MailboxResult: heldMailbox,
  MailHistoryResult: history,
  MailPendingResult: heldPending,
  AuditTailResult: { rows },
};
function at(value, path) {
  if (!path) return [value];
  const [part, ...rest] = path.split(".");
  const array = part.endsWith("[]"), key = array ? part.slice(0, -2) : part;
  return (array ? value[key] : [value[key]]).flatMap(item => at(item, rest.join(".")));
}
function strictMessage(message) {
  for (const field of ["deliveryConfirmation", "queueOrder", "replacesMessageId"]) assert.equal(Object.hasOwn(message, field), false, field);
  if (message.lifecycle) assert.ok(["queued", "delivered", "canceled"].includes(message.lifecycle.state));
  assert.equal(message.body, body);
}
function strict(value, coverage) {
  for (const path of coverage.views) for (const view of at(value, path)) assert.equal(Object.hasOwn(view, "deliveryConfirmations"), false, "deliveryConfirmations");
  for (const path of coverage.messages) for (const message of at(value, path)) strictMessage(message);
  for (const path of coverage.audits) for (const row of at(value, path).flat()) {
    assert.ok(!hidden.includes(row.kind));
    assert.notEqual(row.kind, "mail.replaced");
    if (row.kind === "mail.enqueued") strictMessage(row.payload.message);
  }
}
let routes = 0;
for (const [name, coverage] of Object.entries(registry)) {
  if (name === "WatchFrame") continue;
  const original = fixtures[name], before = JSON.stringify(original);
  for (const verb of coverage.verbs) {
    const projected = project(verb, original, caps);
    strict(projected, coverage);
    assert.equal(project(verb, original, [capability]), original);
    const wrapped = { receipt: { verb, result: original }, status: "done" };
    assert.deepEqual(project("rpc.effect.resolve", wrapped, caps).receipt.result, projected);
    assert.equal(project("rpc.effect.resolve", wrapped, [capability]), wrapped);
    routes++;
  }
  assert.equal(JSON.stringify(original), before);
}
const legacyRows = project("audit.tail", { rows }, caps).rows;
assert.deepEqual(legacyRows.map(row => row.seq), rows.filter(row => !hidden.includes(row.kind)).map(row => row.seq));
const originalHistory = history.messages.find(message => message.messageId === first.id);
assert.equal(originalHistory.lifecycle.state, "replaced");
const projectedHistory = project("mail.history", history, caps);
assert.deepEqual(projectedHistory.messages.find(message => message.messageId === first.id).lifecycle, { state: "canceled", reason: "requested", canceledAt: originalHistory.lifecycle.replacedAt });
assert.equal(projectedHistory.snapshotSeq, history.snapshotSeq);
assert.equal(projectedHistory.nextBeforeSeq, history.nextBeforeSeq);
assert.deepEqual(projectedHistory.messages.map(message => [message.seq, message.messageId]), history.messages.map(message => [message.seq, message.messageId]));
const legacyMailboxIds = replayAudit(legacyRows).mailbox.map(message => message.id).sort((a, b) => a - b);
assert.deepEqual(legacyMailboxIds, [later.id, replacement.id]);
assert.deepEqual(project("mail.pending", store.pendingMail(beeId), caps).messages.map(message => message.id), [replacement.id, later.id]);
const replacementEnqueue = rows.find(row => row.kind === "mail.enqueued" && row.payload.message.id === replacement.id);
assert.equal(projectedHistory.messages.find(message => message.messageId === replacement.id).seq, replacementEnqueue.seq);
assert.deepEqual(replayAudit(rows), store.dumpState());
const frame = { type: "delta", baseSeq: 0, seq: store.lastAuditSeq(), events: rows };
assert.deepEqual(delta(frame, caps), { type: "gap", seq: frame.seq });
assert.equal(delta(frame, [capability]), frame);
const retainedFrame = { ...frame, events: rows.filter(row => !hidden.includes(row.kind)) };
const projectedFrame = delta(retainedFrame, caps);
assert.equal(projectedFrame.baseSeq, 0);
assert.equal(projectedFrame.seq, frame.seq);
strict(projectedFrame, registry.WatchFrame);
assert.deepEqual(projectedFrame.events.map(row => row.seq), retainedFrame.events.map(row => row.seq));
const hiddenFrame = { ...frame, events: rows.filter(row => hidden.includes(row.kind)) };
assert.deepEqual(delta(hiddenFrame, caps), { type: "gap", seq: frame.seq });
assert.equal(project("send", { body }, [] ).body, body);
for (const reason of ["host_auth_failed", "message_too_large"]) {
  const payload = Object.freeze({ messageId: replacement.id, urgency: "idle", reason: "requested", canceledAt: 2000, cancellationOwner: "bee.delete", deliveryConfirmation: Object.freeze({ code: "delivery_confirmation_pending", messageId: replacement.id, generation: 1, since: 1000, state: "held", reason, delivered: false }), rpcCaller: Object.freeze({ uid: 1000 }) });
  const row = Object.freeze({ seq: frame.seq + 1, ts: 2000, beeId, kind: "mail.canceled", payload });
  const expected = { ...row, payload: { messageId: replacement.id, urgency: "idle", reason: "requested", canceledAt: 2000, rpcCaller: payload.rpcCaller } };
  assert.deepEqual(project("audit.tail", { rows: [row] }, caps), { rows: [expected] });
  assert.deepEqual(project("rpc.effect.resolve", { receipt: { verb: "audit.tail", result: { rows: [row] } } }, caps).receipt.result, { rows: [expected] });
  const cancellationFrame = { type: "delta", baseSeq: frame.seq, seq: row.seq, events: [row] };
  assert.deepEqual(delta(cancellationFrame, caps), { ...cancellationFrame, events: [expected] });
  assert.equal(project("audit.tail", { rows: [row] }, [capability]).rows[0], row);
  assert.equal(delta(cancellationFrame, [capability]), cancellationFrame);
  assert.equal(row.payload, payload);
}
store.close();
console.log(JSON.stringify({ result: "PASS", routes, receiptRoutes: routes, replacementId: replacement.id, inheritedQueueOrder: replacement.queueOrder, pendingOrder: [replacement.id, later.id], originalSeqsPreserved: true, hiddenWatch: "gap_requires_snapshot", legacyMailboxIds, newReplay: "exact", fixture: dir, limitation: "No legacy consumer implementation in repo; conservative gap used. Legacy clients cannot express inherited queue order or replacement links." }));
