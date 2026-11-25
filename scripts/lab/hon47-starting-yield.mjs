import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import {openCoreStore} from '../../v2/core/src/index.ts';
import {SCHEMA_VERSION} from '../../v2/core/src/schema.ts';
import {makeDaemonDir} from '../../v2/daemon/tests/helpers.ts';
import {RpcClient} from '../../v2/cli/src/client.ts';

const {values: opt} = parseArgs({options: {
  sessions: {type: 'string', default: '12000'},
  mode: {type: 'string', default: 'reconcile'},
  'poll-ms': {type: 'string', default: '500'},
  'migrate-hold-ms': {type: 'string', default: '10000'},
  'min-phase-ms': {type: 'string', default: '0'},
  'ready-timeout-ms': {type: 'string', default: '600000'},
  'cpu-prof': {type: 'boolean', default: false},
  keep: {type: 'boolean', default: false},
}});
const sessions = Number(opt.sessions), pollMs = Number(opt['poll-ms']), minPhaseMs = Number(opt['min-phase-ms']);
assert(['reconcile', 'migrate'].includes(opt.mode), '--mode reconcile|migrate');
const base = process.env.TMPDIR ?? '/tmp';
assert(!resolve(base).startsWith(join(homedir(), '.hive')), 'lab TMPDIR must not be under ~/.hive');

const repo = resolve(new URL('../..', import.meta.url).pathname);
const cli = join(repo, 'v2/cli/src/bin.ts');
const fixture = join(repo, 'v2/daemon/tests/fixtures/starting-daemon.mjs');
const root = mkdtempSync(join(base, 'hon47-'));
const rig = makeDaemonDir({}, {base: root});
const dir = rig.dir;
const home = join(root, 'home');
const env = {...process.env, HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_CACHE_HOME: join(home, 'cache'), XDG_STATE_HOME: join(home, 'state'), HIVE_GATEWAYS_DISABLE: '1', HIVE_NO_KEYCHAIN: '1', HIVE_TEST_REAP_RUNTIMES_ON_SHUTDOWN: '0'};
for (const key of ['HIVE_DATA_DIR', 'HIVE_V2_DATA_DIR', 'HIVE_SOCKET', 'HIVE_V2_SOCKET', 'HIVE_BEE_ID', 'HIVE_V2_BEE_ID']) delete env[key];
for (const path of [home, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME, env.XDG_STATE_HOME]) mkdirSync(path, {recursive: true});
const log = (record) => console.log(JSON.stringify({t: Date.now(), ...record}));

const storePath = join(dir, 'core.sqlite3');
const seedStart = Date.now();
{
  const store = openCoreStore(storePath, {ephemeral: true});
  for (let i = 0; i < sessions; i++) {
    const {bee} = store.createBee({name: `lab-${i}`, agent: 'stub', substrate: 'hsr', cwd: root, tags: i % 7 === 0 ? ['lab'] : []});
    store.updateRuntimeState(bee.id, 1, 'stopped', {exitCause: 'clean'});
    if (i % 2 === 0) {
      store.reviveBee(bee.id);
      store.updateRuntimeState(bee.id, 2, 'stopped', {exitCause: i % 4 === 0 ? 'crashed' : 'stopped_by_user'});
    }
    if (i % 3 === 0) store.archiveBee(bee.id);
  }
  store.close();
}
if (opt.mode === 'migrate') {
  const db = new DatabaseSync(storePath);
  db.exec('ALTER TABLE flags DROP COLUMN error');
  db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION - 1));
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
}
log({event: 'seeded', sessions, mode: opt.mode, ms: Date.now() - seedStart, root});

const socketPath = join(dir, 'hived.sock');
const daemonEnv = {...env, ...(opt.mode === 'migrate' ? {HON47_MIGRATE_HOLD_MS: opt['migrate-hold-ms']} : {})};
const nodeArgs = opt['cpu-prof'] ? ['--cpu-prof', `--cpu-prof-dir=${join(root, 'prof')}`] : [];
const daemon = spawn(process.execPath, [...nodeArgs, fixture, dir, opt.mode === 'migrate' ? 'migrate-held' : 'natural'], {env: daemonEnv, stdio: ['ignore', 'pipe', 'pipe']});
let daemonOutput = '';
daemon.stdout.on('data', chunk => daemonOutput += chunk);
daemon.stderr.on('data', chunk => daemonOutput += chunk);
const launchedAt = Date.now();
log({event: 'daemon_launched', pid: daemon.pid});

const health = () => new Promise(resolveHealth => {
  const started = Date.now();
  const child = spawn(process.execPath, [cli, 'health', '--json', '--data-dir', dir], {env, stdio: ['ignore', 'pipe', 'pipe']});
  let out = '', err = '';
  child.stdout.on('data', chunk => out += chunk);
  child.stderr.on('data', chunk => err += chunk);
  child.on('close', code => {
    let json = null;
    try { json = JSON.parse(out.trim().split('\n').pop() ?? ''); } catch {}
    resolveHealth({exit: code, ms: Date.now() - started, state: json?.boot?.state ?? null, phase: json?.boot?.phase ?? null, error: json?.error?.code ?? null, stderr: err.trim().split('\n').pop() ?? ''});
  });
});

const probe = {samples: [], failures: 0, stop: false};
const runProbe = async () => {
  let client = null;
  while (!probe.stop) {
    const started = performance.now();
    try {
      client ??= await RpcClient.connect(socketPath, 3000);
      const result = await client.request('health', {}, 3000);
      probe.samples.push({ms: performance.now() - started, phase: result.boot?.state === 'starting' ? result.boot.phase : 'ready'});
    } catch {
      probe.failures += 1;
      client?.close();
      client = null;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  client?.close();
};
let probeDone = null;

const answers = [];
let failure = null;
try {
  while (!existsSync(socketPath)) {
    if (daemon.exitCode !== null) throw new Error(`daemon exited before binding: ${daemonOutput}`);
    await new Promise(r => setTimeout(r, 20));
  }
  log({event: 'socket_bound', afterLaunchMs: Date.now() - launchedAt});
  probeDone = runProbe();
  for (;;) {
    const pollStarted = Date.now();
    const answer = {sinceLaunchMs: pollStarted - launchedAt, ...(await health())};
    answers.push(answer);
    log({event: 'health', ...answer});
    if (answer.exit === 0) break;
    if (daemon.exitCode !== null) throw new Error(`daemon exited: ${daemonOutput}`);
    if (Date.now() - launchedAt > Number(opt['ready-timeout-ms'])) throw new Error('daemon not ready in time');
    await new Promise(r => setTimeout(r, Math.max(0, pollMs - (Date.now() - pollStarted))));
  }
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  probe.stop = true;
  await probeDone;
  daemon.kill('SIGTERM');
  for (let i = 0; i < 300 && daemon.exitCode === null && daemon.signalCode === null; i++) await new Promise(r => setTimeout(r, 50));
  if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGKILL');
}

const hived = existsSync(join(dir, 'hived.log')) ? readFileSync(join(dir, 'hived.log'), 'utf8') : '';
const phaseLines = hived.split('\n').filter(line => line.includes('"op":"boot.phase')).map(line => JSON.parse(line)).map(({ts, op}) => `${ts - launchedAt}ms ${op}`);
const starting = answers.filter(answer => answer.exit !== 0);
const wrong = starting.filter(answer => answer.exit !== 75 || answer.state !== 'starting');
const byPhase = {};
for (const answer of starting) byPhase[answer.phase ?? `exit${answer.exit}:${answer.error}`] = (byPhase[answer.phase ?? `exit${answer.exit}:${answer.error}`] ?? 0) + 1;
const phaseWindow = (name) => {
  const seen = starting.filter(answer => answer.phase === name);
  return seen.length ? seen[seen.length - 1].sinceLaunchMs - seen[0].sinceLaunchMs : 0;
};
const target = opt.mode === 'migrate' ? 'store_migrate' : 'boot_reconcile';
const startingSamples = probe.samples.filter(sample => sample.phase !== 'ready').map(sample => sample.ms).sort((a, b) => a - b);
const percentile = (q) => startingSamples.length ? Math.round(startingSamples[Math.min(startingSamples.length - 1, Math.floor(q * startingSamples.length))]) : null;
const healthLatency = {samples: startingSamples.length, failures: probe.failures, p50Ms: percentile(0.5), p99Ms: percentile(0.99), maxMs: startingSamples.length ? Math.round(startingSamples.at(-1)) : null};
const verdict = {
  event: 'verdict', mode: opt.mode, sessions, failure, polls: answers.length, startingPolls: starting.length, byPhase,
  wrongAnswers: wrong.length, firstWrong: wrong[0] ?? null, ready: answers.at(-1)?.exit === 0,
  targetPhase: target, targetPhaseObservedMs: phaseWindow(target), readyAfterLaunchMs: answers.at(-1)?.exit === 0 ? answers.at(-1).sinceLaunchMs : null,
  inProcessHealthWhileStarting: healthLatency, phaseLog: phaseLines, pass: failure === null && wrong.length === 0 && answers.at(-1)?.exit === 0 && phaseWindow(target) >= minPhaseMs,
};
log(verdict);
if (opt['cpu-prof'] && existsSync(join(root, 'prof'))) {
  for (const file of readdirSync(join(root, 'prof'))) {
    const profile = JSON.parse(readFileSync(join(root, 'prof', file), 'utf8'));
    const self = new Map();
    const dt = profile.timeDeltas; const byId = new Map(profile.nodes.map(n => [n.id, n]));
    for (let i = 0; i < profile.samples.length; i++) {
      const node = byId.get(profile.samples[i]); const f = node.callFrame;
      const key = `${f.functionName || '(anon)'} ${f.url.split('/').slice(-2).join('/')}:${f.lineNumber + 1}`;
      self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0));
    }
    const children = new Map(profile.nodes.map(n => [n.id, n.children ?? []]));
    const selfUs = new Map();
    for (let i = 0; i < profile.samples.length; i++) selfUs.set(profile.samples[i], (selfUs.get(profile.samples[i]) ?? 0) + (dt[i] ?? 0));
    const total = (id) => (selfUs.get(id) ?? 0) + children.get(id).reduce((sum, child) => sum + total(child), 0);
    const inclusive = new Map();
    const walk = (id, open) => {
      const f = byId.get(id).callFrame; const key = `${f.functionName || '(anon)'} ${f.url.split('/').slice(-2).join('/')}:${f.lineNumber + 1}`;
      const fresh = !open.has(key);
      if (fresh) inclusive.set(key, (inclusive.get(key) ?? 0) + total(id));
      const next = fresh ? new Set([...open, key]) : open;
      for (const child of children.get(id)) walk(child, next);
    };
    walk(profile.nodes[0].id, new Set());
    log({event: 'cpu_inclusive_top', file, top: [...inclusive].filter(([k]) => /daemon\.ts|loops\.ts|store\.ts|cellRetention|loginFlows/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 45).map(([k, us]) => `${Math.round(us / 1000)}ms ${k}`)});
    log({event: 'cpu_self_top', file, top: [...self].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, us]) => `${Math.round(us / 1000)}ms ${k}`)});
  }
}
if (!opt.keep) rmSync(root, {recursive: true, force: true});
else log({event: 'kept', root});
process.exitCode = verdict.pass ? 0 : 1;
