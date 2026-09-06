import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareCommandHistory } from './compare-command-history.mjs';

function fixture(after = false) {
  const measured = () => ({ raw: [1, 3, 2].map(n => ({ wallMs: n, cpuMs: n })), wallMs: { p50: 999 } });
  const plan = detail => [{ detail }];
  const result = { name: 'small', targetCommands: 10, sqliteBytes: 4096,
    plan: plan('SEARCH commands USING INDEX commands_by_bee (bee_id=?)'),
    pendingUpdate: { plan: plan('SEARCH commands USING INDEX commands_by_bee_status (bee_id=? AND status=?)') },
    pendingProbes: {
      wake: { ...measured(), plan: plan('SEARCH commands USING INDEX commands_by_bee_status (bee_id=? AND status=?)') },
      deletePending: { ...measured(), plan: plan('SEARCH commands USING COVERING INDEX commands_by_bee_status (bee_id=? AND status=?)') },
    },
  };
  for (const op of ['reads', 'missing', 'queued', 'reconfigure', 'transitions']) result[op] = measured();
  return { completed: true, prototype: 'none', sourceHashes: { 'store.ts': (after ? 'd' : 'a').repeat(64), 'schema.ts': 'b'.repeat(64) },
    revision: 'example', toolSha256: 'c'.repeat(64), environment: { node: 'v25', platform: 'darwin', arch: 'arm64', cpu: 'fixture', hostname: 'fixture' },
    workload: { cases: [{ name: 'small' }], samples: 3, largeResultSamples: 3, transitionBatch: { samples: 3 } }, results: [result] };
}

test('command comparison recomputes medians rather than trusting a reported summary', () => {
  const result = compareCommandHistory(fixture(), fixture(true));
  assert.equal(result.rows[0].before, 2);
  assert.equal(result.rows[0].after, 2);
  assert.equal(result.rows[0].deltaPercent, 0);
});

test('command comparison rejects the actual pending-history plan regression and incompatible evidence', () => {
  for (const mutate of [
    r => { r.results[0].pendingProbes.deletePending.plan = [{ detail: 'SEARCH commands USING INDEX commands_by_bee (bee_id=?)' }]; },
    r => { r.toolSha256 = 'd'.repeat(64); },
    r => { r.environment.hostname = 'other'; },
    r => { r.prototype = 'both'; },
    r => { r.sourceHashes['store.ts'] = 'a'.repeat(64); },
    r => { r.results[0].reads.raw.pop(); },
    r => { r.results[0].reads.raw[0].wallMs = NaN; },
  ]) {
    const after = fixture(true); mutate(after);
    assert.throws(() => compareCommandHistory(fixture(), after));
  }
});

test('command comparison allows renamed hosts only with matching measured OS boot identity', () => {
  const before = fixture(), after = fixture(true);
  before.environment.bootIdentity = { method: 'darwin-kern.bootsessionuuid-sha256', sha256: 'e'.repeat(64) };
  after.environment.bootIdentity = { ...before.environment.bootIdentity };
  after.environment.hostname = 'renamed';
  assert.equal(compareCommandHistory(before, after).bootIdentity.sha256, 'e'.repeat(64));
  after.environment.bootIdentity.sha256 = 'f'.repeat(64);
  assert.throws(() => compareCommandHistory(before, after));
  delete after.environment.bootIdentity;
  assert.throws(() => compareCommandHistory(before, after));
});
