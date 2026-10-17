import cp from 'node:child_process';
import workers from 'node:worker_threads';
import cluster from 'node:cluster';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { realpathSync, statSync, writeSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const encoded = process.env.SCG_EXEC_POLICY;
const policy = JSON.parse(encoded);
const traceFd = Number(process.env.SCG_EXEC_TRACE_FD);
const self = fileURLToPath(import.meta.url);
if (!Number.isSafeInteger(traceFd) || traceFd < 3 || self !== policy.preloader || process.execPath !== policy.node) throw new Error('Unbound gate execution observer');
const emit = record => {
  const bytes = Buffer.from(JSON.stringify({pid: process.pid, parent: process.ppid, ...record}) + '\n');
  if (bytes.length > 4096 || writeSync(traceFd, bytes) !== bytes.length) throw new Error('Gate execution trace incomplete');
};
const refuse = (operation, executable) => { emit({kind: 'refused', operation, executable}); throw new Error('Gate execution boundary refused ' + operation); };
const local = path => path === policy.root || path.startsWith(policy.root + sep);
const files = new Set(policy.files);
const flags = ['--experimental-strip-types', '--no-warnings', '--test'];
const nodeArgs = (args, cwd) => {
  const output = [], entries = [];
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (typeof value !== 'string') refuse('non-string Node argv', policy.node);
    if (value === '--import') {
      if (args[++index] !== self) refuse('unapproved Node preload', policy.node);
      continue;
    }
    if (value === '--import=' + self) continue;
    if (!entries.length && value.startsWith('-')) {
      if (!flags.includes(value) && !['--test-name-pattern=', '--test-reporter=', '--test-concurrency='].some(prefix => value.startsWith(prefix))) refuse('unapproved Node flag', policy.node);
    } else if (!entries.length) {
      const entry = realpathSync(resolve(cwd, value));
      if (!local(entry) || !files.has(entry)) refuse('unpinned Node entry', policy.node);
      entries.push(entry);
    }
    output.push(value);
  }
  if (entries.length !== 1) refuse('missing Node entry', policy.node);
  return {args: ['--import', self, ...output], entry: entries[0]};
};
const prepare = (command, args = [], options = {}) => {
  if (options.shell || !Array.isArray(args)) refuse('shell or ambiguous execution', String(command));
  const cwd = realpathSync(resolve(options.cwd ?? process.cwd()));
  if (!local(cwd)) refuse('execution cwd outside root', String(command));
  const executable = command === 'node' ? policy.node : command === 'sandbox-exec' ? '/usr/bin/sandbox-exec' : realpathSync(String(command));
  let changed, entry;
  if (executable === policy.node) ({args: changed, entry} = nodeArgs(args, cwd));
  else if (executable === '/usr/bin/sandbox-exec') {
    if (!['-p', '-f'].includes(args[0]) || args.length < 4 || realpathSync(args[2]) !== policy.node) refuse('unapproved sandbox recipient', executable);
    const node = nodeArgs(args.slice(3), cwd);
    changed = [...args.slice(0, 3), ...node.args]; entry = node.entry;
  } else refuse('executable outside sibling allowlist', executable);
  let stdio = options.stdio;
  if (typeof stdio === 'string') stdio = [stdio, stdio, stdio];
  if (stdio === undefined) stdio = ['pipe', 'pipe', 'pipe'];
  if (!Array.isArray(stdio)) refuse('ambiguous stdio', executable);
  stdio = [...stdio];
  while (stdio.length < 3) stdio.push('pipe');
  const childFd = stdio.length;
  stdio.push(traceFd);
  const env = {...(options.env ?? process.env), SCG_EXEC_POLICY: encoded, SCG_EXEC_TRACE_FD: String(childFd)};
  emit({kind: 'argv-instrumented', executable, entry, addedFlag: ['--import', self], policySha256: createHash('sha256').update(encoded).digest('hex')});
  return {executable, args: changed, options: {...options, env, stdio}, entry};
};
for (const method of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
  const original = cp[method];
  cp[method] = function(command, args, options, callback) {
    if (!Array.isArray(args)) { callback = options; options = args; args = []; }
    if (typeof options === 'function') { callback = options; options = {}; }
    const prepared = prepare(command, args, options ?? {});
    const result = method === 'execFile' ? original.call(this, prepared.executable, prepared.args, prepared.options, callback) : original.call(this, prepared.executable, prepared.args, prepared.options);
    emit({kind: 'spawn', executable: prepared.executable, entry: prepared.entry, childPid: result?.pid ?? null, expectsNode: true});
    return result;
  };
}
const fork = cp.fork;
cp.fork = function(modulePath, args, options) {
  if (!Array.isArray(args)) { options = args; args = []; }
  options ??= {};
  const prepared = prepare(policy.node, [modulePath, ...args], {...options, stdio: options.stdio ?? ['pipe', 'pipe', 'pipe', 'ipc']});
  const execArgv = [...(options.execArgv ?? process.execArgv)];
  const filtered = [];
  for (let index = 0; index < execArgv.length; index++) {
    if (execArgv[index] === '--import' && execArgv[index + 1] === self) { index++; continue; }
    if (execArgv[index] === '--import=' + self) continue;
    if (!flags.includes(execArgv[index]) && !['--test-name-pattern=', '--test-reporter=', '--test-concurrency='].some(prefix => execArgv[index].startsWith(prefix))) refuse('unapproved fork flag', policy.node);
    filtered.push(execArgv[index]);
  }
  const result = fork.call(this, modulePath, args, {...prepared.options, execPath: policy.node, execArgv: ['--import', self, ...filtered]});
  emit({kind: 'spawn', executable: policy.node, entry: prepared.entry, childPid: result?.pid ?? null, expectsNode: true});
  return result;
};
cp.exec = cp.execSync = () => refuse('shell exec', 'shell');
workers.Worker = class { constructor() { refuse('worker thread', 'worker_threads'); } };
cluster.fork = () => refuse('cluster fork', 'cluster');
const dlopen = process.dlopen;
process.dlopen = function(module, filename, ...rest) {
  const path = realpathSync(String(filename)), proof = policy.native[path];
  if (!proof || !['delivery-file.node', 'peercred.node'].some(name => path.endsWith('/' + name))) refuse('unapproved native module', path);
  const info = statSync(path, {bigint: true});
  if (String(info.ino) !== proof.inode || String(info.mtimeNs) !== proof.mtimeNs || !/^[0-9a-f]{64}$/.test(proof.sha256)) refuse('native artifact metadata mismatch', path);
  emit({kind: 'dlopen', artifact: path, controllerSha256: proof.sha256});
  return dlopen.call(this, module, filename, ...rest);
};
registerHooks({resolve(specifier, context, next) {
  const result = next(specifier, context);
  if (result.url.startsWith('node:')) return result;
  if (!result.url.startsWith('file:')) refuse('non-file module edge', 'module');
  const path = realpathSync(fileURLToPath(result.url));
  if (path !== self && !files.has(path) && !policy.native[path] && !path.startsWith(policy.modules + sep)) refuse('module outside audited closure', path);
  return result;
}});
process.binding = () => refuse('process.binding', 'binding');
syncBuiltinESMExports();
emit({kind: 'hello', executable: process.execPath, preloaderSha256: policy.preloaderSha256});
