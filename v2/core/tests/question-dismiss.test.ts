import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { QuestionDismissedError, QuestionAlreadyAnsweredError, QuestionWithdrawnError, IdempotencyConflictError, QuestionNotFoundError, replayAudit } from "../src/index.ts";
import { harness, makeBee } from "./helpers.ts";

const notice = "Your question was dismissed without an answer.";

test("dismiss commits one terminal row, automation notice and event; receipts/restart preserve the first effect", () => {
  const h = harness(); let store = h.open();
  try {
    const { bee } = makeBee(store);
    const question = store.askQuestion(bee.id, { text: "Decide?", options: ["yes", "no"] });
    const dismissed = store.dismissQuestionWithKey(question.id, "dismiss-key").question;
    assert.equal(dismissed.status, "dismissed"); assert.equal(dismissed.dismissedBy, "rpc");
    assert.ok(dismissed.dismissedAt! > question.askedAt);
    for (const key of ["answer", "answeredAt", "answeredBy", "deliveryMessageId", "withdrawalReason", "withdrawnAt"] as const) assert.equal(dismissed[key], null);
    const message = store.getMessage(dismissed.dismissalMessageId!)!;
    assert.equal(message.body, notice); assert.equal(message.sender, "rpc"); assert.equal(message.senderKind, "automation");
    assert.equal(store.answeredQuestionId(message.id), null); assert.equal(store.dismissedQuestionId(message.id), question.id);
    const event = store.auditRows().find(row => row.kind === "question.dismissed")!;
    assert.deepEqual(event.payload, { questionId: question.id, dismissedAt: dismissed.dismissedAt, dismissedBy: "rpc", dismissalMessageId: message.id });
    const seq = store.auditRows().at(-1)!.seq; h.now();
    assert.deepEqual(store.dismissQuestionWithKey(question.id, "dismiss-key"), { question: dismissed, deduped: true });
    assert.deepEqual(store.dismissQuestionWithKey(question.id, "another-key"), { question: dismissed });
    assert.equal(store.auditRows().at(-1)!.seq, seq); assert.equal(store.listMessages(bee.id).length, 1);
    assert.deepEqual(store.listQuestions({ open: true }), []);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.close(); store = h.open();
    assert.deepEqual(store.dismissQuestionWithKey(question.id, "dismiss-key"), { question: dismissed, deduped: true });
    assert.deepEqual(store.getQuestion(question.id), dismissed);
    assert.equal(store.auditRows().filter(row => row.kind === "question.dismissed").length, 1);
  } finally { store.close(); h.cleanup(); }
});

test("dismiss receipts cannot collide with generic RPC keys and refuse different-question reuse", () => {
  const h = harness(); const store = h.open();
  try {
    const { bee } = makeBee(store);
    const first = store.askQuestion(bee.id, { text: "First?" }), second = store.askQuestion(bee.id, { text: "Second?" });
    store.recordRpcResult("same-key", "question.answer", null, { poison: true });
    const result = store.dismissQuestionWithKey(first.id, "same-key");
    assert.equal(result.question.status, "dismissed");
    assert.deepEqual(store.lookupRpcResult("same-key")!.result, { poison: true });
    assert.throws(() => store.dismissQuestionWithKey(second.id, "same-key"), IdempotencyConflictError);
    assert.equal(store.getQuestion(second.id)!.status, "open");
    assert.throws(() => store.dismissQuestionWithKey("missing", "fresh-key"), QuestionNotFoundError);
    assert.equal(store.dismissQuestionWithKey(second.id, "fresh-key").question.status, "dismissed");
  } finally { store.close(); h.cleanup(); }
});

for (const first of ["answer", "withdraw", "dismiss"] as const) test(`terminal race: ${first} commits first; exactly one terminal result`, () => {
  const h = harness(); const store = h.open();
  try {
    const { bee } = makeBee(store); const q = store.askQuestion(bee.id, { text: "Race?" });
    const operations = { answer: () => store.answerQuestion(q.id, "yes"), withdraw: () => store.withdrawQuestionWithKey(q.id, bee.id, "Superseded.", "withdraw"), dismiss: () => store.dismissQuestionWithKey(q.id, "dismiss") };
    operations[first]();
    for (const loser of Object.keys(operations) as (keyof typeof operations)[]) {
      if (loser === first) continue;
      assert.throws(operations[loser], first === "answer" ? QuestionAlreadyAnsweredError : first === "withdraw" ? QuestionWithdrawnError : QuestionDismissedError);
    }
    const state = store.getQuestion(q.id)!;
    assert.equal(state.status, first === "answer" ? "answered" : first === "withdraw" ? "withdrawn" : "dismissed");
    const messages = store.listMessages(bee.id);
    assert.equal(messages.length, first === "withdraw" ? 0 : 1);
    assert.equal(messages.filter(message => message.body === notice).length, first === "dismiss" ? 1 : 0);
    assert.equal(messages.filter(message => message.id === state.deliveryMessageId).length, first === "answer" ? 1 : 0);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  } finally { store.close(); h.cleanup(); }
});

for (const target of ["notice", "event", "receipt"] as const) test(`dismiss rolls back its terminal CAS and mail when ${target} insertion fails`, () => {
  const h = harness(); let store = h.open();
  try {
    const { bee } = makeBee(store); const q = store.askQuestion(bee.id, { text: "Rollback?" });
    if (target === "receipt") store.archiveBee(bee.id);
    const before = store.dumpState();
    store.close();
    const db = new DatabaseSync(h.path);
    const table = target === "notice" ? "mailbox" : target === "event" ? "audit" : "question_dismiss_receipts";
    db.exec(`CREATE TRIGGER reject_dismiss BEFORE INSERT ON ${table} ${target === "event" ? "WHEN NEW.kind = 'question.dismissed'" : ""} BEGIN SELECT RAISE(ABORT, 'synthetic dismissal failure'); END`);
    db.close(); store = h.open();
    assert.throws(() => store.dismissQuestionWithKey(q.id, "rollback"), /synthetic dismissal failure/);
    assert.deepEqual(store.dumpState(), before);
    assert.equal(store.listMessages(bee.id).length, 0);
    store.close(); const reset = new DatabaseSync(h.path); reset.exec("DROP TRIGGER reject_dismiss"); reset.close(); store = h.open();
    assert.equal(store.dismissQuestionWithKey(q.id, "rollback").question.status, "dismissed");
  } finally { store.close(); h.cleanup(); }
});

test("schema46 migration without a status CHECK gains dismissal columns additively", () => {
  const h = harness(); let store = h.open();
  try {
    const {bee} = makeBee(store); const q = store.askQuestion(bee.id, {text: "Additive migration?"}); store.close();
    const db = new DatabaseSync(h.path);
    db.exec("ALTER TABLE questions RENAME TO questions_fixture; CREATE TABLE questions AS SELECT id,bee_id,generation,text,options,status,answer,asked_at,answered_at,answered_by,delivery_message_id,withdrawal_reason,withdrawn_at FROM questions_fixture; DROP TABLE questions_fixture");
    const rootPage = db.prepare("SELECT rootpage FROM sqlite_master WHERE name='questions'").get()!.rootpage; db.close();
    store = h.open(); assert.equal(store.dismissQuestionWithKey(q.id, "additive").question.status, "dismissed"); store.close();
    const after = new DatabaseSync(h.path);
    assert.equal(after.prepare("SELECT rootpage FROM sqlite_master WHERE name='questions'").get()!.rootpage, rootPage);
    assert.equal(String(after.prepare("SELECT value FROM meta WHERE key='schema_version'").get()!.value), "46"); after.close();
    store = h.open(); assert.equal(store.getQuestion(q.id)!.status, "dismissed");
  } finally {store.close(); h.cleanup();}
});
