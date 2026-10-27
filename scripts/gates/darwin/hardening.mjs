import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function inside(candidate, root, platform = process.platform) {
  if (platform === 'darwin') { candidate = candidate.toLowerCase(); root = root.toLowerCase(); }
  return candidate === root || candidate.startsWith(root + path.sep);
}

export function labHost(host, utc) {
  host = host.split('.')[0];
  if (host === 'trmd-fangorn-mini07') return;
  if (host !== 'trmd-hobbiton-mini04') throw new Error('REFUSED: approved Mac lab required');
  if (!/^[0-9]{4}$/.test(utc) || Number(utc.slice(0, 2)) > 23 || Number(utc.slice(2)) > 59) throw new Error('REFUSED: invalid UTC time');
  if (utc >= '0300' && utc <= '0440') throw new Error('REFUSED: mini04 quiet window');
}

export function writable(candidate, root, realHome) {
  if (![candidate, root, realHome].every(path.isAbsolute)) throw new Error('absolute paths required');
  const target = path.resolve(candidate);
  const home = path.resolve(realHome);
  const run = path.resolve(root);
  if (inside(target, home) || inside(run, home) || !inside(target, run)) throw new Error('REFUSED: write outside isolated run root');
  return target;
}

export function write(candidate, value, root, realHome) {
  const target = writable(candidate, root, realHome);
  const relative = path.relative(root, target).split(path.sep);
  let current = root;
  for (const component of relative.slice(0, -1)) {
    current = path.join(current, component);
    if (!fs.lstatSync(current).isDirectory() || fs.lstatSync(current).isSymbolicLink()) throw new Error('REFUSED: redirected write parent');
  }
  const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, value); } finally { fs.closeSync(fd); }
}

export function launchAgents(home) {
  const directory = path.join(home, 'Library', 'LaunchAgents');
  for (const candidate of [home, path.join(home, 'Library'), directory]) {
    if (!fs.existsSync(candidate)) return {};
    if (fs.lstatSync(candidate).isSymbolicLink() || !fs.lstatSync(candidate).isDirectory()) throw new Error('REFUSED: redirected LaunchAgents');
  }
  return Object.fromEntries(fs.readdirSync(directory).sort().map(name => {
    const fd = fs.openSync(path.join(directory, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      if (!fs.fstatSync(fd).isFile()) throw new Error('REFUSED: non-file LaunchAgents entry');
      return [name, createHash('sha256').update(fs.readFileSync(fd)).digest('hex')];
    } finally { fs.closeSync(fd); }
  }));
}

export function profile(root, realHome) {
  return `(version 1)(allow default)(deny network*)(deny mach-lookup)(deny file-write*)(allow file-write* (subpath ${JSON.stringify(root)}))(deny file-read* (subpath ${JSON.stringify(realHome)}) (subpath "/Library/Keychains") (subpath "/private/var/db/Keychains"))(deny process-exec (literal "/usr/bin/security"))`;
}

function selfTest(root, realHome, source) {
  if (process.platform !== 'darwin') throw new Error('Darwin required');
  const now = new Date();
  labHost(os.hostname(), String(now.getUTCHours()).padStart(2, '0') + String(now.getUTCMinutes()).padStart(2, '0'));
  if (realHome !== os.userInfo().homedir) throw new Error('passwd home mismatch');
  if ([process.cwd(), fileURLToPath(import.meta.url)].some(candidate => inside(path.resolve(candidate), realHome))) throw new Error('REFUSED: checkout or script under real home');
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('REFUSED: Node 24 or newer required');
  if (!/^[a-f0-9]{40}$/.test(source)) throw new Error('REFUSED: exact source SHA required');
  const checkout = fileURLToPath(new URL('../../../', import.meta.url));
  const gitDir = path.join(checkout, '.git');
  if (!fs.lstatSync(gitDir).isDirectory() || fs.lstatSync(gitDir).isSymbolicLink() || fs.existsSync(path.join(gitDir, 'objects/info/alternates'))) throw new Error('REFUSED: independent checkout required');
  const git = args => {
    const result = spawnSync('/usr/bin/git', ['--no-optional-locks', '-C', checkout, ...args], { env: { PATH: '/usr/bin:/bin', HOME: '/private/var/tmp', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, encoding: 'utf8', timeout: 15000 });
    if (result.error || result.status !== 0) throw new Error('REFUSED: local source verification failed');
    return result.stdout.trim();
  };
  if (git(['rev-parse', 'HEAD']) !== source || git(['status', '--porcelain', '--', 'scripts/gates/darwin'])) throw new Error('REFUSED: source SHA mismatch or dirty gate');
  if (!path.isAbsolute(root) || path.dirname(root) !== '/private/var/tmp' || !path.basename(root).startsWith('hb-gate.')) throw new Error('unsafe run root');
  writable(root, root, realHome);
  if (fs.realpathSync(root) !== root || fs.lstatSync(root).isSymbolicLink() || (fs.statSync(root).mode & 0o777) !== 0o700) throw new Error('unsafe run directory');
  const rows = [];
  for (const target of [realHome, path.join(realHome, 'Library'), path.join(realHome, 'Library', 'LaunchAgents', 'refused'), path.join(realHome, '.hive', 'refused'), path.join(root, '..', 'escape')]) {
    let refused = false;
    try { write(target, 'must never land', root, realHome); } catch (error) {
      if (!error.message.startsWith('REFUSED: write outside isolated run root')) throw error;
      refused = true;
      rows.push({ target, refusedBeforeFilesystem: true, message: error.message });
    }
    if (!refused) throw new Error('guard permitted protected write');
  }
  const sandbox = path.join(root, 'sandbox');
  const fixture = path.join(root, 'outside-fixture');
  for (const directory of [sandbox, fixture, path.join(sandbox, 'home'), path.join(sandbox, 'tmp'), path.join(sandbox, 'cache')]) fs.mkdirSync(directory, { mode: 0o700 });
  const childSource = `const fs=require('node:fs');fs.writeFileSync(process.argv[1]+'/allowed','inside');try{fs.writeFileSync(process.argv[2]+'/denied','outside');process.exit(2)}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e;console.log(JSON.stringify({code:e.code,errno:e.errno,message:e.message,syscall:e.syscall}))}`;
  const child = spawnSync('/usr/bin/sandbox-exec', ['-p', profile(sandbox, realHome), process.execPath, '-e', childSource, sandbox, fixture], {
    env: { PATH: '/usr/bin:/bin', HOME: path.join(sandbox, 'home'), TMPDIR: path.join(sandbox, 'tmp'), XDG_CACHE_HOME: path.join(sandbox, 'cache'), NODE_COMPILE_CACHE: path.join(sandbox, 'cache'), npm_config_cache: path.join(sandbox, 'cache'), PNPM_STORE_DIR: path.join(sandbox, 'cache'), CLANG_MODULE_CACHE_PATH: path.join(sandbox, 'cache') },
    cwd: sandbox, encoding: 'utf8', timeout: 15000,
  });
  if (child.error || child.status !== 0 || fs.existsSync(path.join(fixture, 'denied')) || fs.readFileSync(path.join(sandbox, 'allowed'), 'utf8') !== 'inside') throw new Error('Seatbelt self-test failed: ' + (child.error?.message ?? child.stderr));
  rows.push({ seatbelt: JSON.parse(child.stdout), outsideFixture: fixture });
  const fixtureHome = path.join(root, 'sentinel-home');
  fs.mkdirSync(path.join(fixtureHome, 'Library', 'LaunchAgents'), { recursive: true, mode: 0o700 });
  write(path.join(fixtureHome, 'Library', 'LaunchAgents', 'fixture.plist'), 'owned sentinel', root, realHome);
  const before = launchAgents(fixtureHome);
  write(path.join(fixtureHome, 'Library', 'ignored'), 'outside sentinel scope', root, realHome);
  if (JSON.stringify(before) !== JSON.stringify(launchAgents(fixtureHome))) throw new Error('sentinel exceeded LaunchAgents scope');
  rows.push({ sentinel: before, scope: 'fixture LaunchAgents names and SHA256 only' });
  fs.rmdirSync(fixture);
  const receipt = JSON.stringify({ ok: true, source, node: process.versions.node, root, policyAssertions: { realHome: 'computed-path refusal; no real-home filesystem probe', network: 'deny network* policy; no network operations attempted; Darwin inbound isolation is not established', keychain: 'no access requested; policy denies Keychain paths and Mach lookup' }, cache: path.join(sandbox, 'cache'), rows }, null, 2) + '\n';
  write(path.join(root, 'receipt.json'), receipt, root, realHome);
  const hashes = {};
  for (const name of ['hardening.mjs', 'hardening-self-test.sh', 'hardening.test.mjs']) hashes[name] = createHash('sha256').update(fs.readFileSync(new URL(name, import.meta.url))).digest('hex');
  hashes['receipt.json'] = createHash('sha256').update(receipt).digest('hex');
  const manifest = JSON.stringify(hashes, null, 2) + '\n';
  write(path.join(root, 'SHA256SUMS.json'), manifest, root, realHome);
  console.log(receipt.trim());
  console.log('GATE_MANIFEST=' + manifest.trim());
  console.log('GATE_ROOT=' + root);
  console.log('GATE_RECEIPT_SHA256=' + createHash('sha256').update(manifest).digest('hex'));
  const identity = fs.lstatSync(root);
  if (!root.startsWith('/private/var/tmp/hb-gate.') || !identity.isDirectory() || identity.isSymbolicLink() || identity.uid !== process.getuid() || (identity.mode & 0o777) !== 0o700) throw new Error('REFUSED: cleanup root identity');
  fs.rmSync(root, { recursive: true });
  console.log('GATE_RESULT=PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 6 || process.argv[2] !== '--self-test') throw new Error('only --self-test <root> <passwd-home> <source-sha> is supported');
    selfTest(process.argv[3], process.argv[4], process.argv[5]);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
