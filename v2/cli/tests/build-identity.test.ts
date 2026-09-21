import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { runV2Cli } from '../src/main.ts';
import { BUILD_IDENTITY } from '../../daemon/src/protocol.ts';
import { makeDaemonDir } from '../../daemon/tests/helpers.ts';

test('deploy-info distinguishes the running daemon from this CLI and preserves legacy unknown', async () => {
  const { dir, cleanup } = makeDaemonDir();
  const socketPath = join(dir, 'identity.sock');
  const daemonIdentity = { ...BUILD_IDENTITY, version: '9.0.0', packageVersion: '9.0.0', sourceRevision: 'b'.repeat(40), dirty: false, release: true };
  let identity: unknown = daemonIdentity;
  const server = createServer(socket => {
    socket.setEncoding('utf8');
    socket.write(`${JSON.stringify({ protocol: 'v2/1', identity })}\n`);
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      for (;;) {
        const index = buffer.indexOf('\n');
        if (index < 0) return;
        const frame = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
        if (frame.verb === 'deployInfo') socket.write(`${JSON.stringify({ id: frame.id, ok: true, result: { daemonVersion: '9.0.0', identity } })}\n`);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  try {
    for (const current of [true, false]) {
      identity = current ? daemonIdentity : undefined;
      let stdout = '';
      const status = await runV2Cli(['deploy-info', '--json', '--socket', socketPath, '--data-dir', dir], { out: s => { stdout += s; }, err: () => {} });
      assert.equal(status, 0);
      const result = JSON.parse(stdout);
      assert.deepEqual(result.cliIdentity, BUILD_IDENTITY);
      assert.deepEqual(result.daemonIdentity, current ? daemonIdentity : null);
    }
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); cleanup(); }
});
