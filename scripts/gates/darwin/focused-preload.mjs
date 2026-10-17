import cp from 'node:child_process';
import workers from 'node:worker_threads';
import cluster from 'node:cluster';
import modules, { registerHooks, syncBuiltinESMExports } from 'node:module';
import { realpathSync, statSync, writeSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

const encoded = process.env.SCG_EXEC_POLICY;
const policy = JSON.parse(encoded);
const traceFd = Number(process.env.SCG_EXEC_TRACE_FD);
const self = fileURLToPath(import.meta.url);
if (!Number.isSafeInteger(traceFd) || traceFd < 3 || self !== policy.preloader || process.execPath !== policy.node) throw new Error('Unbound gate execution observer');
let traceSequence = 0;
const emit = record => {
  const bytes = Buffer.from(JSON.stringify({pid: process.pid, parent: process.ppid, ...record}) + '\n');
  if (bytes.length > 4096) throw new Error('Gate execution trace incomplete');
  const seq = ++traceSequence, parts = Math.ceil(bytes.length / 192);
  // Stay below POSIX's minimum PIPE_BUF (512), including on Darwin. Records
  // from several descendants may interleave, but individual frames cannot.
  for (let part = 0; part < parts; part++) {
    const frame = Buffer.from(JSON.stringify({pid: process.pid, seq, part, parts, data: bytes.subarray(part * 192, (part + 1) * 192).toString('base64')}) + '\n');
    if (frame.length > 512 || writeSync(traceFd, frame) !== frame.length) throw new Error('Gate execution trace incomplete');
  }
};
const refuse = (operation, executable) => { emit({kind: 'refused', operation, executable}); throw new Error('Gate execution boundary refused ' + operation); };
const local = path => path === policy.root || path.startsWith(policy.root + sep);
const files = new Set(policy.files);
let launchSequence = 0;
const pendingLaunches = new Map();
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
      const target = resolve(cwd, value);
      if (!local(target)) refuse('Node entry outside root', policy.node);
      const entry = realpathSync(target);
      if (!local(entry) || !files.has(entry)) refuse('unpinned Node entry', policy.node);
      if (policy.forbiddenEntries.includes(entry)) refuse('build entry forbidden in test process', policy.node);
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
  if (options.env?.NODE_OPTIONS) refuse('unapproved NODE_OPTIONS', 'node');
  const executable = command === 'node' || command === policy.node ? policy.node : command === 'sandbox-exec' || command === '/usr/bin/sandbox-exec' ? '/usr/bin/sandbox-exec' : null;
  if (executable === null) refuse('executable outside sibling allowlist', typeof command === 'string' && /^[A-Za-z0-9_./-]+$/.test(command) ? command : '<invalid>');
  let changed, entry;
  if (executable === policy.node) ({args: changed, entry} = nodeArgs(args, cwd));
  else if (executable === '/usr/bin/sandbox-exec') {
    if (!['-p', '-f'].includes(args[0]) || args.length < 4 || args[2] !== policy.node) refuse('unapproved sandbox recipient', executable);
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
  const launchId = process.pid + ':' + (++launchSequence);
  const env = {...(options.env ?? process.env), SCG_EXEC_POLICY: encoded, SCG_EXEC_TRACE_FD: String(childFd), SCG_EXEC_LAUNCH_ID: launchId};
  const recordedArgv = changed.map(value => value.length <= 256 ? value : {sha256: createHash('sha256').update(value).digest('hex'), bytes: Buffer.byteLength(value)});
  emit({kind: 'argv-instrumented', executable, entry, launchId, argv: [executable, ...recordedArgv], addedFlag: ['--import', self], policySha256: createHash('sha256').update(encoded).digest('hex')});
  pendingLaunches.set(launchId, {executable, childFd});
  return {executable, args: changed, options: {...options, env, stdio}, entry, launchId};
};
const nativeSpawn = cp.ChildProcess.prototype.spawn;
cp.ChildProcess.prototype.spawn = function(options) {
  const id = options.envPairs?.find(value => value.startsWith('SCG_EXEC_LAUNCH_ID='))?.slice('SCG_EXEC_LAUNCH_ID='.length);
  const launch = pendingLaunches.get(id);
  if (!launch || options.file !== launch.executable) refuse('unprepared low-level spawn', String(options.file));
  let stdio = options.stdio ?? ['pipe', 'pipe', 'pipe'];
  if (typeof stdio === 'string') stdio = [stdio, stdio, stdio];
  if (!Array.isArray(stdio)) refuse('unprepared low-level stdio', launch.executable);
  stdio = [...stdio];
  // execFile drops the public stdio option. Append the approved observer fd
  // here without changing its default stdin/stdout/stderr pipes or callbacks.
  while (stdio.length < launch.childFd) stdio.push('pipe');
  if (stdio[launch.childFd] !== undefined && stdio[launch.childFd] !== traceFd) refuse('trace fd collision', launch.executable);
  stdio[launch.childFd] = traceFd;
  pendingLaunches.delete(id);
  return nativeSpawn.call(this, {...options, stdio});
};
for (const method of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
  const original = cp[method];
  cp[method] = function(command, args, options, callback) {
    if (!Array.isArray(args)) { callback = options; options = args; args = []; }
    if (typeof options === 'function') { callback = options; options = {}; }
    const prepared = prepare(command, args, options ?? {});
    let result;
    try { result = method === 'execFile' ? original.call(this, prepared.executable, prepared.args, prepared.options, callback) : original.call(this, prepared.executable, prepared.args, prepared.options); }
    finally { pendingLaunches.delete(prepared.launchId); }
    emit({kind: 'spawn', executable: prepared.executable, entry: prepared.entry, childPid: result?.pid ?? null, expectsNode: true});
    return result;
  };
}
cp.execFile[promisify.custom] = function(...args) {
  let child;
  const promise = new Promise((resolve, reject) => {
    child = cp.execFile(...args, (error, stdout, stderr) => {
      if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
      else resolve({stdout, stderr});
    });
  });
  promise.child = child;
  return promise;
};
const fork = cp.fork;
cp.fork = function(modulePath, args, options) {
  if (!Array.isArray(args)) { options = args; args = []; }
  options ??= {};
  if (options.execPath && options.execPath !== policy.node) refuse('unapproved fork executable', options.execPath);
  const defaultStdio = options.silent ? ['pipe', 'pipe', 'pipe', 'ipc'] : ['inherit', 'inherit', 'inherit', 'ipc'];
  const prepared = prepare(policy.node, [modulePath, ...args], {...options, stdio: options.stdio ?? defaultStdio});
  const execArgv = [...(options.execArgv ?? process.execArgv)];
  const filtered = [];
  for (let index = 0; index < execArgv.length; index++) {
    if (execArgv[index] === '--import' && execArgv[index + 1] === self) { index++; continue; }
    if (execArgv[index] === '--import=' + self) continue;
    if (!flags.includes(execArgv[index]) && !['--test-name-pattern=', '--test-reporter=', '--test-concurrency='].some(prefix => execArgv[index].startsWith(prefix))) refuse('unapproved fork flag', policy.node);
    filtered.push(execArgv[index]);
  }
  let result;
  try { result = fork.call(this, modulePath, args, {...prepared.options, execPath: policy.node, execArgv: ['--import', self, ...filtered]}); }
  finally { pendingLaunches.delete(prepared.launchId); }
  emit({kind: 'spawn', executable: policy.node, entry: prepared.entry, childPid: result?.pid ?? null, expectsNode: true});
  return result;
};
cp.exec = cp.execSync = () => refuse('shell exec', 'shell');
workers.Worker = class { constructor() { refuse('worker thread', 'worker_threads'); } };
cluster.fork = () => refuse('cluster fork', 'cluster');
const dlopen = process.dlopen;
process.dlopen = function(module, filename, ...rest) {
  let path;
  if (typeof filename !== 'string' || !local(resolve(filename))) refuse('native module outside root', '<outside-root>');
  try { path = realpathSync(String(filename)); } catch { refuse('unapproved native module', '<unresolved>'); }
  const proof = policy.native[path];
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
if (typeof process.execve === 'function') process.execve = () => refuse('process.execve', 'execve');
modules.register = modules.registerHooks = () => refuse('module hook replacement', 'module');
syncBuiltinESMExports();
emit({kind: 'hello', executable: process.execPath, preloaderSha256: policy.preloaderSha256, launchId: process.env.SCG_EXEC_LAUNCH_ID ?? null});
