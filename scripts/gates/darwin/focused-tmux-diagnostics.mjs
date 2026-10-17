import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {beforeEach, afterEach} from 'node:test';
import {appendFileSync, constants, realpathSync} from 'node:fs';
import {basename, dirname, resolve, sep} from 'node:path';

const destination = process.env.SCG_TMUX_DIAGNOSTIC_FILE;
if (!destination) throw new Error('Missing gate tmux diagnostic destination');
const original = cp.spawnSync;
let current = null;
let sockets = new Set();
let count = 0;
const cut = value => String(value ?? '').slice(-4096);
const emit = row => {
  if (count++ >= 128) return;
  appendFileSync(destination, JSON.stringify({row: current, ...row}) + '\n', {flag: constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW});
};
const capture = (command, socket) => {
  let parent;
  try {parent = realpathSync(dirname(socket));} catch {return;}
  const tmp = realpathSync(process.env.TMPDIR);
  if (parent !== dirname(socket) || !(parent === tmp || parent.startsWith(tmp + sep))) return;
  const options = {encoding: 'utf8', timeout: 2000, maxBuffer: 32768, stdio: ['ignore', 'pipe', 'pipe']};
  const panes = original(command, ['-S', socket, 'list-panes', '-a', '-F', '#{pane_id}'], options);
  emit({kind: 'pane-list', socket, exit: panes.status, error: panes.error?.code ?? null, stderr: cut(panes.stderr)});
  for (const pane of String(panes.stdout ?? '').trim().split('\n').filter(x => /^%\d+$/.test(x)).slice(0, 4)) {
    const result = original(command, ['-S', socket, 'capture-pane', '-p', '-t', pane, '-S', '-80'], options);
    emit({kind: 'terminal-capture', socket, pane, exit: result.status, error: result.error?.code ?? null, stderr: cut(result.stderr), output: cut(result.stdout)});
  }
};
beforeEach(t => {current = t.name; sockets = new Set(); count = 0;});
afterEach(() => {for (const key of sockets) {const [command, socket] = JSON.parse(key); capture(command, socket);} current = null;});
cp.spawnSync = function(command, args, options) {
  if (typeof command !== 'string' || basename(command) !== 'tmux' || !Array.isArray(args)) return Reflect.apply(original, this, arguments);
  const index = args.indexOf('-S');
  const socket = index >= 0 && typeof args[index + 1] === 'string' ? resolve(args[index + 1]) : null;
  const operation = index >= 0 ? args[index + 2] : null;
  if (socket) sockets.add(JSON.stringify([command, socket]));
  if (socket && operation === 'kill-server') capture(command, socket);
  const result = Reflect.apply(original, this, arguments);
  emit({kind: 'tmux-command', socket, operation, exit: result.status, signal: result.signal, error: result.error?.code ?? null, stderr: cut(result.stderr)});
  return result;
};
syncBuiltinESMExports();
