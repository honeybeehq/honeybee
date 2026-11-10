import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_VERSION, SchemaVersionError, SecondWriterError, acquireStoreWriterLock, openCoreStore, storeWriterLockHeld, storeWriterLockPath } from "../src/index.ts";
import { harness, makeBee } from "./helpers.ts";

const coreIndex = new URL("../src/index.ts", import.meta.url).href;

test("writer lock: one holder per store, refused at once, released on close", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  assert.equal(storeWriterLockHeld(h.path), false);
  const store = h.open();
  assert.equal(storeWriterLockHeld(h.path), true);
  assert.ok(existsSync(storeWriterLockPath(h.path)));
  const started = performance.now();
  assert.throws(() => acquireStoreWriterLock(h.path), SecondWriterError);
  assert.throws(() => h.open(), SecondWriterError);
  assert.ok(performance.now() - started < 1_000, "a second writer is refused without waiting");
  assert.equal(storeWriterLockHeld(h.path), true, "a refused writer leaves the holder's lock in place");
  store.close();
  assert.equal(storeWriterLockHeld(h.path), false);
  const lock = acquireStoreWriterLock(h.path);
  assert.throws(() => h.open(), SecondWriterError);
  lock.release();
  lock.release();
  h.open().close();
});

test("writer lock: another process is refused while the holder lives and admitted once it is killed", async (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  h.open().close();
  const holder = spawn(process.execPath, ["--input-type=module", "--eval", `
    import { openCoreStore } from ${JSON.stringify(coreIndex)};
    const store = openCoreStore(process.argv[1], { ephemeral: true });
    store.createBee({ id: "held", name: "held", agent: "stub", substrate: "hsr", cwd: "/tmp" });
    process.stdout.write("held\\n");
    setInterval(() => undefined, 1_000);
  `, h.path], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { holder.kill("SIGKILL"); });
  await once(holder.stdout!, "data");
  assert.equal(storeWriterLockHeld(h.path), true);
  assert.throws(() => h.open(), SecondWriterError);
  const reader = h.open({ readOnly: true });
  assert.equal(reader.getBee("held")?.name, "held");
  reader.close();
  holder.kill("SIGKILL");
  await once(holder, "exit");
  assert.equal(storeWriterLockHeld(h.path), false, "a killed holder leaves no lock behind");
  const next = h.open();
  assert.equal(next.getBee("held")?.name, "held");
  next.close();
});

test("writer lock: a store held the old way (WAL + EXCLUSIVE) still refuses a new writer, and an old-style opener is refused by a new one", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  h.open().close();
  const legacy = new DatabaseSync(h.path);
  legacy.exec("PRAGMA busy_timeout = 0; PRAGMA journal_mode = WAL; PRAGMA locking_mode = EXCLUSIVE; BEGIN IMMEDIATE; UPDATE meta SET value = value WHERE key = 'schema_version'; COMMIT");
  assert.throws(() => h.open(), SecondWriterError);
  assert.equal(storeWriterLockHeld(h.path), false, "the refused writer released the lock it took on the way in");
  legacy.close();
  const store = h.open();
  const old = new DatabaseSync(h.path);
  assert.throws(() => old.exec("PRAGMA busy_timeout = 0; PRAGMA journal_mode = WAL; PRAGMA locking_mode = EXCLUSIVE; BEGIN IMMEDIATE; UPDATE meta SET value = value WHERE key = 'schema_version'; COMMIT"), /locked/);
  old.close();
  makeBee(store, "unaffected");
  store.close();
});

test("read-only handle: attaches beside the writer, reads one snapshot at its seq, and cannot write", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const writer = h.open();
  const { bee } = makeBee(writer, "seen");
  const reader = h.open({ readOnly: true });
  try {
    assert.equal(reader.readOnly, true);
    assert.equal(storeWriterLockHeld(h.path), true);
    assert.equal(reader.getBee(bee.id)?.name, "seen");
    writer.send(bee.id, "first");
    assert.equal(reader.undeliveredMessages(bee.id).length, 1, "a later read sees a later commit");
    const before = writer.lastAuditSeq();
    const read = reader.readAtSeq(() => {
      const first = reader.undeliveredMessages(bee.id).length;
      writer.send(bee.id, "second");
      return [first, reader.undeliveredMessages(bee.id).length, reader.lastAuditSeq()];
    });
    assert.deepEqual(read, { value: [1, 1, before], seq: before }, "a write committed mid-read is outside the snapshot the seq names");
    const after = reader.readAtSeq(() => reader.undeliveredMessages(bee.id).length);
    assert.deepEqual(after, { value: 2, seq: writer.lastAuditSeq() });
    assert.ok(after.seq > before);
    assert.throws(() => reader.readAtSeq(() => reader.readAtSeq(() => null)), /already open/);
    assert.deepEqual(reader.readAtSeq(() => reader.pendingMail(bee.id)).value, writer.pendingMail(bee.id));
    assert.deepEqual(reader.mailHistory(), writer.mailHistory());
    assert.deepEqual(reader.listBeeViewRows("active"), writer.listBeeViewRows("active"));
    const seq = writer.lastAuditSeq();
    assert.throws(() => reader.send(bee.id, "refused"), /readonly/);
    assert.throws(() => reader.archiveBee(bee.id), /readonly/);
    assert.equal(writer.lastAuditSeq(), seq);
    assert.equal(reader.readAtSeq(() => reader.getBee(bee.id)?.lifecycle).value, "active", "a refused write leaves the handle readable");
  } finally {
    reader.close();
    writer.close();
  }
});

test("read-only handle: never creates, migrates or locks a store", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  assert.throws(() => h.open({ readOnly: true }));
  assert.equal(existsSync(h.path), false);
  assert.equal(existsSync(storeWriterLockPath(h.path)), false);
  h.open().close();
  const reader = h.open({ readOnly: true });
  assert.equal(storeWriterLockHeld(h.path), false, "a reader holds no writer lock");
  const writer = h.open();
  makeBee(writer, "beside-a-reader");
  assert.equal(reader.listBeeViewRows("active").length, 1);
  writer.close();
  reader.close();
  const db = new DatabaseSync(h.path);
  db.exec(`UPDATE meta SET value = '${SCHEMA_VERSION - 1}' WHERE key = 'schema_version'`);
  db.close();
  assert.throws(() => h.open({ readOnly: true }), SchemaVersionError);
  const check = new DatabaseSync(h.path, { readOnly: true });
  assert.equal(check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value, String(SCHEMA_VERSION - 1));
  check.close();
  assert.equal(existsSync(`${h.path}.backups`), false, "a refused read-only open takes no migration backup");
});

test("read-only handle: the WAL keeps restarting while a reader reads between commits", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const writer = h.open();
  const reader = h.open({ readOnly: true });
  try {
    const { bee } = makeBee(writer, "busy");
    const body = "x".repeat(4_000);
    let largest = 0;
    let frames = 0;
    for (let i = 0; i < 3_000; i++) {
      const before = statSync(`${h.path}-wal`).size;
      writer.send(bee.id, body);
      const size = statSync(`${h.path}-wal`).size;
      frames += Math.max(0, size - before);
      largest = Math.max(largest, size);
      assert.equal(reader.readAtSeq(() => reader.pendingMail(bee.id, { limit: 3 }).messages.length).value, Math.min(3, i + 1));
    }
    assert.ok(frames > 0);
    assert.ok(largest < 16 * 1024 * 1024, `WAL grew to ${largest} bytes`);
    const held = writer.lastAuditSeq();
    const pinned = reader.readAtSeq(() => {
      for (let i = 0; i < 1_500; i++) writer.send(bee.id, body);
      return statSync(`${h.path}-wal`).size;
    });
    assert.equal(pinned.seq, held);
    assert.ok(pinned.value > largest, "a read held across many commits pins the WAL, which is why no read spans a request");
  } finally {
    reader.close();
    writer.close();
  }
});
