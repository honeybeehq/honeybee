import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { backupStoreOffline, restoreStoreOffline, StoreBackupError, type StoreBackupReceipt } from "../src/storeBackup.ts";
import { openCoreStore, SCHEMA_VERSION } from "../src/index.ts";

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
