import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {beforeEach, afterEach} from 'node:test';
import {appendFileSync, constants, realpathSync, writeSync} from 'node:fs';
import {createObserver} from './focused-tmux-observer.mjs';

const observer = createObserver({
  original: cp.spawnSync,
  append: line => appendFileSync(process.env.SCG_TMUX_DIAGNOSTIC_FILE, line, {flag: constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW}),
  realpath: realpathSync,
  tmpdir: process.env.TMPDIR,
  reportFailure: failure => {try {writeSync(2, '# SCG_TMUX_DIAGNOSTIC_FAILURE=' + failure + '\n');} catch {}},
});
beforeEach(t => {try {observer.before(t.name);} catch {}});
afterEach(() => {try {observer.after();} catch {}});
cp.spawnSync = observer.wrap;
try {syncBuiltinESMExports();} catch {try {writeSync(2, '# SCG_TMUX_DIAGNOSTIC_FAILURE=hook_failed\n');} catch {}}
