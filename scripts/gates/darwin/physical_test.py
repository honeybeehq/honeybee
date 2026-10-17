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
    stricter = subprocess.run(['/usr/bin/sandbox-exec', '-p', '(version 1)(allow default)(deny network*)', sys.executable, '-B', str(Path(__file__).with_name('socket_probe.py')), str(root)], capture_output=True, text=True)
    rows.append({'row': 'nested stricter deny-network-only probe', 'exit': stricter.returncode, 'stdout': stricter.stdout[-4096:], 'stderr': stricter.stderr[-4096:], 'rootOnlyRuleRetainedUnlessStricterProven': True})
    with socket.socket(socket.AF_UNIX) as server, socket.socket(socket.AF_UNIX) as client:
        path = str(root / 'self-test.sock')
        server.bind(path)
        server.listen(1)
        client.connect(path)
        accepted, _ = server.accept()
        accepted.close()
        rows.append({'row': 'run-root Unix socket', 'result': 'allowed'})
    with socket.socket(socket.AF_UNIX) as client:
        try:
            client.connect(str(root.parent / (root.name + '.outside.sock')))
        except OSError as error:
            assert error.errno in (errno.EPERM, errno.EACCES), error
            rows.append({'row': 'outside-root Unix socket', 'result': 'REFUSED', 'errno': error.errno})
        else:
            raise AssertionError('outside Unix socket unexpectedly allowed')
    for key in ('npm_config_cache', 'PNPM_STORE_DIR', 'NODE_COMPILE_CACHE'):
        path = Path(os.environ[key]) / 'per-run-probe'
        path.write_text('cache')
        assert root in path.resolve().parents
        rows.append({'row': key, 'result': 'inside run root'})
    helper = Path(os.environ['SCG_SCOPE_HELPER'])
    child = subprocess.Popen(['/bin/sleep', '30'])
    try:
        birth = scope_call(helper, 'identity', child.pid)[0]
        stale = list(birth)
        stale[3] = str(int(stale[3]) + 1)
        refused = subprocess.run([str(helper), 'signal', *stale, str(signal.SIGTERM)], capture_output=True, text=True)
        assert refused.returncode == 4 and child.poll() is None
        rows.append({'row': 'mismatched exact birth signal', 'result': 'REFUSED'})
        sent = subprocess.run([str(helper), 'signal', *birth, str(signal.SIGTERM)], capture_output=True, text=True)
        assert sent.returncode == 0
        child.wait(timeout=5)
        rows.append({'row': 'own exact birth signal', 'result': 'allowed', 'birth': birth})
    finally:
        if child.poll() is None:
            raise AssertionError('own child remains; no unfenced fallback kill')
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
