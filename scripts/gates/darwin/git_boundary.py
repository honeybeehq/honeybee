import hashlib
import json
import os
from pathlib import Path
import re
import stat
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


def workload(root):
    controls = json.loads((root / 'git-controls.json').read_text())
    git = controls['git']
    if git not in GIT_CANDIDATES or controls['target'] != str(root / 'sealed-target') or controls['source'] != str(root / 'git-source'):
        raise ValueError('invalid Git boundary controls')
    env = dict(os.environ, GIT_ALLOW_PROTOCOL='file:https', GIT_TERMINAL_PROMPT='0')
    rows = []
    try:
        subprocess.run([git, '--version'], env=env, check=True, capture_output=True)
        url = 'https://192.0.2.1/x.git'
        if url != 'https://192.0.2.1/x.git':
            raise ValueError('network fixture URL not allowlisted')
        commands = [('sealed-target-push', ['push', controls['target'], 'refs/heads/fixture:refs/heads/denied']), ('non-loopback-fetch', ['fetch', url]), ('non-loopback-push', ['push', url, 'refs/heads/fixture:refs/heads/denied'])]
        for name, args in commands:
            argv = [git, '-C', controls['source'], *args]
            result = subprocess.run(argv, env=env, capture_output=True, text=True, timeout=10)
            denied = result.returncode != 0 and bool(re.search(r'Operation not permitted|Permission denied|\bEPERM\b|\bEACCES\b', result.stderr))
            rows.append({'row': name, 'argv': argv, 'exit': result.returncode, 'stderr': result.stderr[-8192:], 'permissionDenied': denied, 'realGit': True})
            if not denied:
                raise ValueError('Git boundary row lacks permission-denial evidence: ' + name)
    finally:
        (root / 'git-boundary-workload.json').write_text(json.dumps({'rows': rows, 'allDenied': len(rows) == 3 and all(row['permissionDenied'] for row in rows)}, indent=2) + '\n')


if __name__ == '__main__':
    workload(Path(os.environ['GATE_ROOT']))
