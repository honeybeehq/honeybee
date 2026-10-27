#!/usr/bin/env node
/** Disposable fixture only. Never connects beyond numeric loopback. */
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const evidence = resolve('.audit/backup-b2');
mkdirSync(evidence, { recursive: true });
const pick = (override, local, command) => override || (existsSync(local) ? resolve(local) : command);
const restic = pick(process.env.HIVE_TEST_RESTIC, '.audit/backup-b2/tools/restic', 'restic');
const server = pick(process.env.HIVE_TEST_REST_SERVER, '.audit/backup-b2/tools/rest-server_0.14.0_linux_amd64/rest-server', 'rest-server');
for (const [command, args] of [[restic, ['version']], [server, ['--version']]]) {
  const check = spawnSync(command, args, { stdio: 'pipe' });
  if (check.error || check.status !== 0) {
    console.error('Install restic and rest-server locally, or set HIVE_TEST_RESTIC and HIVE_TEST_REST_SERVER to their executables.');
    process.exit(2);
  }
}
const result = spawnSync(process.execPath, ['--test', 'v2/daemon/tests/backup-capture.test.ts'], {
  stdio: 'inherit', env: { ...process.env, HIVE_TEST_RESTIC: restic, HIVE_TEST_REST_SERVER: server },
});
process.exit(result.status ?? 1);
