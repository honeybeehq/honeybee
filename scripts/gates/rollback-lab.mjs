import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, cp, mkdir, mkdtemp, readFile, readlink, rename, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { deployVersion, readDeployHistory } from '../../dist/deployRuntime.js';
import { restartDeployedDaemon } from '../../dist/commands/deploy.js';
import { persistNodePin, probeNativeNode, nodePinFile } from '../../dist/nodeRuntime.js';
import { packRuntimeArtifact, sha256File } from '../../dist/runtimeArtifact.js';
import { recoverySubjectDigest, parseRecoveryPlan } from '../../dist/release/index.js';
import { writeBuildStamp } from '../../dist/deploySettle.js';
import { UPDATE_RECOVERY_CONTRACT } from '../../dist/updateAdmission.js';

if (process.platform !== 'linux') throw new Error('Linux fixture only');
const exec = promisify(execFile), repo = resolve('.');
const out = resolve(process.argv[2] ?? '.audit/t4/rollback-lab');
await mkdir(out, { recursive: true });
const originalEnv = { ...process.env };
const results = [];
for (const mode of ['source', 'artifact', 'migration']) {
  const root = await mkdtemp(join(out, 'hb-rollback-')), runtime = join(root, 'runtime'), data = join(root, 'v2');
  await writeFile(join(root, 'ROLLBACK_FIXTURE'), 'isolated rollback lab');
  const bin = join(root, 'bin'), units = join(root, 'units');
  await Promise.all([runtime, data, bin, units, join(root, 'home')].map(path => mkdir(path, { recursive: true })));
  const home = await mkdtemp('/tmp/hb-rh-');
  Object.assign(process.env, { HOME: home, TMPDIR: home, HIVE_STORE_ROOT: root,
    HIVE_V2_DATA_DIR: data, HIVE_V2_SERVICE_DIR: units, HIVE_V2_SERVICE_LABEL: 'honeybee.rollback.fixture',
    HIVE_TEST_ROLLBACK_ROOT: root, HIVE_NO_KEYCHAIN: '1', PATH: `${bin}:${originalEnv.PATH}` });
  delete process.env.HIVE_NODE_PATH;
  delete process.env.HIVE_NODE_VERSION;
  delete process.env.HIVE_NODE_SHA256;
  delete process.env.NODE_OPTIONS;
  delete process.env.ELECTRON_RUN_AS_NODE;
  await writeFile(join(bin, 'systemctl'), `#!/bin/sh\nexec '${process.execPath}' '${join(repo, 'scripts/gates/rollback-systemctl.mjs')}' "$@"\n`, { mode: 0o755 });
  await writeFile(join(data, 'config.json'), JSON.stringify({ naming: { auto: false }, cells: { warmPoolFree: 0, warmPoolMaxSize: 1 } }));
  persistNodePin(data, probeNativeNode(process.execPath));
  const git = async (...args) => (await exec('git', ['-C', root, ...args])).stdout.trim();
  await git('init', '-q');
  await writeFile(join(root, 'marker'), 'old');
  await git('add', 'marker');
  await git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'old');
  const oldSha = await git('rev-parse', 'HEAD');
  await writeFile(join(root, 'marker'), 'candidate');
  await git('add', 'marker');
  await git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'candidate');
  const nextSha = await git('rev-parse', 'HEAD');
  await writeFile(join(root, '.git', 'info', 'exclude'), '*\n');
  const makeBuild = async (sha, fail) => {
    const stage = join(root, `stage-${sha}`);
    await mkdir(stage);
    await cp(join(repo, 'dist'), join(stage, 'dist'), { recursive: true });
    await cp(join(repo, 'contracts'), join(stage, 'contracts'), { recursive: true });
    await cp(join(repo, 'node_modules'), join(stage, 'node_modules'), { recursive: true, verbatimSymlinks: true, filter: path => !path.includes('/.bin') && !path.includes('/vendor/') && !path.includes('/node-pty/') && !path.includes('/typescript/') && !path.includes('/@esbuild/') });
    await writeFile(join(stage, 'package.json'), JSON.stringify({ name: 'honeybee', version: '0.0.1', type: 'module', engines: { node: '>=24' } }));
    const bundleFile = join(stage, 'dist', 'v2', 'cli.js');
    let bundle = await readFile(bundleFile, 'utf8');
    if (mode === 'artifact') {
      bundle = bundle.replace(/var SCHEMA_VERSION = \d+;/, 'var SCHEMA_VERSION = 27;');
      bundle += '\nif ((await import("node:fs")).realpathSync(process.argv[1]) === (await import("node:url")).fileURLToPath(import.meta.url)) process.exitCode = await runV2Cli(process.argv.slice(2));\n';
    }
    if (mode === 'migration' && fail) {
      bundle = bundle.replace(/var SCHEMA_VERSION = \d+;/, 'var SCHEMA_VERSION = 49;');
      const needle = '    this.store = store;\n    const redaction = store.rpcIdempotencyRedactionReceipt;';
      assert.ok(bundle.includes(needle));
      bundle = bundle.replace(needle, '    this.store = store;\n    throw new Error("rollback lab: candidate start() failed after migration");\n    const redaction = store.rpcIdempotencyRedactionReceipt;');
    } else if (fail) {
      const needle = 'async start() {\n    const runtimeTarget =';
      assert.ok(bundle.includes(needle));
      bundle = bundle.replace(needle, 'async start() {\n    throw new Error("rollback lab: candidate start() failed");\n    const runtimeTarget =');
    }
    await writeFile(bundleFile, bundle);
    await writeFile(join(stage, 'dist', 'build-identity.json'), JSON.stringify({ schemaVersion: 1, component: 'honeybee', version: '0.0.1', packageVersion: '0.0.1', sourceRevision: sha, dirty: false, release: true, target: `${process.platform}-${process.arch}` }));
    await writeBuildStamp(join(stage, 'dist'));
    return stage;
  };
  const old = await makeBuild(oldSha, false), candidate = await makeBuild(nextSha, true);
  await cp(old, join(runtime, oldSha), { recursive: true });
  const external = join(root, 'apiary', 'honeybee-runtime', 'd'.repeat(64), 'lib', 'node_modules', 'honeybee');
  await mkdir(external, { recursive: true });
  await cp(old, external, { recursive: true });
  await symlink(external, join(runtime, 'current'));
  await writeFile(join(runtime, 'runtime-mode.json'), JSON.stringify({ schemaVersion: 1, runtime: 'v2' }));
  await writeFile(join(runtime, 'deploys.json'), JSON.stringify({ schemaVersion: 1, entries: [{ sha: oldSha, artifactHash: 'fixture', at: new Date().toISOString(), by: 'rollback-lab' }] }));
  const transcript = [];
  const run = async (...args) => {
    try {
      const result = await exec(process.execPath, [join(runtime, 'current', 'dist', 'cli.js'), ...args], { env: process.env, timeout: 15000, maxBuffer: 4 * 1024 ** 2 });
      transcript.push(`$ hive ${args.join(' ')}\n${result.stdout}${result.stderr}`);
      return result.stdout;
    } catch (error) {
      transcript.push(`$ hive ${args.join(' ')}\n${error.stdout ?? ''}${error.stderr ?? ''}`);
      throw error;
    }
  };
  try {
    await run('v2', 'daemon', 'install', '--data-dir', data);
    await run('v2', 'daemon', 'start', '--data-dir', data);
    const before = JSON.parse(await run('v2', 'deploy-info', '--data-dir', data, '--json'));
    const service = await readFile(join(units, 'honeybee.rollback.fixture.service'));
    const pin = await readFile(nodePinFile(data));
    const listed = JSON.parse(await run('deploy', '--list', '--json'));
    assert.equal(listed.current, oldSha);
    await copyFile(process.execPath, join(root, 'candidate-node'));
    if (mode !== 'artifact') process.env.HIVE_NODE_PATH = join(root, 'candidate-node');
    let failure;
    const causes = [];
    if (mode !== 'artifact') {
      try {
        await deployVersion({ root: runtime, repoRoot: root, ref: nextSha, log: line => transcript.push(line), hooks: {
          buildArtifact: async () => ({ artifactDir: candidate }), restartDaemon: restartDeployedDaemon,
        } });
      } catch (error) { failure = error.message; for (let cause = error.cause; cause instanceof Error; cause = cause.cause) causes.push(cause.message); }
    } else {
      const packed = await packRuntimeArtifact({ artifactDir: candidate, sha: nextSha, outDir: join(root, 'out') });
      const identity = { component: 'honeybee', version: '0.0.1', sourceRevision: nextSha, target: `${process.platform}-${process.arch}`,
        artifact: { url: 'https://fixture.invalid/runtime.tgz', sha256: `sha256:${(await sha256File(packed.tarballPath)).sha256}` } };
      const recovery = parseRecoveryPlan(JSON.parse(await readFile(join(repo, 'contracts/release/v1/fixtures/recovery-plan.json'), 'utf8')));
      recovery.subject.to.honeybee = identity;
      recovery.subject.storageRequirements = [UPDATE_RECOVERY_CONTRACT];
      recovery.subjectDigest = recoverySubjectDigest(recovery.subject);
      for (const evidence of recovery.evidence) evidence.subjectDigest = recovery.subjectDigest;
      const requestFile = join(root, 'reserve.json');
      await writeFile(requestFile, JSON.stringify({ id: 'rollback-lab', recoverySubjectDigest: recovery.subjectDigest, expectedEpoch: 0 }));
      const reservation = JSON.parse(await run('v2', 'update-owner', 'reserve', requestFile, '--data-dir', data));
      const identityFile = join(root, 'identity.json'), admissionFile = join(root, 'admission.json');
      await writeFile(identityFile, JSON.stringify(identity));
      await writeFile(admissionFile, JSON.stringify({ reservation, recovery }));
      try { await run('deploy', '--artifact', packed.tarballPath, '--identity', identityFile, '--admission', admissionFile, '--expected-current', oldSha); }
      catch (error) { failure = error.stderr; }
    }
    assert.ok(failure, 'candidate must fail');
    transcript.push(`activation failure: ${failure}`);
    if (mode === 'migration') {
      assert.match(failure, /ROLLBACK_STORE_RESTORE_REQUIRED/);
      assert.match(failure, /store restore --from/);
      assert.equal(await readlink(join(runtime, 'current')), nextSha);
      assert.deepEqual(await readFile(join(units, 'honeybee.rollback.fixture.service')), service);
      assert.deepEqual(await readFile(nodePinFile(data)), pin);
      assert.ok(causes.some(message => message.includes('daemon start')));
      transcript.push('activation causes: ' + causes.join(' -> '));
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(join(data, 'core.sqlite3'), { readOnly: true });
      try { assert.equal(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '49'); }
      finally { db.close(); }
      assert.equal((await readDeployHistory(runtime)).some(entry => entry.sha === nextSha), false);
      results.push({ mode, root, schema: 49, previousSchema: 48, refused: 'ROLLBACK_STORE_RESTORE_REQUIRED', failedCandidateRecorded: false });
      console.log('migration: PASS real store migration 48 -> synthetic49, start() failure, typed restore-required refusal; old binary was not restarted');
      continue;
    }
    assert.equal(await readlink(join(runtime, 'current')), external);
    assert.deepEqual(await readFile(join(units, 'honeybee.rollback.fixture.service')), service);
    assert.deepEqual(await readFile(nodePinFile(data)), pin);
    const after = JSON.parse(await run('v2', 'deploy-info', '--data-dir', data, '--json'));
    const status = JSON.parse(await run('v2', 'daemon', 'status', '--data-dir', data, '--json'));
    assert.equal(after.identity.sourceRevision, before.identity.sourceRevision);
    assert.notEqual(after.pid, before.pid);
    assert.equal(status.running, true);
    assert.equal((await readDeployHistory(runtime)).some(entry => entry.sha === nextSha), false);
    const logs = (await import('node:fs/promises')).readdir(root);
    let sawFailure = false;
    for (const name of await logs) if (/^daemon-.*\.log$/.test(name)) {
      const text = await readFile(join(root, name), 'utf8');
      sawFailure ||= text.includes('rollback lab: candidate start() failed');
      await writeFile(join(out, `${mode}-${name}`), text);
    }
    assert.ok(sawFailure, 'real daemon start failure must be captured');
    results.push({ mode, root, before: { pid: before.pid, identity: before.identity }, after: { pid: after.pid, identity: after.identity }, ready: status.running, restoredService: true, restoredPin: true, failedCandidateRecorded: false, schemaFixture: mode === 'artifact' ? 'synthetic schema27 with executable standalone CLI entry for existing admission; not a historical binary or schema48 updater proof' : 'native schema' });
    console.log(`${mode}: PASS real start() failure; old PID ${before.pid} -> ${after.pid}; RPC ready, identity/service/pin/link/history verified`);
    if (mode === 'source') {
      delete process.env.HIVE_NODE_PATH;
      await writeFile(join(root, 'marker'), 'working candidate');
      await git('add', 'marker');
      await git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'working candidate');
      const workingSha = await git('rev-parse', 'HEAD');
      const working = await makeBuild(workingSha, false);
      await deployVersion({ root: runtime, repoRoot: root, ref: workingSha, log: line => transcript.push(line), hooks: {
        buildArtifact: async () => ({ artifactDir: working }), restartDaemon: restartDeployedDaemon,
      } });
      assert.equal(await readlink(join(runtime, 'current')), workingSha);
      await run('deploy', '--rollback');
      assert.equal(await readlink(join(runtime, 'current')), oldSha);
      const rolledBack = JSON.parse(await run('v2', 'deploy-info', '--data-dir', data, '--json'));
      assert.equal(rolledBack.identity.sourceRevision, oldSha);
      results.at(-1).manualRollback = { from: workingSha, to: oldSha, pid: rolledBack.pid };
      console.log('external current: PASS successful deploy then hive deploy --rollback to retained original Apiary build, verified through RPC');
      const temporary = join(runtime, 'apiary-current');
      await symlink(external, temporary);
      await rename(temporary, join(runtime, 'current'));
      await run('deploy', '--rollback');
      assert.equal(await readlink(join(runtime, 'current')), workingSha);
      await run('deploy', '--rollback');
      assert.equal(await readlink(join(runtime, 'current')), oldSha);
      const returned = JSON.parse(await run('v2', 'deploy-info', '--data-dir', data, '--json'));
      assert.equal(returned.identity.sourceRevision, oldSha);
      results.at(-1).externalRollbackRoundTrip = true;
      console.log('external current: PASS explicit rollback away and second rollback back to retained bytes, verified through RPC');
    }

  } finally {
    await exec(process.execPath, [join(repo, 'scripts/gates/rollback-systemctl.mjs'), '--user', 'stop', 'honeybee.rollback.fixture.service'], { env: process.env });
    await writeFile(join(out, `${mode}-cli.log`), transcript.join('\n'));
    await cp(join(root, 'systemctl.jsonl'), join(out, `${mode}-systemctl.jsonl`));
    for (const name of await (await import('node:fs/promises')).readdir(root)) if (/^daemon-.*\.log$/.test(name)) await cp(join(root, name), join(out, `${mode}-${name}`));
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  }
}
await writeFile(join(out, 'receipt.json'), JSON.stringify(results, null, 2));
console.log(`Evidence: ${out}`);
