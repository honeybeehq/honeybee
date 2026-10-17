import cp from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import dgram from 'node:dgram';
import dns from 'node:dns';
import http2 from 'node:http2';
import workers from 'node:worker_threads';
import cluster from 'node:cluster';
import modules, { registerHooks, syncBuiltinESMExports } from 'node:module';
import { realpathSync, statSync, lstatSync, fstatSync, writeSync, readSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

const encoded = process.env.SCG_EXEC_POLICY;
const policy = JSON.parse(encoded);
const traceFd = Number(process.env.SCG_EXEC_TRACE_FD);
const self = fileURLToPath(import.meta.url);
if (!Number.isSafeInteger(traceFd) || traceFd < 3 || self !== policy.preloader || process.execPath !== policy.node) throw new Error('Unbound gate execution observer');
const traceTransport = fstatSync(traceFd, {bigint: true});
const traceType = traceTransport.mode & 0o170000n;
if (![0o010000n, 0o140000n].includes(traceType) || String(traceTransport.dev) !== policy.traceTransport?.dev || String(traceTransport.ino) !== policy.traceTransport?.ino || String(traceType) !== policy.traceTransport?.type) throw new Error('Unbound gate trace transport');
let traceSequence = 0;
const emit = record => {
  const bytes = Buffer.from(JSON.stringify({pid: process.pid, parent: process.ppid, emittedAtMs: Date.now(), ...record}) + '\n');
  if (bytes.length > 4096) throw new Error('Gate execution trace incomplete');
  const seq = ++traceSequence, parts = Math.ceil(bytes.length / 192);
  for (let part = 0; part < parts; part++) {
    const frame = Buffer.from(JSON.stringify({pid: process.pid, seq, part, parts, data: bytes.subarray(part * 192, (part + 1) * 192).toString('base64')}) + '\n');
    if (frame.length > 512 || writeSync(traceFd, frame) !== frame.length) throw new Error('Gate execution trace incomplete');
  }
};
const refuse = (operation, executable) => { emit({kind: 'refused', operation, executable}); throw new Error('Gate execution boundary refused ' + operation); };
const requestFd = Number(process.env.SCG_REQUEST_FD), responseFd = Number(process.env.SCG_RESPONSE_FD), lockReadFd = Number(process.env.SCG_REQUEST_LOCK_READ_FD), lockWriteFd = Number(process.env.SCG_REQUEST_LOCK_WRITE_FD);
let requestSequence = 0;
const request = payload => {
  if (!policy.mediationRequired || !Number.isInteger(requestFd) || !Number.isInteger(responseFd) || requestFd < 3 || responseFd < 3) refuse('controller mediation unavailable', 'controller');
  const token = Buffer.alloc(1);
  if (readSync(lockReadFd, token, 0, 1, null) !== 1 || token[0] !== 49) refuse('controller request lock unavailable', 'controller');
  try {
    const id = ++requestSequence;
    const bytes = Buffer.from(JSON.stringify({pid: process.pid, id, ...payload}) + '\n');
    if (bytes.length > 4096 || writeSync(requestFd, bytes) !== bytes.length) refuse('controller request incomplete', 'controller');
    const byte = Buffer.alloc(1), chunks = [];
    for (let length = 0; length < 4096; length++) {
      if (readSync(responseFd, byte, 0, 1, null) !== 1) refuse('controller response missing', 'controller');
      if (byte[0] === 10) {
        const response = JSON.parse(Buffer.concat(chunks).toString());
        if (response.pid !== process.pid || response.id !== id || response.allowed !== true) refuse('controller mediation refused', 'controller');
        return response;
      }
      chunks.push(Buffer.from(byte));
    }
    refuse('controller response exceeded bound', 'controller');
  } finally {
    if (writeSync(lockWriteFd, token) !== 1) refuse('controller request lock lost', 'controller');
  }
};
const local = path => path === policy.root || path.startsWith(policy.root + sep);
const files = new Set(policy.files);
const roleRules = {'test-runner': null, 'runner-host-main': 'test-runner', 'reader': 'sandbox-exec'};
const ownEntry = process.argv[1] ? realpathSync(resolve(process.argv[1])) : null;
const ownRole = policy.entries[ownEntry]?.role;
const parentRole = process.env.SCG_EXEC_PARENT_ROLE ?? null;
if (!(ownRole in roleRules) || (ownRole === 'test-runner' ? parentRole !== null : ownRole === 'reader' ? process.env.SCG_EXEC_RECIPIENT !== '1' || parentRole !== 'runner-host-main' : parentRole !== roleRules[ownRole] || process.env.SCG_EXEC_RECIPIENT === '1')) refuse('Node entry parent role mismatch', policy.node);
let launchSequence = 0;
const pendingLaunches = new Map();
const flags = ['--experimental-strip-types', '--no-warnings'];
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
      if (!flags.includes(value)) refuse('unapproved Node flag', policy.node);
    } else if (!entries.length) {
      const target = resolve(cwd, value);
      if (!local(target)) refuse('Node entry outside root', policy.node);
      const entry = realpathSync(target);
      if (!local(entry) || !files.has(entry) || !policy.entries[entry]) refuse('unpinned Node entry', policy.node);
      if (policy.forbiddenEntries.includes(entry)) refuse('build entry forbidden in test process', policy.node);
      entries.push(entry);
    }
    output.push(value);
  }
  if (entries.length !== 1) refuse('missing Node entry', policy.node);
  const entryIndex = output.findIndex(value => !value.startsWith('-'));
  const argumentsAfterEntry = output.slice(entryIndex + 1);
  const role = policy.entries[entries[0]].role;
  if (role === 'reader' && argumentsAfterEntry.length || role === 'runner-host-main' && argumentsAfterEntry.length > 1) refuse('unapproved Node entry arguments', policy.node);
  for (const value of argumentsAfterEntry) if (!local(resolve(cwd, value)) || !local(realpathSync(resolve(cwd, value)))) refuse('Node argument path outside sealed root', policy.node);
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
    if (policy.mediationRequired) {
      if (args[0] !== '-f') refuse('production recipient requires -f profile', executable);
      const profile = resolve(cwd, args[1]);
      if (options.env?.FILE_READ_ROOT !== resolve(dirname(dirname(profile)), 'data')) refuse('reader root differs from declared fixture', executable);
      request({operation: 'profile', rowId: policy.rowId, fixtureRoot: dirname(dirname(profile)), profile, node: policy.node, entry, cwd});
    }
  } else refuse('executable outside sibling allowlist', executable);
  const childRole = policy.entries[entry]?.role;
  if (executable === '/usr/bin/sandbox-exec' ? childRole !== 'reader' : childRole !== 'runner-host-main' || ownRole !== 'test-runner') refuse('Node entry parent role mismatch', executable);
  let stdio = options.stdio;
  if (typeof stdio === 'string') stdio = [stdio, stdio, stdio];
  if (stdio === undefined) stdio = ['pipe', 'pipe', 'pipe'];
  if (!Array.isArray(stdio)) refuse('ambiguous stdio', executable);
  stdio = [...stdio];
  while (stdio.length < 3) stdio.push('pipe');
  const childFd = stdio.length;
  stdio.push(traceFd);
  const descriptorBindings = [{index: childFd, value: traceFd}];
  let childRequestFd, childResponseFd, childLockReadFd, childLockWriteFd;
  if (policy.mediationRequired) {
    childRequestFd = stdio.length; stdio.push(requestFd);
    childResponseFd = stdio.length; stdio.push(responseFd);
    childLockReadFd = stdio.length; stdio.push(lockReadFd);
    childLockWriteFd = stdio.length; stdio.push(lockWriteFd);
    descriptorBindings.push({index: childRequestFd, value: requestFd}, {index: childResponseFd, value: responseFd}, {index: childLockReadFd, value: lockReadFd}, {index: childLockWriteFd, value: lockWriteFd});
  }
  const launchId = process.pid + ':' + (++launchSequence);
  const env = {...(options.env ?? process.env), SCG_EXEC_POLICY: encoded, SCG_EXEC_TRACE_FD: String(childFd), SCG_EXEC_LAUNCH_ID: launchId, SCG_EXEC_PARENT_ROLE: ownRole, SCG_EXEC_RECIPIENT: executable === '/usr/bin/sandbox-exec' ? '1' : '0'};
  if (policy.mediationRequired) { env.SCG_REQUEST_FD = String(childRequestFd); env.SCG_RESPONSE_FD = String(childResponseFd); env.SCG_REQUEST_LOCK_READ_FD = String(childLockReadFd); env.SCG_REQUEST_LOCK_WRITE_FD = String(childLockWriteFd); }
  const recordedArgv = changed.map(value => value.length <= 256 ? value : {sha256: createHash('sha256').update(value).digest('hex'), bytes: Buffer.byteLength(value)});
  emit({kind: 'argv-instrumented', executable, entry, launchId, argv: [executable, ...recordedArgv], addedFlag: ['--import', self], policySha256: createHash('sha256').update(encoded).digest('hex')});
  pendingLaunches.set(launchId, {executable, childFd, descriptorBindings});
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
  for (const binding of launch.descriptorBindings) {
    while (stdio.length < binding.index) stdio.push('pipe');
    if (stdio[binding.index] !== undefined && stdio[binding.index] !== binding.value) refuse('observer fd collision', launch.executable);
    stdio[binding.index] = binding.value;
  }
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
    emit({kind: 'spawn', executable: prepared.executable, entry: prepared.entry, launchId: prepared.launchId, childPid: result?.pid ?? null, expectsNode: true});
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
    if (!flags.includes(execArgv[index])) refuse('unapproved fork flag', policy.node);
    filtered.push(execArgv[index]);
  }
  let result;
  try { result = fork.call(this, modulePath, args, {...prepared.options, execPath: policy.node, execArgv: ['--import', self, ...filtered]}); }
  finally { pendingLaunches.delete(prepared.launchId); }
  emit({kind: 'spawn', executable: policy.node, entry: prepared.entry, launchId: prepared.launchId, childPid: result?.pid ?? null, expectsNode: true});
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
const normalizeNetArgs = net._normalizeArgs;
if (typeof normalizeNetArgs !== 'function') refuse('Node Unix argument normalization unavailable', 'network');
const normalizedSymbol = Object.getOwnPropertySymbols(normalizeNetArgs([{path: policy.root + '/probe'}])).find(symbol => normalizeNetArgs([{path: policy.root + '/probe'}])[symbol] === true);
if (!normalizedSymbol) refuse('Node Unix argument normalization unavailable', 'network');
const unixOnly = args => {
  const normalized = Array.isArray(args[0]) && args[0][normalizedSymbol] ? args[0] : normalizeNetArgs(args);
  const first = normalized[0];
  const path = first && typeof first === 'object' && Reflect.ownKeys(first).every(key => key === 'path') && typeof first.path === 'string' ? first.path : null;
  if (!path || !local(resolve(path)) || !local(realpathSync(dirname(resolve(path))))) refuse('IP network operation', 'network');
  try {
    const info = lstatSync(resolve(path));
    if (info.isSymbolicLink() || realpathSync(resolve(path)) !== resolve(path)) refuse('redirected Unix socket path', 'network');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
};
for (const [owner, method] of [[net.Socket.prototype, 'connect'], [net.Server.prototype, 'listen']]) {
  const original = owner[method];
  owner[method] = function(...args) { unixOnly(args); return original.apply(this, args); };
}
for (const [owner, names] of [[http, ['request', 'get']], [https, ['request', 'get']], [tls, ['connect']], [http2, ['connect']], [dgram, ['createSocket']]]) {
  for (const name of names) owner[name] = () => refuse('IP network operation', 'network');
}
for (const owner of [dns, dns.promises]) {
  for (const name of Object.keys(owner)) if (typeof owner[name] === 'function') owner[name] = () => refuse('DNS operation', 'network');
}
globalThis.fetch = () => refuse('fetch', 'network');
globalThis.WebSocket = class { constructor() { refuse('WebSocket', 'network'); } };
process.kill = function(pid, signal = 'SIGTERM') {
  if (!Number.isInteger(pid) || pid === 0 || pid === -1) refuse('non-descendant signal target', 'signal');
  request({operation: 'signal', target: pid, signal});
  return true;
};
cp.ChildProcess.prototype.kill = function(signal = 'SIGTERM') {
  if (!Number.isInteger(this.pid) || this.pid <= 1) refuse('non-descendant signal target', 'signal');
  request({operation: 'signal', target: this.pid, signal});
  this.killed = true;
  return true;
};
process.binding = () => refuse('process.binding', 'binding');
if (typeof process.execve === 'function') process.execve = () => refuse('process.execve', 'execve');
modules.register = modules.registerHooks = () => refuse('module hook replacement', 'module');
syncBuiltinESMExports();
emit({kind: 'hello', entry: ownEntry, role: ownRole, emittedAtMs: Date.now(), executable: process.execPath, preloaderSha256: policy.preloaderSha256, launchId: process.env.SCG_EXEC_LAUNCH_ID ?? null});
