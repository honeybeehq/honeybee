import errno
import hashlib
import json
import os
import pathlib
import shutil
import subprocess


def snapshot(repo):
    rows = {}
    for name in ('refs', 'objects'):
        parent = pathlib.Path(repo) / name
        for path in [parent, *sorted(parent.rglob('*'))]:
            meta = path.lstat()
            row = dict(inode=meta.st_ino, device=meta.st_dev, mode=meta.st_mode, size=meta.st_size, mtime_ns=meta.st_mtime_ns, uid=meta.st_uid, gid=meta.st_gid)
            if path.is_symlink():
                raise RuntimeError('fixture tree contains symlink')
            if path.is_file():
                row['sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
            rows[str(path.relative_to(repo))] = row
    return rows


def fixture_env():
    env = dict(os.environ)
    for name in list(env):
        if name.startswith('GIT_') or name.lower().endswith('_proxy'):
            del env[name]
    env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null', GIT_AUTHOR_NAME='Gate fixture', GIT_AUTHOR_EMAIL='gate@example.invalid', GIT_COMMITTER_NAME='Gate fixture', GIT_COMMITTER_EMAIL='gate@example.invalid')
    return env


def git_call(binary, cwd, args):
    return subprocess.run([binary, *args], cwd=cwd, env=fixture_env(), input=b'', stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)


def checked(binary, cwd, args):
    result = git_call(binary, cwd, args)
    if result.returncode:
        raise RuntimeError('git boundary fixture setup failed')
    return result.stdout.decode().strip()


def prepare(root, label):
    root = pathlib.Path(root)
    directory = root / 'git-boundary' / label
    directory.mkdir(parents=True)
    binary = pathlib.Path(shutil.which('git')).resolve(strict=True)
    source, target = directory / 'source', directory / 'target.git'
    checked(str(binary), directory, ['init', str(source)])
    checked(str(binary), directory, ['init', '--bare', str(target)])
    for repo in (source, target):
        for key, value in [('credential.helper', ''), ('core.hooksPath', '/dev/null'), ('core.fsmonitor', 'false'), ('http.proxy', ''), ('commit.gpgsign', 'false')]:
            checked(str(binary), repo, ['config', '--local', key, value])
    checked(str(binary), source, ['commit', '--allow-empty', '-m', 'boundary seed'])
    checked(str(binary), source, ['push', str(target), 'HEAD:refs/heads/seed'])
    checked(str(binary), source, ['commit', '--allow-empty', '-m', 'boundary attempted write'])
    attempted = checked(str(binary), source, ['rev-parse', 'HEAD'])
    bare = checked(str(binary), target, ['rev-parse', '--is-bare-repository']) == 'true'
    seed = checked(str(binary), target, ['rev-parse', 'refs/heads/seed'])
    record = dict(binary=str(binary), binarySha256=hashlib.sha256(binary.read_bytes()).hexdigest(), source=str(source), backingTarget=str(target), outsideTarget='/mnt/target.git', bare=bare, seed=seed, attempted=attempted, before=snapshot(target))
    assert bare and record['before']
    (directory / 'fixture.json').write_text(json.dumps(record))
    return directory


def evidence(result, needles):
    lines = result.stderr.decode(errors='replace').splitlines()
    return [line for line in lines if any(needle in line.lower() for needle in needles)]


def run(root, label):
    directory = pathlib.Path(root) / 'git-boundary' / label
    fixture = json.loads((directory / 'fixture.json').read_text())
    binary, source, target = fixture['binary'], fixture['source'], fixture['outsideTarget']
    assert hashlib.sha256(pathlib.Path(binary).read_bytes()).hexdigest() == fixture['binarySha256']
    assert not pathlib.Path(target).is_relative_to(pathlib.Path(root))
    before = snapshot(target)
    bare = checked(binary, target, ['rev-parse', '--is-bare-repository']) == 'true'
    seed_present = checked(binary, target, ['rev-parse', 'refs/heads/seed']) == fixture['seed']
    checked(binary, target, ['cat-file', '-e', fixture['seed'] + '^{commit}'])
    source_ready = checked(binary, source, ['rev-parse', 'HEAD']) == fixture['attempted'] and fixture['attempted'] != fixture['seed']
    readonly = bool(os.statvfs(target).f_flag & os.ST_RDONLY)
    refused_errno = None
    try:
        fd = os.open(pathlib.Path(target) / 'objects' / 'gate-write-probe', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except OSError as error:
        refused_errno = error.errno
    else:
        os.close(fd)
    push = git_call(binary, source, ['push', target, 'HEAD:refs/heads/boundary'])
    matched = evidence(push, ('read-only file system', 'unable to create temporary object directory', 'unpacker error', 'cannot lock ref'))
    after = snapshot(target)
    local = dict(asserted=bare and seed_present and source_ready and readonly and refused_errno == errno.EROFS and push.returncode != 0 and bool(matched) and before == after == fixture['before'], path=target, bare=bare, seedPresent=seed_present, sourceReady=source_ready, readOnly=readonly, writeErrno=refused_errno, pushExit=push.returncode, matchedEvidence=matched, before=before, after=after, unchanged=before == after == fixture['before'], metadataAndHashesOnly=True)
    network = []
    url = 'git://192.0.2.1/git-boundary.git'
    for operation, args in [('fetch', ['fetch', url]), ('push', ['push', url, 'HEAD:refs/heads/boundary'])]:
        result = git_call(binary, source, args)
        matched = evidence(result, ('network is unreachable', 'no route to host'))
        network.append(dict(operation=operation, url=url, exit=result.returncode, matchedEvidence=matched, asserted=result.returncode != 0 and bool(matched)))
    return dict(asserted=local['asserted'] and all(row['asserted'] for row in network), binary=binary, binarySha256=fixture['binarySha256'], outsidePush=local, network=network, fixtureOnlyException=['GIT_CONFIG_NOSYSTEM=1', 'GIT_CONFIG_GLOBAL=/dev/null'])


def receipt_valid(record, fixture, outside_after):
    try:
        local = record['outsidePush']
        assert record['asserted'] is True and record['binary'] == fixture['binary'] and record['binarySha256'] == fixture['binarySha256']
        assert local['asserted'] is True and local['path'] == '/mnt/target.git' and local['bare'] is True and local['readOnly'] is True and local['seedPresent'] is True and local['sourceReady'] is True
        assert local['writeErrno'] == errno.EROFS and local['pushExit'] != 0 and local['matchedEvidence'] and local['unchanged'] is True
        assert fixture['before'] and local['before'] == local['after'] == fixture['before'] == outside_after
        assert len(record['network']) == 2 and {row['operation'] for row in record['network']} == {'fetch', 'push'}
        assert all(row['asserted'] is True and row['exit'] != 0 and row['url'] == 'git://192.0.2.1/git-boundary.git' and row['matchedEvidence'] for row in record['network'])
    except (AssertionError, KeyError, TypeError):
        return False
    return True
