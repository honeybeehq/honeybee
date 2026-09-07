// Disposable, synchronous diagnostics only. Never install this in the live daemon.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';

let tracing = false;

/** Count actual SQLite calls, including cached statements prepared before capture.
 * SQL text is retained; bound parameter values and returned data are never retained.
 * Returned text/blob byte counts describe materialization, not disk I/O.
 * Timing includes observer overhead and is attribution evidence, not a speed score.
 */
export function captureSql(operation) {
  assert.equal(tracing, false, 'nested SQL capture is unsupported');
  const temporary = new DatabaseSync(':memory:');
  let statementPrototype;
  try { statementPrototype = Object.getPrototypeOf(temporary.prepare('SELECT 1')); }
  finally { temporary.close(); }
  tracing = true;
  const originals = [], groups = new Map();
  const wrap = (prototype, name, replacement) => {
    const original = Object.getOwnPropertyDescriptor(prototype, name);
    originals.push([prototype, name, original]);
    Object.defineProperty(prototype, name, { ...original, value: replacement(original.value) });
  };
  const measure = (kind, sql, operation, rowMode) => {
    const key = `${kind}\0${sql}`;
    const group = groups.get(key) ?? { kind, sql, calls: 0, errors: 0, rows: 0,
      textBytes: 0, blobBytes: 0, wallMs: 0, cpuMs: 0 };
    groups.set(key, group); group.calls++;
    const cpu = process.cpuUsage(), start = performance.now();
    let result;
    try { result = operation(); }
    catch (error) { group.errors++; throw error; }
    finally {
      group.wallMs += performance.now() - start;
      const used = process.cpuUsage(cpu); group.cpuMs += (used.user + used.system) / 1000;
    }
    if (rowMode) {
      const rows = rowMode === 'all' ? result : result === undefined ? [] : [result];
      group.rows += rows.length;
      for (const row of rows) for (const value of Object.values(row)) {
        if (typeof value === 'string') group.textBytes += Buffer.byteLength(value);
        else if (value instanceof Uint8Array) group.blobBytes += value.byteLength;
      }
    }
    return result;
  };
  try {
    for (const name of ['all', 'get', 'run']) wrap(statementPrototype, name, original => function (...args) {
      return measure(name, this.sourceSQL, () => original.apply(this, args), name === 'run' ? null : name);
    });
    wrap(statementPrototype, 'iterate', () => function () {
      throw new Error('SQL capture does not support lazy iterate(); measure an explicit iterator workload separately');
    });
    for (const name of ['prepare', 'exec']) wrap(DatabaseSync.prototype, name, original => function (sql, ...args) {
      return measure(name, sql, () => original.call(this, sql, ...args), null);
    });
    const value = operation();
    assert.ok(!value || typeof value.then !== 'function', 'SQL capture requires a synchronous operation');
    return { value, statements: [...groups.values()] };
  } finally {
    for (const [prototype, name, original] of originals.reverse()) Object.defineProperty(prototype, name, original);
    tracing = false;
  }
}
