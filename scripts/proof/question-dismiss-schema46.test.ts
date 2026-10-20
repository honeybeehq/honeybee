import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openCoreStore, SCHEMA_VERSION, replayAudit } from "../../v2/core/src/index.ts";

const fixtureRoot = new URL("./fixtures/question-dismiss/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("baseline.json", fixtureRoot), "utf8")) as {sourceRevision: string; schemaVersion: number; schemaSha256: string; dataSha256: string};
const schema = readFileSync(new URL("schema45.sql", fixtureRoot), "utf8"), dataText = readFileSync(new URL("schema45-data.json", fixtureRoot), "utf8");
const data = JSON.parse(dataText) as {beeId: string; questionId: string; pendingId: string; rows: Record<string, Record<string, string | number | null>[]>};
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

test("schema46: pinned schema45 fixture migration, dependent objects and failed-upgrade rollback preserve one terminal receipt", () => {
  assert.equal(manifest.sourceRevision, "e26ad0241105b3d374bfe73649af60a90736aa9b");
  assert.equal(manifest.schemaVersion, 45); assert.equal(SCHEMA_VERSION, 46);
  assert.equal(hash(schema), manifest.schemaSha256); assert.equal(hash(dataText), manifest.dataSha256);
  const root = mkdtempSync(join(tmpdir(), "dismiss-migration-")), path = join(root, "core.sqlite3");
  try {
    const fixture = new DatabaseSync(path);
    fixture.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE"); fixture.exec(schema);
    for (const [table, rows] of Object.entries(data.rows)) for (const row of rows) {
      const fields = Object.keys(row).map(name => '"' + name.replaceAll('"', '""') + '"');
      fixture.prepare(`INSERT INTO "${table.replaceAll('"', '""')}"(${fields.join(",")}) VALUES(${fields.map(() => "?").join(",")})`).run(...Object.values(row));
    }
    assert.deepEqual(fixture.prepare("PRAGMA foreign_key_check").all(), []);
    fixture.exec("COMMIT; PRAGMA foreign_keys = ON");
    assert.equal(fixture.prepare("SELECT value FROM meta WHERE key='schema_version'").get()!.value, "45");
    assert.equal(String(fixture.prepare("SELECT sql FROM sqlite_master WHERE name='questions'").get()!.sql).includes("'dismissed'"), false);
    fixture.exec("CREATE TABLE dismiss_fixture_links(question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE); CREATE TABLE dismiss_fixture_log(question_id TEXT,status TEXT); CREATE INDEX dismiss_fixture_index ON questions(text); CREATE VIEW dismiss_fixture_view AS SELECT id,status FROM questions; CREATE VIEW dismiss_fixture_nested AS SELECT * FROM dismiss_fixture_view; CREATE TRIGGER dismiss_fixture_update AFTER UPDATE OF status ON questions BEGIN INSERT INTO dismiss_fixture_log VALUES(NEW.id,NEW.status); END; CREATE TRIGGER dismiss_fixture_link AFTER INSERT ON dismiss_fixture_links BEGIN INSERT INTO dismiss_fixture_log SELECT id,status FROM questions WHERE id=NEW.question_id; END");
    fixture.prepare("INSERT INTO dismiss_fixture_links VALUES(?)").run(data.questionId);
    const objectsBefore = fixture.prepare("SELECT type,name,sql FROM sqlite_master WHERE name LIKE 'dismiss_fixture_%' ORDER BY name").all();
    const tableBefore = fixture.prepare("SELECT sql FROM sqlite_master WHERE name='questions'").get()!.sql;
    fixture.exec("PRAGMA foreign_keys = OFF; INSERT INTO dismiss_fixture_links VALUES('missing-migration-fixture')"); fixture.close();
    assert.throws(() => openCoreStore(path, {ephemeral: true}), /Question schema migration violates foreign keys/);
    const failed = new DatabaseSync(path);
    assert.equal(failed.prepare("SELECT sql FROM sqlite_master WHERE name='questions'").get()!.sql, tableBefore);
    assert.equal(failed.prepare("SELECT value FROM meta WHERE key='schema_version'").get()!.value, "45");
    assert.deepEqual(failed.prepare("SELECT type,name,sql FROM sqlite_master WHERE name LIKE 'dismiss_fixture_%' ORDER BY name").all(), objectsBefore);
    assert.equal(failed.prepare("PRAGMA foreign_key_check").all().length, 1);
    assert.deepEqual(failed.prepare("SELECT name FROM sqlite_master WHERE sql LIKE '%questions_v44%' OR sql LIKE '%questions_new%'").all(), []);
    failed.exec("PRAGMA foreign_keys = OFF; DELETE FROM dismiss_fixture_links WHERE question_id='missing-migration-fixture'"); failed.close();
    let current = openCoreStore(path, {ephemeral: true});
    const receipt = current.dismissQuestionWithKey(data.questionId, "migration-key");
    current.answerQuestion(data.pendingId, "Unrelated writing works."); const created = current.askQuestion(data.beeId, {text: "Created after migration."});
    assert.deepEqual(replayAudit(current.auditRows()), current.dumpState()); current.close();
    const db = new DatabaseSync(path);
    const stamp = String(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()!.value);
    const integrity = String(db.prepare("PRAGMA integrity_check").get()!.integrity_check), foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
    const receipts = Number(db.prepare("SELECT count(*) AS n FROM question_dismiss_receipts").get()!.n);
    const notice = db.prepare("SELECT body,sender,sender_kind FROM mailbox WHERE id=?").get(receipt.question.dismissalMessageId!)!;
    const danglingObjects = db.prepare("SELECT name FROM sqlite_master WHERE sql LIKE '%questions_v44%' OR sql LIKE '%questions_new%'").all();
    const objectsAfter = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name LIKE 'dismiss_fixture_%' ORDER BY name").all();
    const dependentRows = db.prepare("SELECT * FROM dismiss_fixture_links").all(), dependentView = db.prepare("SELECT * FROM dismiss_fixture_nested WHERE id=?").get(data.questionId);
    const dependentForeignKeys = db.prepare("PRAGMA foreign_key_list(dismiss_fixture_links)").all();
    assert.deepEqual(objectsAfter, objectsBefore); assert.deepEqual(danglingObjects, []); assert.equal(dependentRows.length, 1); assert.equal(dependentRows[0]!.question_id, data.questionId); assert.equal(dependentView!.status, "dismissed"); assert.equal(dependentForeignKeys[0]!.table, "questions");
    db.prepare("INSERT INTO dismiss_fixture_links VALUES(?)").run(data.pendingId);
    assert.equal(db.prepare("SELECT count(*) AS n FROM dismiss_fixture_log WHERE status='dismissed'").get()!.n, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM dismiss_fixture_log WHERE status='answered'").get()!.n, 2); db.close();
    assert.equal(stamp, "46"); assert.equal(integrity, "ok"); assert.deepEqual(foreignKeys, []); assert.equal(receipts, 1);
    assert.equal(notice.body, "Your question was dismissed without an answer."); assert.equal(notice.sender, "rpc"); assert.equal(notice.sender_kind, "automation");
    current = openCoreStore(path, {ephemeral: true});
    try {
      assert.deepEqual(current.dismissQuestionWithKey(data.questionId, "migration-key"), {...receipt, deduped: true});
      assert.deepEqual(current.dismissQuestionWithKey(data.questionId, "new-key"), receipt);
      assert.equal(current.getQuestion(data.pendingId)!.status, "answered"); assert.equal(current.getQuestion(created.id)!.dismissedAt, null);
      assert.deepEqual(replayAudit(current.auditRows()), current.dumpState());
      assert.equal(current.listMessages(data.beeId).filter(message => message.id === receipt.question.dismissalMessageId).length, 1);
      console.log(JSON.stringify({host: hostname(), baseline: manifest.sourceRevision, baselineSchemaVersion: 45, schemaVersion: stamp, baselineSchemaSha256: manifest.schemaSha256, portableFixture: true, statusColumn: "CHECK rebuilt", integrity, foreignKeys, dependentForeignKeys, dependentRows, dependentView, dependentObjects: objectsAfter.map(object => ({type: object.type, name: object.name})), dependentObjectSqlUnchanged: true, migrationForeignKeyRollback: true, danglingObjects, dependentTriggersExecuted: true, receipts, notice, question: receipt.question, replayEqual: true}));
    } finally {current.close();}
  } finally {rmSync(root, {recursive: true, force: true});}
});
