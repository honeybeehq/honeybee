import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { backupStore, backupStoreOffline, restoreStoreOffline, StoreBackupError, type StoreBackupReceipt } from "../src/storeBackup.ts";
import { INBOX_AGENT, openCoreStore, SCHEMA_VERSION } from "../src/index.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "hb-backup-"));
  const path = join(dir, "core.sqlite3");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO meta VALUES('schema_version','1'); CREATE TABLE proof(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO proof VALUES(1,'before')");
  db.close();
  return { dir, path };
}

test("owner backs up WAL rows, refuses other writer and restore preserves current store", () => {
  const { path } = fixture();
  const receipt = backupStoreOffline(path, "old-build");
  assert.equal(statSync(receipt.receiptPath).mode & 0o777, 0o600);
  assert.equal(statSync(receipt.backupPath).mode & 0o777, 0o600);
  const db = new DatabaseSync(path);
  db.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; UPDATE proof SET value='after'; COMMIT");
  assert.throws(() => backupStoreOffline(path, "other"), /locked/);
  assert.throws(() => restoreStoreOffline(path, receipt.receiptPath), /locked/);
  db.close();
  const restored = restoreStoreOffline(path, receipt.receiptPath);
  assert.match(restored.lossWindow, /after the backup are discarded/);
  const old = new DatabaseSync(path);
  assert.equal(old.prepare("SELECT value FROM proof").get()?.value, "before");
  assert.equal(old.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
  old.close();
  const preserved = new DatabaseSync(restored.preservedPath);
  assert.equal(preserved.prepare("SELECT value FROM proof").get()?.value, "after");
  preserved.close();
});

test("backup and restore hash the snapshot in pieces, so a file too large to read whole still works", (t) => {
  const { path } = fixture();
  const seed = new DatabaseSync(path);
  seed.exec("CREATE TABLE bulk(id INTEGER PRIMARY KEY, body BLOB)");
  const insert = seed.prepare("INSERT INTO bulk(body) VALUES(?)");
  for (let i = 0; i < 5; i++) insert.run(Buffer.alloc(700_000, i + 1));
  seed.close();
  const readWhole = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (target: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (/\.(sqlite3|partial)$|\.restore-/.test(String(target))) throw Object.assign(new RangeError("File size (4723388416) is greater than 2 GiB"), { code: "ERR_FS_FILE_TOO_LARGE" });
    return (readWhole as (...args: unknown[]) => unknown)(target, ...rest);
  });
  syncBuiltinESMExports();
  let receipt: StoreBackupReceipt;
  try {
    receipt = backupStoreOffline(path, "large");
    const db = new DatabaseSync(path);
    db.exec("UPDATE proof SET value='after'");
    db.close();
    restoreStoreOffline(path, receipt.receiptPath);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.ok(statSync(receipt.backupPath).size > 3 * 1024 * 1024, "the snapshot spans several hash chunks");
  assert.equal(receipt.sha256, createHash("sha256").update(readFileSync(receipt.backupPath)).digest("hex"));
  const restored = new DatabaseSync(path, { readOnly: true });
  assert.equal(restored.prepare("SELECT value FROM proof").get()?.value, "before");
  assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM bulk").get()?.n, 5);
  restored.close();
});

test("checksum or schema receipt mismatch refuses restore without replacing store", () => {
  const { path } = fixture();
  const receipt = backupStoreOffline(path, "fixture");
  writeFileSync(receipt.receiptPath, JSON.stringify({ ...receipt, schemaVersion: 99 }));
  assert.throws(() => restoreStoreOffline(path, receipt.receiptPath), /schema differs/);
  writeFileSync(receipt.backupPath, "corrupted");
  assert.throws(() => restoreStoreOffline(path, receipt.receiptPath), /checksum mismatch/);
});

test("migration fails closed before DDL when backup cannot finalize", () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-backup-fail-"));
  const path = join(dir, "core.sqlite3");
  const store = openCoreStore(path);
  store.close();
  const db = new DatabaseSync(path);
  db.exec("UPDATE meta SET value='44' WHERE key='schema_version'; DROP TABLE bee_human_outputs");
  db.close();
  writeFileSync(`${path}.backups`, "blocked");
  assert.throws(() => openCoreStore(path), StoreBackupError);
  const check = new DatabaseSync(path);
  assert.equal(check.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value, "44");
  assert.equal(check.prepare("SELECT 1 FROM sqlite_master WHERE name='bee_human_outputs'").get(), undefined);
  check.close();
});

test("migration receipt captures old DDL before schema creation; retention keeps each schema", () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-backup-migrate-"));
  const path = join(dir, "core.sqlite3");
  openCoreStore(path).close();
  const db = new DatabaseSync(path);
  db.exec("UPDATE meta SET value='44' WHERE key='schema_version'; DROP TABLE bee_human_outputs");
  db.close();
  openCoreStore(path).close();
  const receipts = readdirSync(`${path}.backups`).filter(name => name.endsWith(".json"));
  const before = JSON.parse(readFileSync(join(`${path}.backups`, receipts[0]!), "utf8")) as StoreBackupReceipt;
  assert.equal(before.schemaVersion, 44);
  const backup = new DatabaseSync(before.backupPath);
  assert.equal(backup.prepare("SELECT 1 FROM sqlite_master WHERE name='bee_human_outputs'").get(), undefined);
  backup.close();
  for (let i = 0; i < 12; i++) backupStoreOffline(path, "same-schema");
  const retained = readdirSync(`${path}.backups`).filter(name => name.endsWith(".json"));
  assert.equal(retained.length, 11);
  assert.ok(retained.includes(receipts[0]!));
  restoreStoreOffline(path, before.receiptPath);
  const restored = new DatabaseSync(path);
  assert.equal(restored.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value, "44");
  restored.close();
});

test("owning connection includes committed WAL rows in the backup without releasing its lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-backup-owner-"));
  const path = join(dir, "core.sqlite3");
  const store = openCoreStore(path);
  const { bee } = store.createBee({ name: "wal-proof", agent: "claude", substrate: "tmux", cwd: dir });
  const receipt = store.backup("owner-build");
  const snapshot = new DatabaseSync(receipt.backupPath, { readOnly: true });
  assert.equal(snapshot.prepare("SELECT name FROM bees WHERE id=?").get(bee.id)?.name, "wal-proof");
  snapshot.close();
  assert.throws(() => restoreStoreOffline(path, receipt.receiptPath), /locked/);
  store.close();
});

test("restore installs by atomic replacement while current path still names the preserved inode", (t) => {
  const { path } = fixture();
  const receipt = backupStoreOffline(path, "fixture");
  const rename = fs.renameSync;
  let observed = false;
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === path) {
      assert.ok(fs.existsSync(path), "current path must never disappear during restore");
      assert.equal(fs.statSync(path).nlink, 2, "current inode must already be preserved");
      const probe = `const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.argv[1]); try { db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'); throw new Error('writer acquired lock'); } catch(e) { if (!/locked/.test(e.message)) throw e; process.stdout.write('locked'); } finally { db.close(); }`;
      assert.equal(execFileSync(process.execPath, ["-e", probe, path], { encoding: "utf8" }), "locked");
      assert.equal(execFileSync(process.execPath, ["-e", probe, String(from)], { encoding: "utf8" }), "locked");
      rename(from, to);
      assert.equal(execFileSync(process.execPath, ["-e", probe, path], { encoding: "utf8" }), "locked");
      observed = true;
      return;
    }
    return rename(from, to);
  });
  syncBuiltinESMExports();
  try { restoreStoreOffline(path, receipt.receiptPath); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(observed, true);
});

test("foreign receipts are reported and skipped without blocking a later backup", (t) => {
  const { path } = fixture();
  const first = backupStoreOffline(path, "fixture");
  writeFileSync(join(`${path}.backups`, "foreign.json"), "broken");
  writeFileSync(join(`${path}.backups`, "moved.json"), JSON.stringify({ ...first, receiptPath: "/old/moved.json" }));
  const warnings: string[] = [];
  t.mock.method(process, "emitWarning", (warning: string) => { warnings.push(String(warning)); });
  const next = backupStoreOffline(path, "fixture");
  assert.ok(fs.existsSync(next.receiptPath));
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every(warning => warning.includes("retention skipped")));
});

test("VACUUM failure removes its partial snapshot and returns a typed backup failure", (t) => {
  const { path } = fixture();
  const db = new DatabaseSync(path);
  const execute = db.exec.bind(db);
  t.mock.method(db, "exec", (sql: string) => {
    execute(sql);
    if (sql.startsWith("VACUUM INTO")) throw new Error("fixture vacuum failure");
  });
  try { assert.throws(() => backupStore(db, path, "fixture"), StoreBackupError); }
  finally { db.close(); }
  assert.deepEqual(readdirSync(`${path}.backups`), []);
});

test("a failed install keeps the current database and removes the restore temporary file", (t) => {
  const { path, dir } = fixture();
  const receipt = backupStoreOffline(path, "fixture");
  t.mock.method(fs, "renameSync", () => { throw new Error("fixture install refused"); });
  syncBuiltinESMExports();
  try { assert.throws(() => restoreStoreOffline(path, receipt.receiptPath), /fixture install refused/); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.ok(fs.existsSync(path));
  assert.equal(readdirSync(dir).some(name => name.includes(".restore-")), false);
  const db = new DatabaseSync(path);
  assert.equal(db.prepare("SELECT value FROM proof").get()?.value, "before");
  assert.equal(db.prepare("PRAGMA journal_mode").get()?.journal_mode, "delete");
  db.close();
});

function paddedStore(megabytes: number) {
  const dir = mkdtempSync(join(tmpdir(), "hb-backup-online-"));
  const path = join(dir, "core.sqlite3");
  const store = openCoreStore(path, { ephemeral: true });
  store.createBee({ id: "inbox", name: "inbox", agent: INBOX_AGENT, substrate: "hsr", cwd: "" });
  const body = "x".repeat(60_000);
  while (statSync(path).size < megabytes * 1024 * 1024) store.transact(() => { for (let i = 0; i < 50; i++) store.send("inbox", body, { sender: "operator" }); });
  return { dir, path, store };
}

function mailCounts(db: DatabaseSync): number[] {
  return [
    Number(db.prepare("SELECT COUNT(*) AS n FROM mailbox").get()?.n),
    Number(db.prepare("SELECT COUNT(*) AS n FROM mail_history_enqueues").get()?.n),
    Number(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE kind = 'mail.enqueued'").get()?.n),
  ];
}

test("online backup copies a consistent store while it keeps writing, and leaves a plain rollback-mode file", { timeout: 60_000 }, async () => {
  const { path, store } = paddedStore(40);
  const before = store.undeliveredMessages("inbox").length;
  let writing = true;
  let written = 0;
  const writer = (async () => {
    while (writing) {
      store.send("inbox", `during ${written++}`, { sender: "operator" });
      if (written % 7 === 0) assert.throws(() => store.transact(() => { store.getBee("inbox"); throw new Error("nothing written"); }), /nothing written/);
      await new Promise((resume) => setImmediate(resume));
    }
  })();
  const blocking: string[] = [];
  const running = store.backupOnline("online-build", { blocking: (reason) => blocking.push(reason) });
  await assert.rejects(store.backupOnline("second"), /already running/);
  const receipt = await running;
  writing = false;
  await writer;
  assert.deepEqual(blocking, [], "rollbacks that wrote nothing do not restart the copy");
  assert.ok(written > 0, "the store accepted writes during the copy");
  assert.equal(receipt.integrityCheck, "ok");
  assert.equal(receipt.sourceBuild, "online-build");
  assert.equal(receipt.sha256, createHash("sha256").update(readFileSync(receipt.backupPath)).digest("hex"));
  assert.equal(statSync(receipt.backupPath).mode & 0o777, 0o600);
  const snapshot = new DatabaseSync(receipt.backupPath, { readOnly: true });
  try {
    assert.equal(snapshot.prepare("PRAGMA journal_mode").get()?.journal_mode, "delete");
    const [mailbox, history, enqueued] = mailCounts(snapshot);
    assert.equal(mailbox, history, "each send's rows are all in the copy or none are");
    assert.equal(mailbox, enqueued);
    assert.ok(mailbox! >= before && mailbox! <= before + written, `${before} <= ${mailbox} <= ${before + written}`);
  } finally { snapshot.close(); }
  assert.deepEqual(readdirSync(`${path}.backups`).filter((name) => !/\.(sqlite3|json)$/.test(name)), [], "no partial, journal or WAL files are left beside the copy");
  const again = await store.backupOnline("after");
  assert.notEqual(again.backupPath, receipt.backupPath);
  store.close();
  restoreStoreOffline(path, receipt.receiptPath);
  const restored = openCoreStore(path);
  assert.ok(restored.undeliveredMessages("inbox").length >= before);
  restored.close();
});

test("online backup falls back to the blocking snapshot when write transactions keep rolling back", { timeout: 60_000 }, async () => {
  const { path, store } = paddedStore(40);
  let failing = true;
  let rolledBack = 0;
  const failer = (async () => {
    while (failing) {
      assert.throws(() => store.transact(() => { store.send("inbox", "rolled back", { sender: "operator" }); rolledBack += 1; throw new Error("after writing"); }), /after writing/);
      await new Promise((resume) => setImmediate(resume));
    }
  })();
  const blocking: string[] = [];
  const receipt = await store.backupOnline("contended", { blocking: (reason) => blocking.push(reason) });
  failing = false;
  await failer;
  assert.equal(blocking.length, 1);
  assert.match(blocking[0]!, /rolled back/);
  assert.ok(rolledBack > 3);
  assert.equal(receipt.sha256, createHash("sha256").update(readFileSync(receipt.backupPath)).digest("hex"));
  const snapshot = new DatabaseSync(receipt.backupPath, { readOnly: true });
  try {
    assert.equal(snapshot.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    assert.equal(Number(snapshot.prepare("SELECT COUNT(*) AS n FROM mailbox WHERE body = 'rolled back'").get()?.n), 0);
    const [mailbox, history, enqueued] = mailCounts(snapshot);
    assert.deepEqual([history, enqueued], [mailbox, mailbox]);
  } finally { snapshot.close(); }
  assert.deepEqual(readdirSync(`${path}.backups`).filter((name) => !/\.(sqlite3|json)$/.test(name)), []);
  store.close();
});

test("a failed online verification leaves no snapshot behind and the store stays usable", { timeout: 60_000 }, async () => {
  const { path, store } = paddedStore(2);
  await assert.rejects(store.backupOnline("unverified", { verify: async () => { throw new Error("verifier lost"); } }), (error: unknown) => error instanceof StoreBackupError && /verifier lost/.test(error.message));
  assert.deepEqual(readdirSync(`${path}.backups`), []);
  const receipt = await store.backupOnline("verified");
  assert.equal(receipt.integrityCheck, "ok");
  store.close();
});
