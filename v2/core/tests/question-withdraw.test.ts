import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { openCoreStore, replayAudit, QuestionNotOwnerError, QuestionAlreadyAnsweredError, QuestionWithdrawnError, QuestionNotFoundError, CoreError } from "../src/index.ts";

function fixture() {
  const base = join(homedir(), ".cache", "honeybee-question-withdraw-tests");
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "core-"));
  let clock = 1000;
  const path = join(dir, "core.sqlite3");
  const open = () => openCoreStore(path, { ephemeral: true, now: () => ++clock });
  return { dir, path, open, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("withdrawal is owner-only, quiet across retries, replayable and durable; both first-commit winners", () => {
  const f = fixture();
  let store = f.open();
  try {
    const bee = store.createBee({ name: "asker", agent: "stub", substrate: "hsr", cwd: f.dir }).bee;
    const other = store.createBee({ name: "other", agent: "stub", substrate: "hsr", cwd: f.dir }).bee;
    const q = store.askQuestion(bee.id, { text: "Ship?", options: ["yes", "no"] });
    assert.throws(() => store.withdrawQuestion(q.id, other.id, "changed"), QuestionNotOwnerError);
    assert.throws(() => store.withdrawQuestion("missing", bee.id, "changed"), QuestionNotFoundError);
    for (const reason of ["", " \n ", "x".repeat(501)]) assert.throws(() => store.withdrawQuestion(q.id, bee.id, reason), CoreError);
    const withdrawn = store.withdrawQuestion(q.id, bee.id, "  Superseded.  ");
    assert.equal(withdrawn.status, "withdrawn");
    assert.equal(withdrawn.withdrawalReason, "Superseded.");
    assert.equal(withdrawn.answer, null);
    assert.equal(withdrawn.deliveryMessageId, null);
    assert.deepEqual(store.withdrawQuestion(q.id, bee.id, "different"), withdrawn);
    assert.throws(() => store.withdrawQuestion(q.id, other.id, "changed"), QuestionNotOwnerError);
    assert.throws(() => store.answerQuestion(q.id, "yes"), (e: unknown) => e instanceof QuestionWithdrawnError && e.message === "This question was withdrawn: Superseded.");
    assert.equal(store.auditRows().filter(r => r.kind === "mail.enqueued").length, 0);
    const events = store.auditRows().filter(r => r.kind === "question.withdrawn");
    assert.equal(events.length, 1);
    assert.deepEqual(events[0]!.payload, { questionId: q.id, withdrawalReason: "Superseded.", withdrawnAt: withdrawn.withdrawnAt });
    assert.deepEqual(store.listQuestions({ open: true }), []);
    assert.deepEqual(store.listQuestions({ open: false }), [withdrawn]);
    const q2 = store.askQuestion(bee.id, { text: "Still ship?" });
    const send = store.send;
    store.send = () => { throw new Error("injected mail write failure"); };
    assert.throws(() => store.answerQuestion(q2.id, "yes"), /injected mail write failure/);
    assert.equal(store.getQuestion(q2.id)?.status, "open");
    assert.equal(store.auditRows().filter(r => r.kind === "question.answered").length, 0);
    store.send = send;
    const answer = store.answerQuestion(q2.id, "yes");
    assert.equal(answer.question.status, "answered");
    assert.throws(() => store.withdrawQuestion(q2.id, bee.id, "late"), QuestionAlreadyAnsweredError);
    assert.equal(store.auditRows().filter(r => r.kind === "mail.enqueued").length, 1);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.close(); store = f.open();
    assert.deepEqual(store.getQuestion(q.id), withdrawn);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  } finally { store.close(); f.cleanup(); }
});

test("v44 question migration preserves open/answered rows, indexes and legacy audit defaults", () => {
  const f = fixture();
  let store = f.open();
  const bee = store.createBee({ name: "legacy", agent: "stub", substrate: "hsr", cwd: f.dir }).bee;
  const open = store.askQuestion(bee.id, { text: "Open legacy?" });
  const answered = store.askQuestion(bee.id, { text: "Answered legacy?" });
  store.answerQuestion(answered.id, "yes");
  store.close();
  const db = new DatabaseSync(f.path);
  db.exec(`ALTER TABLE questions RENAME TO questions_new;
    CREATE TABLE questions(id TEXT PRIMARY KEY, bee_id TEXT NOT NULL REFERENCES bees(id) ON DELETE CASCADE, generation INTEGER, text TEXT NOT NULL, options TEXT, status TEXT NOT NULL CHECK(status IN ('open','answered')), answer TEXT, asked_at INTEGER NOT NULL, answered_at INTEGER, answered_by TEXT, delivery_message_id INTEGER, CHECK((status='answered')=(answered_at IS NOT NULL))) STRICT;
    INSERT INTO questions SELECT id,bee_id,generation,text,options,status,answer,asked_at,answered_at,answered_by,delivery_message_id FROM questions_new;
    DROP TABLE questions_new;
    UPDATE meta SET value='44' WHERE key='schema_version';
    UPDATE audit SET payload=json_remove(payload,'$.question.withdrawalReason','$.question.withdrawnAt') WHERE kind='question.asked';`);
  db.close();
  store = f.open();
  try {
    assert.equal(store.getQuestion(open.id)?.withdrawalReason, null);
    assert.equal(store.getQuestion(answered.id)?.status, "answered");
    store.withdrawQuestion(open.id, bee.id, "Migrated.");
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.close();
    const check = new DatabaseSync(f.path);
    assert.equal(check.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND name IN ('questions_open','questions_delivery_message')").get()!.n, 2);
    check.close();
    store = f.open();
  } finally { store.close(); f.cleanup(); }
});


test("withdrawal receipts cannot be poisoned or disclosed by generic RPC keys", () => {
  const f = fixture();
  let store = f.open();
  try {
    const bee = store.createBee({ name: "asker", agent: "inbox", substrate: "hsr", cwd: f.dir }).bee;
    const other = store.createBee({ name: "other", agent: "inbox", substrate: "hsr", cwd: f.dir }).bee;
    const q = store.askQuestion(bee.id, { text: "Poison?" });
    const collision = `question.withdraw:${JSON.stringify([bee.id, "key"])}`;
    store.recordRpcResult(collision, "bee.rename", null, { sentinel: "generic receipt" });
    const first = store.withdrawQuestionWithKey(q.id, bee.id, "First.", "key");
    assert.equal(first.question.status, "withdrawn");
    assert.deepEqual(store.lookupRpcResult(collision)?.result, { sentinel: "generic receipt" });
    const second = store.withdrawQuestionWithKey(q.id, bee.id, "Another.", "unpoisoned");
    assert.deepEqual(second.question, first.question);
    assert.equal(store.lookupRpcResult(`question.withdraw:${JSON.stringify([bee.id, "unpoisoned"])}`), null);
    assert.throws(() => store.withdrawQuestionWithKey(q.id, other.id, "Stolen.", "key"), QuestionNotOwnerError);
    assert.throws(() => store.withdrawQuestionWithKey(q.id, bee.id, " ", "key"), CoreError);
    const otherQuestion = store.askQuestion(other.id, { text: "Same key, other owner?" });
    assert.equal(store.withdrawQuestionWithKey(otherQuestion.id, other.id, "Other.", "key").question.status, "withdrawn");
    store.close(); store = f.open();
    assert.deepEqual(store.withdrawQuestionWithKey(q.id, bee.id, "Changed.", "key"), { ...first, deduped: true });
    assert.equal(store.auditRows().filter(row => row.kind === "question.withdrawn" && row.beeId === bee.id).length, 1);
  } finally { store.close(); f.cleanup(); }
});
