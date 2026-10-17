import {createHash} from 'node:crypto';
import {constants as osConstants} from 'node:os';
import {basename, dirname, resolve, sep} from 'node:path';

const stderrPatterns = [
  ['forkpty_failed', /forkpty.*(?:fail|error)/i],
  ['posix_openpt_failed', /posix_openpt.*(?:fail|error)/i],
  ['operation_not_permitted', /operation not permitted/i],
  ['permission_denied', /permission denied/i],
  ['not_a_terminal', /not a terminal/i],
  ['no_server_running', /no server running/i],
  ['server_exited_unexpectedly', /server exited unexpectedly/i],
  ['error_connecting', /error connecting/i],
  ['socket_path', /(?:socket.*(?:path|too long)|path.*socket)/i],
  ['create_window_failed', /(?:create window failed|create window.*fail)/i],
];
const markers = {phoneTerminalReady: 'phone terminal ready', received: 'received', pointer: 'full text: '};
const codes = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EMFILE', 'ENFILE', 'EINVAL', 'EIO', 'ENOMEM', 'ETIMEDOUT', 'ENOBUFS', 'EPIPE']);
const operations = new Set(['new-session', 'new-window', 'kill-server', 'kill-session', 'kill-pane', 'list-panes', 'list-sessions', 'capture-pane', 'display-message', 'show-options', 'set-option', 'set-options', 'send-keys', 'load-buffer', 'paste-buffer', 'delete-buffer', 'resize-pane', 'select-pane', 'has-session']);
const bytes = value => Buffer.isBuffer(value) ? value : Buffer.from(value == null ? '' : String(value));
const summary = value => {const raw = bytes(value); return {byteCount: raw.length, sha256: createHash('sha256').update(raw).digest('hex')};};
export function stderrSummary(value) {
  const raw = bytes(value);
  const text = raw.toString('utf8');
  const classes = stderrPatterns.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  return {...summary(raw), classes: raw.length ? (classes.length ? classes : ['other_nonempty']) : ['empty']};
}
export function paneSummary(value) {
  const raw = bytes(value);
  const text = raw.toString('utf8');
  return {...summary(raw), lineCount: raw.length ? (text.match(/\n/g)?.length ?? 0) + (text.endsWith('\n') ? 0 : 1) : 0, markers: Object.fromEntries(Object.entries(markers).map(([name, marker]) => [name, text.includes(marker)]))};
}
const status = result => ({exit: Number.isInteger(result.status) ? result.status : null, signal: Number.isInteger(result.signal) ? result.signal : osConstants.signals[result.signal] ?? null, error: result.error ? (codes.has(result.error.code) ? result.error.code : 'OTHER') : null, stderr: stderrSummary(result.stderr)});

export function createObserver({original, append, realpath, tmpdir, reportFailure}) {
  let current = null, count = 0, failure = null;
  let sockets = new Map();
  const fail = (step, error) => {
    if (failure !== null) return;
    failure = step === 'append' ? ({EACCES: 'append_eacces', ENOSPC: 'append_enospc', EMFILE: 'append_emfile'}[error?.code] ?? 'append_other') : ({realpath: 'realpath_failed', capture: 'capture_failed', emit: 'emit_failed', metadata: 'metadata_failed', hook: 'hook_failed'}[step] ?? 'diagnostic_failed');
    try {reportFailure(failure);} catch {}
  };
  const emit = value => {
    try {
      if (count++ >= 128 || current === null) return;
      const line = JSON.stringify({row: current, ...value, diagnosticFailure: failure}) + '\n';
      try {append(line);} catch (error) {fail('append', error);}
    } catch (error) {fail('emit', error);}
  };
  const capture = (command, socket) => {
    try {
      let parent, tmp;
      try {parent = realpath(dirname(socket)); tmp = realpath(tmpdir);} catch (error) {fail('realpath', error); return;}
      if (parent !== dirname(socket) || !(parent === tmp || parent.startsWith(tmp + sep))) return;
      const options = {encoding: 'buffer', timeout: 2000, maxBuffer: 32768, stdio: ['ignore', 'pipe', 'pipe']};
      const panes = original(command, ['-S', socket, 'list-panes', '-a', '-F', '#{pane_id}'], options);
      emit({kind: 'pane-list', ...status(panes)});
      for (const pane of bytes(panes.stdout).toString('utf8').trim().split('\n').filter(x => /^%\d+$/.test(x)).slice(0, 4)) {
        const result = original(command, ['-S', socket, 'capture-pane', '-p', '-t', pane, '-S', '-80'], options);
        emit({kind: 'terminal-capture', ...status(result), pane: paneSummary(result.stdout)});
      }
    } catch (error) {fail('capture', error);}
  };
  return {
    before(name) {try {current = name; count = 0; failure = null; sockets = new Map();} catch (error) {fail('hook', error);}},
    after() {try {for (const [socket, command] of sockets) capture(command, socket);} catch (error) {fail('hook', error);} finally {current = null;}},
    wrap: function(command, args) {
      let target = null;
      try {
        if (typeof command === 'string' && basename(command) === 'tmux' && Array.isArray(args)) {
          const index = args.indexOf('-S');
          const socket = index >= 0 && typeof args[index + 1] === 'string' ? resolve(args[index + 1]) : null;
          const operation = index >= 0 ? args[index + 2] : null;
          target = {command, socket, operation};
          if (socket) sockets.set(socket, command);
          if (socket && operation === 'kill-server') capture(command, socket);
        }
      } catch (error) {fail('metadata', error);}
      const result = Reflect.apply(original, this, arguments);
      try {if (target) emit({kind: 'tmux-command', operation: operations.has(target.operation) ? target.operation : 'other', ...status(result)});} catch (error) {fail('emit', error);}
      return result;
    },
  };
}
