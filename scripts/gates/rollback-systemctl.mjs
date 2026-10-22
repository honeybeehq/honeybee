import { spawn } from "node:child_process";
import { appendFileSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const root = process.env.HIVE_TEST_ROLLBACK_ROOT;
if (!root || !basename(resolve(root)).startsWith('hb-rollback-') || !existsSync(join(root, 'ROLLBACK_FIXTURE'))) throw new Error('fixture root required');
const label = process.env.HIVE_V2_SERVICE_LABEL;
if (label !== 'honeybee.rollback.fixture') throw new Error('fixture label required');
const args = process.argv.slice(2);
if (args[0] !== '--user') throw new Error('only fixture user services supported');
const verb = args[1];
if (!['daemon-reload', 'start', 'stop', 'show', 'is-active'].includes(verb)) throw new Error('unsupported fixture service operation');
if (verb !== 'daemon-reload' && args[2] !== `${label}.service`) throw new Error('foreign service refused');
appendFileSync(join(root, 'systemctl.jsonl'), JSON.stringify(args) + '\n');
const stateFile = join(root, 'process.json');
const birth = pid => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    return stat[0] === 'Z' ? null : stat[19];
  } catch { return null; }
};
const saved = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null;
const live = () => saved && birth(saved.pid) === saved.birth;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
if (verb === 'daemon-reload') process.exit(0);
if (verb === 'show') {
  console.log(`ActiveState=${live() ? 'active' : 'inactive'}\nMainPID=${live() ? saved.pid : 0}`);
} else if (verb === 'is-active') {
  console.log(live() ? 'active' : 'inactive');
  process.exitCode = live() ? 0 : 3;
} else if (verb === 'stop') {
  if (live()) {
    process.kill(saved.pid, 'SIGTERM');
    const until = Date.now() + 5000;
    while (live() && Date.now() < until) await sleep(20);
    if (live()) throw new Error('fixture daemon did not stop');
  }
} else {
  if (live()) throw new Error('fixture already running');
  const unit = readFileSync(join(process.env.HIVE_V2_SERVICE_DIR, `${label}.service`), 'utf8');
  const tokens = line => [...line.matchAll(/"(?:\\.|[^"\\])*"/g)].map(x => JSON.parse(x[0]));
  const argv = tokens(unit.split('\n').find(line => line.startsWith('ExecStart=')));
  if (!argv.includes(join(root, 'runtime', 'current', 'dist', 'cli.js')) || !argv.includes(join(root, 'v2'))) throw new Error('foreign command refused');
  const env = { ...process.env };
  for (const line of unit.split('\n').filter(line => line.startsWith('Environment='))) {
    const [value] = tokens(line), split = value.indexOf('=');
    env[value.slice(0, split)] = value.slice(split + 1);
  }
  const log = join(root, `daemon-${Date.now()}.log`), fd = openSync(log, 'a');
  const child = spawn(argv[0], argv.slice(1), { env, detached: true, stdio: ['ignore', fd, fd] });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  writeFileSync(stateFile, JSON.stringify({ pid: child.pid, birth: birth(child.pid), log }));
  child.unref();
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    if (child.exitCode !== null || !birth(child.pid)) {
      process.stderr.write(readFileSync(log, 'utf8'));
      process.exit(1);
    }
    if (readFileSync(log, 'utf8').includes('hived v2 listening')) process.exit(0);
    await sleep(20);
  }
  throw new Error(`fixture boot timeout; see ${log}`);
}
