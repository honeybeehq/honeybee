#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from '../../v2/core/src/schema.ts';

const args = process.argv.slice(2);
const revision = args.includes('--revision') ? args[args.indexOf('--revision') + 1] : null;
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
let source;
if (revision) {
  assert.match(revision, /^[a-f0-9]{7,40}$/, 'revision must be a commit SHA');
  const p = spawnSync('git', ['show', `${revision}:v2/core/src/store.ts`], { encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr); source = p.stdout;
} else source = readFileSync(new URL('../../v2/core/src/store.ts', import.meta.url), 'utf8');
const queries = [...source.matchAll(/`(SELECT runtime\.\*[\s\S]*?)`/g)];
assert.equal(queries.length, 1, 'expected one latest-runtime query in CoreStore');
const sql = queries[0][1];
const db = new DatabaseSync(':memory:');
try {
  db.exec(SCHEMA_SQL);
  const result = JSON.stringify({ revision: revision ?? 'working tree', sqlite: db.prepare('SELECT sqlite_version() AS version').get().version, sql, plan: db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(), note: 'Empty schema with current indexes; speed claims use seeded production-store workloads, not these planner estimates.' }, null, 2) + '\n';
  if (out) writeFileSync(out, result);
  else process.stdout.write(result);
} finally { db.close(); }
