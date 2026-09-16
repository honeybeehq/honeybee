import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Real installed Codex, isolated temporary HOME, local deterministic Responses endpoint.
// Opt in with HONEYBEE_REAL_CODEX_RECONNECT=1; optionally set CODEX_BIN.
// Probe evidence remains in the reported temporary home, never in account config.
test('real Codex refreshes same-thread model tools after native MCP env nonce + reload', {
  skip: process.env.HONEYBEE_REAL_CODEX_RECONNECT !== '1',
  timeout: 120_000,
}, async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('./codex-mcp-reconnect.probe.mjs', import.meta.url)),
    process.env.CODEX_BIN ?? 'codex',
  ], { timeout: 110_000, maxBuffer: 1024 * 1024 });
  const report = JSON.parse(stdout);
  assert.equal(report.ok, true);
  assert.deepEqual(report.before, ['probe_generation_1']);
  assert.deepEqual(report.unchangedReload, ['probe_generation_1']);
  assert.deepEqual(report.after, ['probe_generation_2']);
  assert.deepEqual(report.secondReconnect, ['probe_generation_3']);
  assert.deepEqual(report.loaded.data, [report.threadId]);
});

// The fixture blocks MCP initialize until the model request is captured.
// This proves acknowledgment and turn completion are not catalogue readiness.
test('optional Codex MCP recovers on a normal turn after delayed startup becomes ready', {
  skip: process.env.HONEYBEE_REAL_CODEX_RECONNECT !== '1',
  timeout: 120_000,
}, async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('./codex-mcp-reconnect.probe.mjs', import.meta.url)),
    process.env.CODEX_BIN ?? 'codex', '--optional',
  ], { timeout: 110_000, maxBuffer: 1024 * 1024 });
  const report = JSON.parse(stdout);
  assert.equal(report.ok, true);
  assert.deepEqual(report.initialPending, []);
  assert.deepEqual(report.refreshPending, []);
  assert.deepEqual(report.after, ['probe_generation_2']);
  assert.deepEqual(report.secondReconnect, ['probe_generation_3']);
  assert.deepEqual(report.loaded.data, [report.threadId]);
});
