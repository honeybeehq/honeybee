import json, os, re, stat, sys
from pathlib import Path

root, = sys.argv[1:]
if not re.fullmatch(r'/private/var/tmp/g\.[0-9A-Fa-f]{8}', root) or str(Path(root).resolve(strict=True)) != root:
    raise SystemExit('REFUSING: invalid retained run root')
flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
root_fd = os.open(root, flags | os.O_DIRECTORY)
info = os.fstat(root_fd)
if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
    raise SystemExit('REFUSING: root ownership or mode')

def read(name, lines=False):
    allowed = {'receipt.json', 'focused-summary.json', 'focused-pair.json', 'focused-rows.json', 'focused-outer-2-process.json', 'logs/focused-tmux-diagnostics.jsonl'}
    if name not in allowed:
        raise ValueError('unapproved evidence file')
    directory, opened = root_fd, None
    try:
        if name.startswith('logs/'):
            opened = os.open('logs', flags | os.O_DIRECTORY, dir_fd=root_fd)
            directory = opened
        try:
            fd = os.open(name.rsplit('/', 1)[-1], flags, dir_fd=directory)
        except FileNotFoundError:
            return None
        try:
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or before.st_nlink != 1 or before.st_size > 16777216:
                raise ValueError('unsafe or oversized evidence')
            data = bytearray()
            while len(data) <= 16777216:
                chunk = os.read(fd, min(65536, 16777217 - len(data)))
                if not chunk: break
                data.extend(chunk)
            after = os.fstat(fd)
            if len(data) > 16777216 or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
                raise ValueError('evidence grew or changed')
            return [json.loads(line) for line in data.splitlines()] if lines else json.loads(data)
        finally:
            os.close(fd)
    finally:
        if opened is not None: os.close(opened)

def emit(name, value):
    print(json.dumps({'file': name, 'evidence': value}, sort_keys=True))

NAMES = ['real type-mode terminal phone pointer reads original frame and never repeats after store reopen', 'real type-mode terminal phone pointer post-Enter file-read commit-throw corruption warns may-have-delivered once', 'real ordinary paste post-Enter commit failure and corruption cannot claim not-delivered', 'real pointer phase clears and retries the same publication', 'real pointer phase quarantines all later mail', 'real pointer phase unset_failure', 'real pointer phase missing_identity', 'real pointer phase legacy_query']

def valid_tmux_row(row, names):
    failures = {None, 'append_eacces', 'append_enospc', 'append_emfile', 'append_other', 'realpath_failed', 'capture_failed', 'emit_failed', 'metadata_failed', 'hook_failed', 'diagnostic_failed'}
    errors = {None, 'ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EMFILE', 'ENFILE', 'EINVAL', 'EIO', 'ENOMEM', 'ETIMEDOUT', 'ENOBUFS', 'EPIPE', 'OTHER'}
    classes = {'forkpty_failed', 'posix_openpt_failed', 'operation_not_permitted', 'permission_denied', 'not_a_terminal', 'no_server_running', 'server_exited_unexpectedly', 'error_connecting', 'socket_path', 'create_window_failed', 'other_nonempty', 'empty'}
    kinds = {'tmux-command': {'operation'}, 'pane-list': set(), 'terminal-capture': {'pane'}}
    base = {'row', 'kind', 'exit', 'signal', 'error', 'stderr', 'diagnosticFailure'}
    if not isinstance(row, dict) or not isinstance(row.get('kind'), str) or row['kind'] not in kinds or set(row) != base | kinds[row['kind']] or row.get('row') not in names:
        return False
    if any(value is not None and not isinstance(value, str) for value in (row['diagnosticFailure'], row['error'])):
        return False
    if row['diagnosticFailure'] not in failures or row['error'] not in errors or any(value is not None and type(value) is not int for value in (row['exit'], row['signal'])):
        return False
    def hashed(value, keys):
        return isinstance(value, dict) and set(value) == keys and type(value['byteCount']) is int and value['byteCount'] >= 0 and isinstance(value['sha256'], str) and re.fullmatch(r'[0-9a-f]{64}', value['sha256']) is not None
    if not hashed(row['stderr'], {'byteCount', 'sha256', 'classes'}) or not isinstance(row['stderr']['classes'], list) or not row['stderr']['classes'] or any(not isinstance(value, str) or value not in classes for value in row['stderr']['classes']):
        return False
    if row['kind'] == 'terminal-capture':
        pane = row['pane']
        if not hashed(pane, {'byteCount', 'sha256', 'lineCount', 'markers'}) or type(pane['lineCount']) is not int or pane['lineCount'] < 0 or not isinstance(pane['markers'], dict) or set(pane['markers']) != {'phoneTerminalReady', 'received', 'pointer'} or any(type(value) is not bool for value in pane['markers'].values()):
            return False
    if row['kind'] == 'tmux-command' and (not isinstance(row['operation'], str) or row['operation'] not in {'new-session', 'new-window', 'kill-server', 'kill-session', 'kill-pane', 'list-panes', 'list-sessions', 'capture-pane', 'display-message', 'show-options', 'set-option', 'set-options', 'send-keys', 'load-buffer', 'paste-buffer', 'delete-buffer', 'resize-pane', 'select-pane', 'has-session', 'other'}):
        return False
    return True


summary = read('focused-summary.json')
emit('focused-summary.json:verdict', {k: summary[k] for k in ('ok', 'required', 'passed', 'excludedNotProof', 'siblingRows') if isinstance(summary, dict) and k in summary and type(summary[k]) in (bool, int)} if isinstance(summary, dict) else {'absent': True})
pair = read('focused-pair.json')
if isinstance(pair, dict):
    verdicts = []
    for row in pair.get('rows', []):
        verdict = {'ok': row.get('ok') is True}
        for mode in ('instrumented', 'production'):
            value = row.get(mode)
            verdict[mode] = None
            if isinstance(value, dict):
                hashes = {k: value[k] for k in ('expectedDigest', 'observedDigest', 'expectedHeaderSha256', 'observedHeaderSha256') if isinstance(value.get(k), str) and re.fullmatch(r'[0-9a-f]{64}', value[k])}
                verdict[mode] = dict(hashes, readClass='read' if value.get('readClass') == 'read' else 'unobserved', writeDenied=value.get('writeDenied') if value.get('writeDenied') is None or type(value.get('writeDenied')) is bool else None)
        verdicts.append(verdict)
    emit('focused-pair.json:verdict', {'ok': pair.get('ok') is True, 'rows': verdicts})
else:
    emit('focused-pair.json:verdict', {'absent': True})
for name in ('receipt.json', 'focused-outer-2-process.json'):
    value = read(name)
    emit(name + ':exit', {k: value[k] for k in ('exit', 'workloadExit') if isinstance(value, dict) and type(value.get(k)) is int} if isinstance(value, dict) else {'absent': True})
rows = read('focused-rows.json')
if isinstance(rows, list):
    for phase in rows:
        if phase.get('mode') != 'outer' or phase.get('file') != 'v2/daemon/tests/multiline-fallback-tmux.test.ts': continue
        diagnostics = phase.get('tmuxDiagnostics', {})
        grouped = diagnostics.get('rows', {})
        if not isinstance(grouped, dict) or set(grouped) - set(NAMES): raise ValueError('unknown diagnostic row')
        records = [row for name in NAMES for row in grouped.get(name, [])]
        if not all(valid_tmux_row(row, NAMES) for row in records): raise ValueError('unsafe diagnostic record')
        failures = diagnostics.get('failureEnums', [])
        allowed = {'append_eacces', 'append_enospc', 'append_emfile', 'append_other', 'realpath_failed', 'capture_failed', 'emit_failed', 'metadata_failed', 'hook_failed', 'diagnostic_failed'}
        if not isinstance(failures, list) or any(not isinstance(x, str) or x not in allowed for x in failures): raise ValueError('unknown failure enum')
        emit('focused-rows.json:tmuxDiagnostics', {'records': records, 'failureEnums': failures})
raw = read('logs/focused-tmux-diagnostics.jsonl', True)
if raw is not None and not all(valid_tmux_row(row, NAMES) for row in raw): raise ValueError('unsafe raw diagnostic record')
emit('logs/focused-tmux-diagnostics.jsonl', raw if raw is not None else {'absent': True})
os.close(root_fd)
