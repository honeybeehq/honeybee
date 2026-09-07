import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { captureSql } from './sql-trace.mjs';

test('counts cached reads, returned bytes, prepares and writes without retaining values', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE records (id INTEGER, body TEXT, payload BLOB)');
    const insert = db.prepare('INSERT INTO records VALUES (?, ?, ?)');
    const get = db.prepare('SELECT * FROM records WHERE id = ?');
    const result = captureSql(() => {
      insert.run(1, 'private-ø', new Uint8Array([1, 2, 3]));
      get.get(1); get.get(2);
      db.prepare('SELECT body, payload FROM records').all();
      db.exec('BEGIN; COMMIT;');
      return 42;
    });
    assert.equal(result.value, 42);
    const reads = result.statements.find(s => s.kind === 'get');
    assert.equal(reads.calls, 2); assert.equal(reads.rows, 1);
    assert.equal(reads.textBytes, Buffer.byteLength('private-ø')); assert.equal(reads.blobBytes, 3);
    assert.equal(result.statements.find(s => s.kind === 'all').rows, 1);
    assert.equal(result.statements.find(s => s.kind === 'prepare').calls, 1);
    assert.equal(result.statements.find(s => s.kind === 'exec').calls, 1);
    assert.equal(result.statements.find(s => s.kind === 'run').calls, 1);
    assert.ok(!JSON.stringify(result.statements).includes('private-ø'));
    for (const s of result.statements) assert.ok(s.wallMs >= 0 && s.cpuMs >= 0 && s.errors === 0);
  } finally { db.close(); }
});

test('restores native methods after SQL failure and rejects partial iterator accounting', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const s = db.prepare('SELECT 1 AS value');
    const all = s.all, prepare = db.prepare;
    assert.throws(() => captureSql(() => db.prepare('invalid SQL')), /syntax/);
    assert.equal(s.all, all); assert.equal(db.prepare, prepare);
    assert.throws(() => captureSql(() => s.iterate()), /does not support lazy iterate/);
    assert.equal([...s.iterate()][0].value, 1);
    assert.throws(() => captureSql(() => captureSql(() => 1)), /nested SQL capture/);
    assert.equal(captureSql(() => s.get()).value.value, 1);
  } finally { db.close(); }
});
