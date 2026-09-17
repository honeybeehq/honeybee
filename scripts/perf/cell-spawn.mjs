// Owner-side satellite path. Run through run.mjs --suite cell-spawn on the target.
// Reuses the daemon/Cell fixtures; no provider account or live daemon is contacted.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

export async function measureCellSpawn({ root, samples, scenario, record, observations, setCleanup }) {
  const local = p => import(pathToFileURL(join(root, p)).href);
  const { makeDaemonDir, startDaemon, waitFor } = await local('v2/daemon/tests/helpers.ts');
  const { makeOrigin, g, fingerprintOrigin } = await local('v2/driver-cell/tests/helpers.ts');
  const fixture = makeDaemonDir({ nodeKind: 'satellite', cells: { sandbox: scenario.sandbox } });
  // Keep origins, Cells and authority under the SAME disposable fixture root.
  const origins = join(fixture.dir, 'origins'); mkdirSync(origins);
  const makeFixture = () => {
    const origin = makeOrigin(mkdtempSync(join(origins, 'repo-')));
    for (let i = 0; i < 200; i++) writeFileSync(join(origin.repo, 'src', `file-${i}.txt`), `tracked-${i}\n`.repeat(32));
    g(origin.repo, ['add', '.']); g(origin.repo, ['commit', '-m', 'spawn fixture']);
    origin.sha = g(origin.repo, ['rev-parse', 'HEAD']);
    return origin;
  };
  let daemon, client, cleaning;
  const cleanup = () => cleaning ??= (async () => {
    client?.close();
    await daemon?.stop(); // fixture helper verifies detached hosts have exited
    fixture.cleanup();
  })();
  setCleanup(cleanup);
  observations.fixture = fixture.dir;
  observations.samples = [];
  observations.scope = 'satellite source daemon, real Cell worker/runner, stub readiness; no network, account lease, provider boot, repo download or renderer';
  process.stderr.write(JSON.stringify({ event: 'fixture', dir: fixture.dir }) + '\n');
  try {
    daemon = await startDaemon(fixture.dir);
    client = await daemon.client();
    const warmOrigin = scenario.cache === 'warm' ? makeFixture() : null;
    const accept = [], ready = [], usable = [], batches = [];
    const spawnOne = async (origin, round, slot) => {
      const row = { round, slot, warmup: round < 0, ok: false };
      observations.samples.push(row);
      const t = performance.now();
      try {
        const spawn = await client.request('spawn', { name: `perf-cell-${round}-${slot}`, agent: 'stub', substrate: 'cell', cell: { originRepo: origin.repo, sha: origin.sha }, idempotencyKey: `perf-cell-${round}-${slot}` });
        row.beeId = spawn.beeId;
        row.acceptMs = performance.now() - t;
        const view = await waitFor(async () => {
          const result = await client.request('view', { beeId: spawn.beeId });
          const { view } = result;
          if (view.flags.includes('spawn_failed')) { row.failedView = result; row.commands = await client.request('commands', { beeId: spawn.beeId }); throw new Error('Cell failed to boot'); }
          return view.runtimeState === 'idle' && result.bee;
        }, 'Cell stub readiness', 60000, 15);
        row.readyMs = performance.now() - t;
        const sent = await client.request('send', { beeId: spawn.beeId, body: `spawn-proof-${round}-${slot}` });
        await waitFor(async () => {
          const { messages } = await client.request('mailbox', { beeId: spawn.beeId });
          return messages.some(m => m.id === sent.messageId && m.deliveredAt != null);
        }, 'first message delivered', 10000, 15);
        row.usableMs = performance.now() - t;
        assert.equal(view.substrate, 'cell');
        assert.notEqual(view.cwd, origin.repo);
        assert.equal(g(view.cwd, ['rev-parse', 'HEAD']), origin.sha);
        assert.equal(g(view.cwd, ['status', '--porcelain']), '');
        row.ok = true;
      } catch (error) { row.error = String(error); throw error; }
      finally {
        if (row.beeId) {
          await client.request('stop', { beeId: row.beeId });
          await waitFor(async () => (await client.request('view', { beeId: row.beeId })).view.runtimeState === 'stopped', 'owned Cell stopped', 10000, 15);
        }
      }
      return row;
    };
    for (let round = warmOrigin ? -1 : 0; round < samples; round++) {
      const origin = warmOrigin ?? makeFixture();
      const before = fingerprintOrigin(origin.repo);
      const t = performance.now();
      // All settled: no in-flight RPCs survive into fixture cleanup on failure.
      const results = await Promise.allSettled(Array.from({ length: scenario.width }, (_, slot) => spawnOne(origin, round, slot)));
      const batchMs = performance.now() - t;
      assert.deepEqual(fingerprintOrigin(origin.repo), before, 'origin mutated');
      const failed = results.find(r => r.status === 'rejected');
      if (failed) throw failed.reason;
      if (round >= 0) {
        for (const { value } of results) { accept.push(value.acceptMs); ready.push(value.readyMs); usable.push(value.usableMs); }
        batches.push(batchMs);
      }
    }
    record('cell.accept', accept); record('cell.ready', ready); record('cell.usable', usable);
    record('cell.batchIncludingVerificationAndStop', batches);
    observations.health = await client.request('health');
    assert.equal(observations.health.tickErrors, 0);
    assert.equal(observations.health.i1Violations, 0);
    observations.invariantHolds = true;
  } catch (error) {
    process.stderr.write(JSON.stringify({ event: 'cell-spawn-failure', error: String(error), daemonOutput: daemon?.output(), observations }) + '\n');
    throw error;
  } finally { await cleanup(); }
}
