import hashlib
import errno
import json
import os
from pathlib import Path
import re
import stat
import socket
import subprocess


GIT_CANDIDATES = ('/Applications/Xcode.app/Contents/Developer/usr/bin/git', '/Library/Developer/CommandLineTools/usr/bin/git')


def snapshot(target):
    rows = {}
    for path in [target, *sorted(target.rglob('*'))]:
        value = path.lstat()
        if not (stat.S_ISDIR(value.st_mode) or stat.S_ISREG(value.st_mode)):
            raise ValueError('non-regular sealed Git target entry')
        rows[str(path.relative_to(target))] = {'dev': value.st_dev, 'ino': value.st_ino, 'mode': value.st_mode, 'uid': value.st_uid, 'size': value.st_size, 'mtimeNs': value.st_mtime_ns, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None}
    return rows


def prepare(root, env):
    metadata = []
    git = None
    for candidate in GIT_CANDIDATES:
        row = subprocess.run(['/bin/ls', '-ld', candidate], env=env, capture_output=True, text=True)
        metadata.append({'path': candidate, 'exit': row.returncode, 'stdout': row.stdout, 'stderr': row.stderr})
        if git is None and Path(candidate).is_file() and os.access(candidate, os.X_OK):
            git = candidate
    (root / 'git-candidates.json').write_text(json.dumps(metadata, indent=2) + '\n')
    if git is None:
        raise ValueError('no configured real Git binary')
    target = root / 'sealed-target'
    source = root / 'git-source'
    hooks = root / 'git-empty-hooks'
    hooks.mkdir()
    subprocess.run([git, 'init', '--bare', str(target)], env=env, check=True, capture_output=True)
    subprocess.run([git, 'init', str(source)], env=env, check=True, capture_output=True)
    for repository in (target, source):
        for key, value in (('credential.helper', ''), ('core.hooksPath', str(hooks)), ('http.proxy', ''), ('http.https://192.0.2.1/.proxy', '')):
            subprocess.run([git, '-C', str(repository), 'config', '--local', key, value], env=env, check=True, capture_output=True)
    author = dict(env, GIT_AUTHOR_NAME='Gate fixture', GIT_AUTHOR_EMAIL='gate@example.invalid', GIT_COMMITTER_NAME='Gate fixture', GIT_COMMITTER_EMAIL='gate@example.invalid')
    tree = subprocess.run([git, '-C', str(source), 'mktree'], input='', env=author, check=True, capture_output=True, text=True).stdout.strip()
    commit = subprocess.run([git, '-C', str(source), 'commit-tree', tree], input='Gate fixture\n', env=author, check=True, capture_output=True, text=True).stdout.strip()
    subprocess.run([git, '-C', str(source), 'update-ref', 'refs/heads/fixture', commit], env=env, check=True, capture_output=True)
    subprocess.run([git, '-C', str(source), 'push', str(target), 'refs/heads/fixture:refs/heads/seed'], env=env, check=True, capture_output=True)
    controls = {'git': git, 'target': str(target), 'source': str(source), 'before': snapshot(target), 'authorization': 'Queen 17 Oct 14:44Z, amended 14:45Z: sealed target inside root; TEST-NET network denial only'}
    (root / 'git-controls.json').write_text(json.dumps(controls, indent=2) + '\n')
    return controls


def permission_denial(stderr, row):
    if re.search(r'could not resolve|nodename nor servname|timed out|\b(?:401|403)\b|authentication failed|does not appear to be a git repository|not a git repository|no such file|does not exist|missing.path', stderr, re.IGNORECASE):
        return False
    if row == 'sealed-target-push':
        errors = '\n'.join(line for line in stderr.splitlines() if re.search(r'\b(?:fatal|error):|\[remote rejected\]', line, re.IGNORECASE) and not re.search(r'^\s*warning:', line, re.IGNORECASE))
        return bool(re.search(r'unable to create temporary object directory|unpacker error|cannot lock ref|unable to create[^\n]*(?:Operation not permitted|Permission denied)|(?:object|ref|write|creat)[^\n]*Permission denied', errors, re.IGNORECASE))
    fatal = [match.group(1) for line in stderr.splitlines() for match in [re.search(r'\bfatal:\s*(.*)', line, re.IGNORECASE)] if match]
    if not fatal:
        return False
    last = fatal[-1]
    if row in ('non-loopback-fetch', 'non-loopback-push'):
        trace = any(re.search(r'(?:^\*\s*|== Info: )Immediate connect fail for 192\.0\.2\.1:\s*(?:Operation not permitted|Permission denied)\s*$', line, re.IGNORECASE) for line in stderr.splitlines())
        return trace and bool(re.search(r"unable to access 'https://192\.0\.2\.1/x\.git/': Failed to connect to 192\.0\.2\.1 port 443\b.*Couldn't connect to server", last, re.IGNORECASE))
    return False


def storage_probes(root):
    rows = []
    for directory in ('objects', 'refs'):
        for operation in ('mkdir', 'open'):
            path = root / 'sealed-target' / directory / ('gate-denial-' + operation)
            try:
                if operation == 'mkdir':
                    path.mkdir()
                else:
                    fd = os.open(path, os.O_CREAT | os.O_WRONLY | os.O_EXCL, 0o600)
                    os.close(fd)
            except OSError as error:
                rows.append({'operation': operation, 'path': str(path), 'errno': error.errno, 'refused': error.errno in (errno.EPERM, errno.EACCES)})
            else:
                rows.append({'operation': operation, 'path': str(path), 'errno': 0, 'refused': False})
    return rows


def network_probe():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as client:
        client.settimeout(2)
        try:
            client.connect(('192.0.2.1', 443))
        except OSError as error:
            return {'address': '192.0.2.1', 'port': 443, 'errno': error.errno, 'refused': error.errno == errno.EPERM}
    return {'address': '192.0.2.1', 'port': 443, 'errno': 0, 'refused': False}


def workload(root):
    controls = json.loads((root / 'git-controls.json').read_text())
    git = controls['git']
    if git not in GIT_CANDIDATES or controls['target'] != str(root / 'sealed-target') or controls['source'] != str(root / 'git-source'):
        raise ValueError('invalid Git boundary controls')
    env = dict(os.environ, GIT_ALLOW_PROTOCOL='file:https', GIT_TERMINAL_PROMPT='0')
    rows = []
    storage = []
    network = None
    try:
        url = 'https://192.0.2.1/x.git'
        if url != 'https://192.0.2.1/x.git':
            raise ValueError('network fixture URL not allowlisted')
        commands = [('sealed-target-push', ['push', controls['target'], 'refs/heads/fixture:refs/heads/denied']), ('non-loopback-fetch', ['fetch', url]), ('non-loopback-push', ['push', url, 'refs/heads/fixture:refs/heads/denied'])]
        for name, args in commands:
            argv = [git, '-C', controls['source'], *args]
            try:
                command_env = dict(env, GIT_CURL_VERBOSE='1') if name.startswith('non-loopback-') else env
                result = subprocess.run(argv, env=command_env, capture_output=True, text=True, timeout=10)
                denied = result.returncode != 0 and permission_denial(result.stderr, name)
                rows.append({'row': name, 'argv': argv, 'exit': result.returncode, 'stderr': result.stderr[-8192:], 'permissionDenied': denied, 'realGit': True})
            except (OSError, subprocess.TimeoutExpired) as error:
                rows.append({'row': name, 'argv': argv, 'error': str(error), 'permissionDenied': False, 'realGit': True})
            if name == 'sealed-target-push':
                storage = storage_probes(root)
                rows[-1]['writeFailureClass'] = rows[-1]['permissionDenied']
                rows[-1]['permissionDenied'] = rows[-1]['permissionDenied'] and len(storage) == 4 and all(row['refused'] for row in storage)
        network = network_probe()
        for row in rows:
            if row['row'].startswith('non-loopback-'):
                row['fatalConnectDenied'] = row['permissionDenied']
                row['permissionDenied'] = row['permissionDenied'] and network['refused']
    finally:
        accepted = len(rows) == 3 and all(row['permissionDenied'] for row in rows) and len(storage) == 4 and all(row['refused'] for row in storage) and network is not None and network['refused']
        (root / 'git-boundary-workload.json').write_text(json.dumps({'rows': rows, 'storageProbes': storage, 'networkProbe': network, 'allDenied': accepted}, indent=2) + '\n')
    if not accepted:
        raise ValueError('Git boundary rows lack operation-bound permission evidence or direct syscall denial')


if __name__ == '__main__':
    workload(Path(os.environ['GATE_ROOT']))
