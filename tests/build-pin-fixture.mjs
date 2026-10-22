import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, cp, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deployVersion, currentDeployTarget } from '../dist/deployRuntime.js';
import { buildReport } from '../dist/buildPin.js';
import { persistNodePin, probeNativeNode } from '../dist/nodeRuntime.js';

const exec = promisify(execFile);
const dir = await mkdtemp(join(tmpdir(), 'hb-build-pin-proof-'));
const root = join(dir, 'runtime'), dataDir = join(dir, 'v2'), repoRoot = join(dir, 'repo');
const transcript = join(dir, 'cli-output.log'), daemonLog = join(dir, 'daemon.log');
await mkdir(repoRoot, { recursive: true });
await mkdir(dataDir, { recursive: true });
await mkdir(join(dir, 'home'), { recursive: true });
persistNodePin(dataDir, probeNativeNode(process.execPath));
await writeFile(join(dataDir, 'config.json'), JSON.stringify({ accounts: { discover: false, limitsRefreshMs: 0 }, naming: { auto: false }, cells: { root: join(dir, 'cells') } }));
const env = { ...process.env, HOME: join(dir, 'home'), HIVE_STORE_ROOT: dir, HIVE_V2_DATA_DIR: dataDir, HIVE_NODE_PATH: process.execPath, HIVE_NO_KEYCHAIN: '1', HIVE_GATEWAYS_DISABLE: '1' };
for (const key of ['HIVE_BEE_ID', 'HIVE_CALLER_BEE_ID', 'HIVE_CALLER_DATA_DIR', 'HIVE_EXPECTED_INSTANCE_ID', 'HIVE_RPC_TOKEN', 'NODE_OPTIONS']) delete env[key];
const log = async line => { console.log(line); await appendFile(transcript, line + '\n'); };
const git = async (...args) => (await exec('git', ['-C', repoRoot, ...args], { env })).stdout.trim();
await exec('git', ['init', '-q', repoRoot], { env });
async function commit(marker) {
  await writeFile(join(repoRoot, 'marker'), marker);
  await git('add', 'marker');
  await git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', marker);
  return git('rev-parse', 'HEAD');
}
const first = await commit('pinned build'), second = await commit('different build');
let daemon = null;
let failNextActivation = false;
async function stop() {
  if (!daemon || daemon.exitCode !== null || daemon.signalCode !== null) return;
  const child = daemon;
  await new Promise((done, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('fixture daemon stop timed out')); }, 4000);
    child.once('exit', () => { clearTimeout(timeout); done(); });
    child.kill('SIGTERM');
  });
}
async function cli(...args) {
  const argv = [join(root, 'current', 'dist', 'cli.js'), 'v2', ...args, '--data-dir', dataDir, '--json'];
  const { stdout } = await exec(process.execPath, argv, { env, timeout: 4000 });
  await log(`$ hive v2 ${args.join(' ')} --data-dir <fixture>/v2 --json\n${stdout.trim()}`);
  return JSON.parse(stdout);
}
const hooks = {
  async buildArtifact({ sha, workDir }) {
    const artifactDir = join(workDir, 'stage');
    await mkdir(artifactDir, { recursive: true });
    await cp(resolve('dist'), join(artifactDir, 'dist'), { recursive: true });
    await writeFile(join(artifactDir, 'package.json'), JSON.stringify({ name: 'honeybee', version: '0.0.1', type: 'module' }));
    await writeFile(join(artifactDir, 'dist', 'build-identity.json'), JSON.stringify({ schemaVersion: 1, component: 'honeybee', version: '0.0.1', packageVersion: '0.0.1', sourceRevision: sha, target: `${process.platform}-${process.arch}`, dirty: false, release: false }));
    return { artifactDir };
  },
  async restartDaemon(context) {
    await stop();
    const failed = failNextActivation;
    if (failed) {
      failNextActivation = false;
      await context.restorePrevious();
    }
    daemon = spawn(process.execPath, [join(root, 'current', 'dist', 'cli.js'), 'v2', 'daemon', 'run', '--data-dir', dataDir], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    daemon.stdout.on('data', chunk => { void appendFile(daemonLog, chunk); });
    daemon.stderr.on('data', chunk => { void appendFile(daemonLog, chunk); });
    for (let i = 0; i < 50; i++) {
      if (daemon.exitCode !== null) throw new Error(`fixture daemon exited ${daemon.exitCode}; see ${daemonLog}`);
      try {
        const { stdout } = await exec(process.execPath, [join(root, 'current', 'dist', 'cli.js'), 'v2', 'build-report', '--data-dir', dataDir, '--json'], { env, timeout: 2000 });
        if (JSON.parse(stdout).running) {
          if (failed) throw Object.assign(new Error("fixture injected activation failure after restoring previous daemon"), { fixtureFailure: true });
          return;
        }
      } catch (error) { if (error.fixtureFailure) throw error; }
      await new Promise(r => setTimeout(r, 40));
    }
    throw new Error(`fixture readiness timed out; see ${daemonLog}`);
  },
};
try {
  await log(`Fixture root: ${dir}`);
  await deployVersion({ root, repoRoot, ref: first, hooks });
  await cli('build-pin', 'set', first, `${process.platform}-${process.arch}`);
  const agrees = await cli('build-report');
  assert.equal(agrees.verdict, 'agrees');
  await cli('build-pin', 'set', second, `${process.platform}-${process.arch}`);
  failNextActivation = true;
  await assert.rejects(deployVersion({ root, repoRoot, ref: second, hooks }), /fixture injected activation failure/);
  const recovered = await cli('build-report');
  assert.equal(recovered.running.sourceRevision, first);
  assert.equal(recovered.desired.sourceRevision, second);
  assert.equal(recovered.verdict, 'drift');
  await log('PASS: failed pinned activation restored the previous daemon; desired future pin reports drift without preventing recovery.');
  await cli('build-pin', 'set', first, `${process.platform}-${process.arch}`);
  try {
    await deployVersion({ root, repoRoot, ref: second, hooks });
    assert.fail('mismatched build accepted');
  } catch (error) {
    assert.equal(error.code, 'build_pin_mismatch');
    await log(`deployVersion fixture refused: ${error.code}: ${error.message}`);
  }
  assert.equal(await currentDeployTarget(root), first);
  await deployVersion({ root, repoRoot, ref: second, hooks, buildPinOverride: 'isolated fixture proof' });
  const drift = await cli('build-report');
  assert.equal(drift.verdict, 'drift');
  assert.equal(drift.desired.sourceRevision, first);
  assert.equal(drift.running.sourceRevision, second);
  const legacy = await buildReport(root, { ...drift.running, target: 'darwin-arm64' }, 44);
  assert.ok(legacy.drift.includes('running.hostTarget'));
  await log('Legacy metal-1-shaped fixture (injected running identity on Linux):\n' + JSON.stringify(legacy));
  await log('PASS: desired pin retained; different revision refused; recorded override activates and reports drift.');
  await log(`Evidence: ${transcript} ${daemonLog}`);
} finally {
  await stop();
}
