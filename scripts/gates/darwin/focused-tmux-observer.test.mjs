import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createObserver, paneSummary, stderrSummary} from './focused-tmux-observer.mjs';

for (const [scenario, expected] of [['EACCES', 'append_eacces'], ['ENOSPC', 'append_enospc'], ['EMFILE', 'append_emfile'], ['realpath', 'realpath_failed'], ['capture', 'capture_failed']]) {
  test('diagnostic failure preserves original result and teardown: ' + scenario, () => {
    const failureEnums = [], records = [], invoked = [];
    const result = {status: 7, signal: 'SIGTERM', error: null, stderr: Buffer.from('Permission denied SECRET_PAYLOAD'), stdout: Buffer.from('SECRET_PAYLOAD')};
    const original = (command, args) => {
      invoked.push(args[2]);
      if (args[2] === 'list-panes') {
        if (scenario === 'capture') throw new Error('SECRET_CAPTURE_ERROR');
        return {...result, stdout: Buffer.from('%1\n')};
      }
      return result;
    };
    const observer = createObserver({original, append: line => {
      if (['EACCES', 'ENOSPC', 'EMFILE'].includes(scenario)) throw Object.assign(new Error('SECRET_APPEND_ERROR'), {code: scenario});
      records.push(JSON.parse(line));
    }, realpath: value => {if (scenario === 'realpath') throw new Error('SECRET_PATH'); return value;}, tmpdir: '/owned/t', reportFailure: value => failureEnums.push(value)});
    observer.before('selected');
    assert.equal(observer.wrap('tmux', ['-S', '/owned/t/row/socket', 'new-session']), result);
    assert.equal(observer.wrap('tmux', ['-S', '/owned/t/row/socket', 'kill-server']), result);
    assert.doesNotThrow(() => observer.after());
    assert.equal(invoked.filter(value => value === 'kill-server').length, 1);
    assert.deepEqual(failureEnums, [expected]);
    assert.ok(!JSON.stringify({records, failureEnums}).includes('SECRET'));
    assert.ok(records.every(row => row.signal === 15));
  });
}

test('stderr fixed classifiers retain no raw text', () => {
  for (const [text, expected] of [['forkpty failed', 'forkpty_failed'], ['posix_openpt failed', 'posix_openpt_failed'], ['Operation not permitted', 'operation_not_permitted'], ['Permission denied', 'permission_denied'], ['not a terminal', 'not_a_terminal'], ['no server running', 'no_server_running'], ['server exited unexpectedly', 'server_exited_unexpectedly'], ['error connecting', 'error_connecting'], ['socket path too long', 'socket_path'], ['create window failed', 'create_window_failed'], ['SECRET_PAYLOAD', 'other_nonempty'], ['', 'empty']]) {
    const result = stderrSummary(Buffer.from(text));
    assert.deepEqual(result.classes, [expected]);
    assert.equal(result.byteCount, Buffer.byteLength(text));
    assert.match(result.sha256, /^[0-9a-f]{64}$/);
    if (text) assert.ok(!JSON.stringify(result).includes(text));
  }
});

test('pane retains only counts hash and fixed fixture booleans', () => {
  const result = paneSummary(Buffer.from('phone terminal ready\nreceived\nfull text: SECRET_PAYLOAD\n'));
  assert.equal(result.lineCount, 3);
  assert.deepEqual(result.markers, {phoneTerminalReady: true, received: true, pointer: true});
  assert.ok(!JSON.stringify(result).includes('SECRET_PAYLOAD'));
  assert.deepEqual(paneSummary(null).markers, {phoneTerminalReady: false, received: false, pointer: false});
});

test('a failing failure sink also cannot stop teardown', () => {
  const result = {status: 0, signal: null, error: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)};
  let kills = 0;
  const observer = createObserver({original: (_command, args) => {if (args[2] === 'kill-server') kills++; return result;}, append: () => {throw Error('append');}, realpath: value => value, tmpdir: '/owned/t', reportFailure: () => {throw Error('sink');}});
  observer.before('selected');
  assert.equal(observer.wrap('tmux', ['-S', '/owned/t/row/socket', 'kill-server']), result);
  assert.doesNotThrow(() => observer.after());
  assert.equal(kills, 1);
});
