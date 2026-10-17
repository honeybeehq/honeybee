import errno
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys

from guard import DIRS, Refusal, scope_call, validate, write_json


def main():
    root = Path(os.environ['GATE_ROOT'])
    validate(root, os.environ, Path(os.environ['SCG_REAL_HOME']))
    rows = []
    bind_diagnostics = []
    for family, address, port in ((socket.AF_INET, '0.0.0.0', 49197), (socket.AF_INET6, '::', 0), (socket.AF_INET, '127.0.0.1', 0)):
        row = {'family': int(family), 'address': address, 'requestedPort': port}
        try:
            with socket.socket(family, socket.SOCK_STREAM) as probe:
                probe.bind((address, port))
                row.update({'result': 'allowed', 'boundAddress': probe.getsockname()})
        except OSError as error:
            row.update({'result': 'REFUSED' if error.errno in (errno.EPERM, errno.EACCES) else 'INCONCLUSIVE', 'errno': error.errno, 'error': str(error)})
        bind_diagnostics.append(row)
        print('BIND_DIAGNOSTIC=' + json.dumps(row), flush=True)
    write_json(root / 'bind-diagnostics.json', bind_diagnostics, root)
    assert bind_diagnostics[-1]['result'] == 'allowed', 'positive loopback bind failed'
    with open('/dev/null', 'wb') as sink:
        sink.write(b'gate pseudo-device probe')
    rows.append({'row': 'literal /dev/null write-data', 'result': 'allowed kernel sink'})
    try:
        with open('/dev/zero', 'wb'):
            pass
    except OSError as error:
        assert error.errno in (errno.EPERM, errno.EACCES), error
        rows.append({'row': 'other /dev write', 'result': 'REFUSED', 'errno': error.errno})
    else:
        raise AssertionError('other /dev write unexpectedly allowed')
    inside = root / 'planted-inside'
    inside.write_text('inside')
    assert inside.read_text() == 'inside'
    rows.append({'row': 'inside write', 'result': 'allowed'})
    outside = root.parent / (root.name + '.outside')
    before = outside.exists()
    try:
        outside.write_text('must not be written')
    except OSError as error:
        assert error.errno in (errno.EPERM, errno.EACCES, errno.EROFS), error
        rows.append({'row': 'outside planted write', 'result': 'REFUSED', 'errno': error.errno})
    else:
        raise AssertionError('outside write unexpectedly succeeded')
    assert outside.exists() == before
    stricter = subprocess.run(['/usr/bin/sandbox-exec', '-p', '(version 1)(allow default)(deny network*)', sys.executable, '-B', str(Path(__file__).with_name('socket_probe.py')), str(root / 't')], capture_output=True, text=True)
    rows.append({'row': 'nested stricter deny-network-only probe', 'exit': stricter.returncode, 'stdout': stricter.stdout[-4096:], 'stderr': stricter.stderr[-4096:], 'rootOnlyRuleRetainedUnlessStricterProven': True})
    with socket.socket(socket.AF_UNIX) as server, socket.socket(socket.AF_UNIX) as client:
        path = str(root / 't/self-test.sock')
        server.bind(path)
        server.listen(1)
        client.connect(path)
        accepted, _ = server.accept()
        accepted.close()
        rows.append({'row': 'run-root Unix socket', 'result': 'allowed'})
    with socket.socket(socket.AF_UNIX) as client:
        client.connect(os.environ['SCG_ALLOWED_SOCKET'])
        rows.append({'row': 'controller listener in TMPDIR', 'result': 'allowed', 'path': os.environ['SCG_ALLOWED_SOCKET']})
    denied_path = Path(os.environ['SCG_DENIED_SOCKET'])
    assert denied_path.is_socket()
    denied_inode = denied_path.lstat().st_ino
    with socket.socket(socket.AF_UNIX) as client:
        try:
            client.connect(os.environ['SCG_DENIED_SOCKET'])
        except OSError as error:
            assert error.errno in (errno.EPERM, errno.EACCES), error
            assert denied_path.is_socket() and denied_path.lstat().st_ino == denied_inode
            rows.append({'row': 'real controller listener outside TMPDIR', 'result': 'REFUSED', 'errno': error.errno, 'path': os.environ['SCG_DENIED_SOCKET'], 'existingSocketInode': denied_inode})
        else:
            raise AssertionError('outside Unix socket unexpectedly allowed')
    for key in ('npm_config_cache', 'PNPM_STORE_DIR', 'NODE_COMPILE_CACHE'):
        path = Path(os.environ[key]) / 'per-run-probe'
        path.write_text('cache')
        assert root in path.resolve().parents
        rows.append({'row': key, 'result': 'inside run root'})
    helper = Path(os.environ['SCG_SCOPE_HELPER'])
    child = subprocess.Popen(['/bin/sleep', '30'])
    birth = None
    cleanup = []
    try:
        birth = scope_call(helper, 'identity', child.pid)[0]
        stale = list(birth)
        stale[3] = str(int(stale[3]) + 1)
        refused = subprocess.run([str(helper), 'signal', *stale, str(int(signal.SIGTERM))], capture_output=True, text=True)
        poll = child.poll()
        diagnostic = {'row': 'stale signal diagnostic', 'returncode': refused.returncode, 'stdout': refused.stdout[-4096:], 'stderr': refused.stderr[-4096:], 'childPoll': poll, 'birth': birth, 'staleArgs': stale}
        write_json(root / 'physical-stale-signal.json', diagnostic, root)
        print(json.dumps(diagnostic), flush=True)
        assert refused.returncode == 4, 'stale helper returncode=' + str(refused.returncode)
        assert refused.stdout.strip() == 'birth-mismatch-refused', 'stale helper did not prove birth mismatch'
        assert poll is None, 'child.poll()=' + str(poll)
        rows.append({'row': 'mismatched exact birth signal', 'result': 'REFUSED'})
        sent = subprocess.run([str(helper), 'signal', *birth, str(int(signal.SIGTERM))], capture_output=True, text=True)
        assert sent.returncode == 0
        child.wait(timeout=5)
        rows.append({'row': 'own exact birth signal', 'result': 'allowed', 'birth': birth})
    finally:
        if child.poll() is None and birth is not None:
            for sig in (signal.SIGTERM, signal.SIGKILL):
                attempt = subprocess.run([str(helper), 'signal', *birth, str(int(sig))], capture_output=True, text=True)
                cleanup.append({'birth': birth, 'signal': int(sig), 'exit': attempt.returncode, 'stdout': attempt.stdout[-4096:], 'stderr': attempt.stderr[-4096:]})
                if attempt.returncode not in (0, 3):
                    break
                try:
                    child.wait(timeout=1)
                    break
                except subprocess.TimeoutExpired:
                    if attempt.returncode == 3:
                        break
        leftover = None
        if child.poll() is None:
            leftover = {'pid': child.pid, 'birth': birth, 'command': '/bin/sleep 30', 'selfExpiring': True, 'noUnfencedKill': True}
            write_json(root / 'leftover-child.json', leftover, root)
            print('GATE_NONZERO_REASON=' + json.dumps({'leftoverChild': leftover}), flush=True)
        write_json(root / 'physical-child-cleanup.json', {'attempts': cleanup, 'childPoll': child.poll(), 'leftoverChild': leftover}, root)
    with socket.socket() as sock:
        try:
            sock.bind(('0.0.0.0', 0))
        except OSError as error:
            assert error.errno in (errno.EPERM, errno.EACCES), error
            rows.append({'row': 'non-loopback bind', 'result': 'REFUSED', 'errno': error.errno})
        else:
            raise AssertionError('non-loopback bind unexpectedly allowed')
    with socket.socket() as sock:
        sock.settimeout(2)
        try:
            sock.connect(('1.1.1.1', 443))
        except OSError as error:
            assert error.errno in (errno.EPERM, errno.EACCES), error
            rows.append({'row': 'shared-network outbound', 'result': 'REFUSED', 'errno': error.errno})
        else:
            raise AssertionError('non-loopback network unexpectedly allowed')
    assert '/usr/bin/security' in os.environ['SCG_SB_PROFILE']
    rows.append({'row': 'security', 'result': 'deny policy present; no invocation'})
    write_json(root / 'physical-self-tests.json', rows, root)
    print(json.dumps(rows))


if __name__ == '__main__':
    sys.exit(main())
