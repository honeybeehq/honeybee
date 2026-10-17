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
    allowed = {'receipt.json', 'focused-summary.json', 'node-default-argv-self-test.json', 'pty-control-self-tests.json', 'pty-tmux-control.json'}
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

EXPECTED = {'--test-coverage-functions': '0', '--test-concurrency': '1', '--inspect-publish-uid': 'stderr,http', '--inspect-port': '127.0.0.1:9229', '--report-signal': 'SIGUSR2', '--test-coverage-lines': '0', '--test-isolation': 'process', '--heap-prof-interval': '524288', '--cpu-prof-interval': '1000', '--v8-pool-size': '4', '--trace-event-file-pattern': 'node_trace.${rotation}.log', '--secure-heap-min': '2', '--network-family-autoselection-attempt-timeout': '250', '--tls-cipher-list': 'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES256-GCM-SHA384:DHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-SHA256:DHE-RSA-AES128-SHA256:ECDHE-RSA-AES256-SHA384:DHE-RSA-AES256-SHA384:ECDHE-RSA-AES256-SHA256:DHE-RSA-AES256-SHA256:HIGH:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5:!PSK:!SRP:!CAMELLIA', '--test-name-pattern': 'reviewed-row-pattern', '--use-largepages': 'off', '--secure-heap': '0', '--watch-kill-signal': 'SIGTERM', '--test-coverage-branches': '0', '--max-http-header-size': '16384', '--test-timeout': '0', '--node-snapshot': 'true', '--stack-trace-limit': '10', '--heapsnapshot-near-heap-limit': '0'}
ERRNOS = {'NONE', 'EPERM', 'EACCES', 'EAGAIN', 'ENOENT', 'ENOTTY', 'EINVAL', 'EBADF', 'EIO', 'ENOMEM', 'OTHER', 'NOT_RUN'}
FOREIGN = ('foreignBefore', 'foreignAfter')
STAGES = ('posixOpenpt', 'grantpt', 'unlockpt', 'slaveOpen', 'ttyIoctl', 'nonTty', 'forkExec')

def safe(value, booleans=(), integers=(), hashes=()):
    if not isinstance(value, dict): return {'absent': True}
    result = {key: value[key] for key in booleans if type(value.get(key)) is bool}
    result.update({key: value[key] for key in integers if type(value.get(key)) is int and -1000000 <= value[key] <= 1000000000})
    result.update({key: value[key] for key in hashes if isinstance(value.get(key), str) and re.fullmatch('[0-9a-f]{64}', value[key])})
    return result

def cleanup(value):
    return safe(value, ('gone',))

def process(value):
    result = safe(value, (), ('exit', 'stdoutBytes', 'stderrBytes'), ('stderrSha256',))
    if isinstance(value, dict): result['cleanup'] = cleanup(value.get('cleanup'))
    return result

def tmux(value):
    result = safe(value, ('ok', 'testOnly', 'foregroundD', 'privateSocket', 'emptyConfigControlOnly', 'fixtureMarkerPresent'), ('captureBytes',), ('captureSha256',))
    if not isinstance(value, dict): return result
    result['cleanup'] = cleanup(value.get('cleanup'))
    result['binary'] = safe(value.get('pin'), (), (), ('sha256',))
    commands = value.get('commands', [])
    if not isinstance(commands, list) or len(commands) > 256: raise ValueError('command bound')
    result['commands'] = []
    for item in commands:
        if not isinstance(item, dict) or item.get('operation') not in ('set-option', 'new-session', 'capture-pane'): raise ValueError('command enum')
        result['commands'].append(dict(process(item), operation=item['operation']))
    return result

capture = read('node-default-argv-self-test.json')
if capture is None:
    emit('node-default-argv-self-test.json', {'absent': True})
else:
    if not isinstance(capture, dict): raise ValueError('capture schema')
    entries, bad = capture.get('flags'), capture.get('unsupportedNames')
    if not isinstance(entries, list) or len(entries) > 128 or not isinstance(bad, list) or len(bad) > 128: raise ValueError('capture bound')
    matches = {}
    for row in entries:
        if not isinstance(row, dict) or set(row) != {'name', 'value'} or not isinstance(row['name'], str): raise ValueError('flag schema')
        name = row['name']
        if name not in EXPECTED: raise ValueError('unexpected retained flag')
        matches.setdefault(name, []).append(row['value'] == EXPECTED[name])
    unsupported = []
    for name in bad:
        if not isinstance(name, str) or not re.fullmatch(r'--[a-z0-9-]{1,92}|invalid_name', name): raise ValueError('flag name')
        unsupported.append(name)
    verdict = safe(capture, ('ok',), ('reviewedPatternCaptures',))
    verdict['flags'] = [{'name': name, 'verdict': 'mismatch' if name in unsupported or (name in matches and not all(matches[name])) else 'match' if name in matches else 'missing'} for name in sorted(EXPECTED)]
    verdict['unsupportedFlagNames'] = sorted(set(unsupported))
    emit('node-default-argv-self-test.json', verdict)

value = read('pty-control-self-tests.json')
result = safe(value, ('ok', 'selfTestOnly', 'productionProfileUnchanged', 'dummyPtyNotInherited', 'dummyPtyClosed', 'controllerNonTtyOpenAllowed', 'candidateDeadForeignSlaveAllowed'), (), ('sourceSha256', 'binarySha256'))
if isinstance(value, dict):
    result['compiler'] = safe(value.get('compiler'), ('unchangedCompilerProfile',), ('exit', 'stderrBytes'), ('stderrSha256',))
    if 'failure' in value:
        if value['failure'] not in ('ValueError', 'OSError', 'TimeoutExpired', 'CalledProcessError', 'FileNotFoundError', 'PermissionError'): raise ValueError('failure enum')
        result['failure'] = value['failure']
    rows = value.get('rows', [])
    if not isinstance(rows, list) or len(rows) > 2: raise ValueError('row bound')
    result['rows'] = []
    for row in rows:
        if not isinstance(row, dict) or type(row.get('candidate')) is not bool: raise ValueError('row schema')
        item = safe(row, ('candidate', 'ok', 'foreignBothDenied', 'foreignOpenedForbidden', 'nonTtyDenied', 'ownChainPassed'))
        item['process'] = process(row.get('process'))
        observation = row.get('observations')
        if observation is not None:
            if not isinstance(observation, dict) or set(observation) != set(STAGES) | set(FOREIGN) | {'trueExit'}: raise ValueError('stage schema')
            if any(not isinstance(observation[key], str) or observation[key] not in ERRNOS for key in STAGES): raise ValueError('stage errno')
            item['foreign'] = {}
            for key in FOREIGN:
                stages = observation[key]
                if not isinstance(stages, dict) or set(stages) != {'open', 'write'} or not isinstance(stages['open'], str) or not isinstance(stages['write'], str): raise ValueError('foreign schema')
                if stages['open'] not in {'OPENED'} | {'DENIED_' + name for name in ERRNOS - {'NONE', 'NOT_RUN'}} or stages['write'] not in (ERRNOS - {'NONE'}) | {'WROTE'}: raise ValueError('foreign enum')
                item['foreign'][key] = dict(stages)
            item['stages'] = {key: observation[key] for key in STAGES}
            item.update(safe(observation, (), ('trueExit',)))
        result['rows'].append(item)
    result['tmux'] = tmux(value.get('tmux'))
emit('pty-control-self-tests.json', result)
emit('pty-tmux-control.json', tmux(read('pty-tmux-control.json')))
for name in ('receipt.json', 'focused-summary.json'):
    emit(name, safe(read(name), ('ok', 'selfTest'), ('exit', 'workloadExit', 'required', 'passed', 'excludedNotProof', 'siblingRows')))
os.close(root_fd)
