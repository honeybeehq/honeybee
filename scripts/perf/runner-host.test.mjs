import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const tool = resolve('scripts/perf/runner-host.mjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(idleMs, run) {
  const dir = mkdtempSync(join(tmpdir(), 'hb-host-tool-test-'));
  const spec = { rounds: 2, idleMs, agent: resolve('v2/driver-hsr/test-agent/agent.mjs'),
    implementations: ['a', 'b'].map(name => ({ name, entry: resolve('v2/driver-hsr/src/runner-host-main.ts'), args: [] })) };
  const specPath = join(dir, 'spec.json'), out = join(dir, 'result.json');
  writeFileSync(specPath, JSON.stringify(spec));
  const child = spawn(process.execPath, [tool, specPath, out], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  const timeout = setTimeout(() => child.kill('SIGTERM'), 180000);
  try { await run({ child, exited, out, stderr: () => stderr }); }
  finally { clearTimeout(timeout); if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exited; rmSync(dir, { recursive: true, force: true }); }
}

test('host measurement completes real turns and omits idle CPU when no idle interval was requested', async () => {
  await fixture(0, async ({ exited, out, stderr }) => {
    assert.equal((await exited).code, 0, stderr());
    const report = JSON.parse(readFileSync(out, 'utf8'));
    for (const result of report.results) {
      assert.equal(result.raw.length, 2);
      assert.ok(result.raw.every(row => row.hostRssBytes > 0 && row.agentReadyMs >= row.hostReadyMs));
      assert.ok(!('idleCpuOneCorePercent' in result.metrics));
    }
    assert.equal(existsSync(JSON.parse(stderr().split('\n')[0]).dir), false);
  });
});

test('SIGTERM reaps the active host and removes its disposable fixture without publishing results', async () => {
  await fixture(30000, async ({ child, exited, out, stderr }) => {
    let fixtureDir, hostPid;
    const deadline = Date.now() + 20000;
    while (!hostPid && Date.now() < deadline) {
      const first = stderr().split('\n')[0];
      if (first) fixtureDir = JSON.parse(first).dir;
      if (fixtureDir && existsSync(fixtureDir)) {
        for (const entry of readdirSync(fixtureDir)) {
          const status = join(fixtureDir, entry, 'status.json');
          if (existsSync(status)) {
            try { const value = JSON.parse(readFileSync(status, 'utf8')); if (value.agentPid) hostPid = value.hostPid; }
            catch (error) { if (!(error instanceof SyntaxError)) throw error; }
          }
        }
      }
      if (!hostPid) await sleep(10);
    }
    assert.ok(hostPid, stderr());
    child.kill('SIGTERM');
    assert.equal((await exited).code, 143, stderr());
    assert.throws(() => process.kill(hostPid, 0), { code: 'ESRCH' });
    assert.equal(existsSync(fixtureDir), false);
    assert.equal(existsSync(out), false);
  });
});
