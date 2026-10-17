import errno
import hashlib
import json
import os
import pathlib
import shutil
import re
import socket
import stat
import subprocess
from home_guard import entry_guard


def snapshot(repo):
    rows = {}
    repo = pathlib.Path(repo)
    for path in [repo, *sorted(repo.rglob('*'))]:
        meta = path.lstat()
        if not (stat.S_ISDIR(meta.st_mode) or stat.S_ISREG(meta.st_mode)):
            raise RuntimeError('fixture tree contains non-regular entry')
        row = dict(inode=meta.st_ino, device=meta.st_dev, mode=meta.st_mode, size=meta.st_size, mtime_ns=meta.st_mtime_ns, uid=meta.st_uid, gid=meta.st_gid)
        if stat.S_ISREG(meta.st_mode):
            row['sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
        rows[str(path.relative_to(repo))] = row
    return rows


def translate_ownership(rows, uid_map, gid_map):
    def translate(value, mapping):
        matches = [outside + value - inside for inside, outside, count in mapping if inside <= value < inside + count]
        if len(matches) != 1:
            raise ValueError('fixture ownership has no unique namespace mapping')
        return matches[0]
    return {path: dict(row, uid=translate(row['uid'], uid_map), gid=translate(row['gid'], gid_map)) for path, row in rows.items()}


def namespace_map(name):
    return [[int(value) for value in line.split()] for line in pathlib.Path('/proc/self/' + name).read_text().splitlines()]


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
    guard = entry_guard(root)
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
    record = dict(entryGuard=guard, binary=str(binary), binarySha256=hashlib.sha256(binary.read_bytes()).hexdigest(), source=str(source), backingTarget=str(target), outsideTarget='/mnt/target.git', bare=bare, seed=seed, attempted=attempted, namespaceBefore=snapshot(target), uidMap=namespace_map('uid_map'), gidMap=namespace_map('gid_map'))
    record['before'] = translate_ownership(record['namespaceBefore'], record['uidMap'], record['gidMap'])
    assert bare and record['before']
    (directory / 'fixture.json').write_text(json.dumps(record))
    return directory


NETWORK_URL = 'git://192.0.2.1/git-boundary.git'
OUTSIDE_TARGET = '/mnt/target.git'
FORBIDDEN = re.compile(r'not (?:a )?git repository|does not appear to be a git repository|does not exist|no such file|permission denied|operation not permitted|ownership|unsafe repository|auth|could not read username|timed?[ -]out|timeout|connection (?:refused|reset|closed|aborted|terminated)|closed (?:by|connection)|reset by peer|broken pipe|unexpected (?:disconnect|eof)|remote end hung up|empty reply|connected to|connection established|could not resolve|access denied', re.IGNORECASE)
LOCAL_ERROR = re.compile(r'(?:remote: )?(?:fatal|error): .*?(?:unable to create temporary object directory|unpacker error|cannot lock ref|[Rr]ead-only file system).*')
NETWORK_FATAL = re.compile(r'fatal: unable to connect to 192\.0\.2\.1:')
NETWORK_DETAIL = re.compile(r'192\.0\.2\.1\[0: 192\.0\.2\.1\]: errno=(?:Network is unreachable|No route to host)')


def classify_stderr(stderr, operation, target):
    if (operation, target) not in {('push', OUTSIDE_TARGET), ('fetch', NETWORK_URL), ('push', NETWORK_URL)}:
        return dict(classification='invalid_route', matchedEvidence=[])
    lines = stderr.splitlines()
    forbidden = [line for line in lines if FORBIDDEN.search(line)]
    if forbidden:
        return dict(classification='forbidden_error', matchedEvidence=forbidden)
    if target == OUTSIDE_TARGET:
        matched = [line for line in lines if LOCAL_ERROR.fullmatch(line)]
        return dict(classification='local_write_failure' if matched else 'unmatched_error', matchedEvidence=matched)
    fatal = [line for line in lines if NETWORK_FATAL.fullmatch(line)]
    detail = [line for line in lines if NETWORK_DETAIL.fullmatch(line)]
    return dict(classification='network_unreachable' if fatal and detail else 'unmatched_error', matchedEvidence=fatal + detail)


def storage_probes(target):
    rows = []
    for directory in ('objects', 'refs'):
        for operation in ('mkdir', 'open'):
            path = pathlib.Path(target) / directory / ('gate-write-' + operation)
            try:
                if operation == 'mkdir':
                    path.mkdir()
                else:
                    fd = os.open(path, os.O_CREAT | os.O_WRONLY | os.O_EXCL, 0o600)
                    os.close(fd)
            except OSError as error:
                number = error.errno
            else:
                number = 0
            rows.append(dict(path=str(path), operation=operation, errno=number, refused=number == errno.EROFS))
    return rows


def network_probe():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as client:
        client.settimeout(2)
        try:
            client.connect(('192.0.2.1', 9418))
        except OSError as error:
            number = error.errno
        else:
            number = 0
    return dict(address='192.0.2.1', port=9418, errno=number, refused=number in (errno.ENETUNREACH, errno.EHOSTUNREACH))


def run(root, label):
    directory = pathlib.Path(root) / 'git-boundary' / label
    fixture = json.loads((directory / 'fixture.json').read_text())
    binary, source, target = fixture['binary'], fixture['source'], fixture['outsideTarget']
    assert hashlib.sha256(pathlib.Path(binary).read_bytes()).hexdigest() == fixture['binarySha256']
    assert not pathlib.Path(target).is_relative_to(pathlib.Path(root))
    uid_map = [[os.getuid(), fixture['controllerUid'], 1]]
    gid_map = [[os.getgid(), fixture['controllerGid'], 1]]
    before = translate_ownership(snapshot(target), uid_map, gid_map)
    bare = checked(binary, target, ['rev-parse', '--is-bare-repository']) == 'true'
    seed_present = checked(binary, target, ['rev-parse', 'refs/heads/seed']) == fixture['seed']
    checked(binary, target, ['cat-file', '-e', fixture['seed'] + '^{commit}'])
    source_ready = checked(binary, source, ['rev-parse', 'HEAD']) == fixture['attempted'] and fixture['attempted'] != fixture['seed']
    readonly = bool(os.statvfs(target).f_flag & os.ST_RDONLY)
    push = git_call(binary, source, ['push', target, 'HEAD:refs/heads/boundary'])
    storage = storage_probes(target)
    classified = classify_stderr(push.stderr.decode(errors='replace'), 'push', target)
    after = translate_ownership(snapshot(target), uid_map, gid_map)
    local = dict(proof='combined boundary proof: git write-failure class plus direct EROFS syscall probes plus an unchanged tree', asserted=bare and seed_present and source_ready and readonly and push.returncode != 0 and classified['classification'] == 'local_write_failure' and all(row['refused'] for row in storage) and before == after == fixture['before'], operation='push', path=target, bare=bare, seedPresent=seed_present, sourceReady=source_ready, readOnly=readonly, pushExit=push.returncode, storageProbes=storage, before=before, after=after, unchanged=before == after == fixture['before'], metadataAndHashesOnly=True, **classified)
    network = []
    for operation, args in [('fetch', ['fetch', NETWORK_URL]), ('push', ['push', NETWORK_URL, 'HEAD:refs/heads/boundary'])]:
        result = git_call(binary, source, args)
        probe = network_probe()
        classified = classify_stderr(result.stderr.decode(errors='replace'), operation, NETWORK_URL)
        network.append(dict(operation=operation, url=NETWORK_URL, exit=result.returncode, connectProbe=probe, asserted=result.returncode != 0 and classified['classification'] == 'network_unreachable' and probe['refused'], **classified))
    return dict(ownershipMaps=dict(uid=uid_map, gid=gid_map, namespaceUid=namespace_map('uid_map'), namespaceGid=namespace_map('gid_map')), entryGuard=fixture['entryGuard'], asserted=local['asserted'] and all(row['asserted'] for row in network), binary=binary, binarySha256=fixture['binarySha256'], outsidePush=local, network=network, fixtureOnlyException=['GIT_CONFIG_NOSYSTEM=1', 'GIT_CONFIG_GLOBAL=/dev/null'])


def receipt_valid(record, fixture, outside_after):
    try:
        maps = record['ownershipMaps']
        assert maps['uid'] == [[1000, fixture['controllerUid'], 1]] and maps['gid'] == [[1000, fixture['controllerGid'], 1]]
        assert maps['namespaceUid'] == maps['namespaceGid'] == [[1000, 0, 1]]
        guard = record['entryGuard']
        assert guard == fixture['entryGuard'] and guard['allowed'] is True and guard['beforeFirstWrite'] is True
        local = record['outsidePush']
        assert record['asserted'] is True and record['binary'] == fixture['binary'] and record['binarySha256'] == fixture['binarySha256']
        assert local['asserted'] is True and local['operation'] == 'push' and local['path'] == OUTSIDE_TARGET and local['bare'] is True and local['readOnly'] is True and local['seedPresent'] is True and local['sourceReady'] is True
        assert local['pushExit'] != 0 and local['unchanged'] is True
        assert local['classification'] == 'local_write_failure' and classify_stderr('\n'.join(local['matchedEvidence']), local['operation'], local['path'])['classification'] == local['classification']
        expected = {(str(pathlib.Path(OUTSIDE_TARGET) / directory / ('gate-write-' + operation)), operation) for directory in ('objects', 'refs') for operation in ('mkdir', 'open')}
        probes = local['storageProbes']
        assert len(probes) == 4 and {(row['path'], row['operation']) for row in probes} == expected
        assert all(row['errno'] == errno.EROFS and row['refused'] is True for row in probes)
        assert fixture['before'] and local['before'] == local['after'] == fixture['before'] == outside_after
        assert len(record['network']) == 2 and {row['operation'] for row in record['network']} == {'fetch', 'push'}
        for row in record['network']:
            assert row['asserted'] is True and row['exit'] != 0 and row['url'] == NETWORK_URL
            assert row['classification'] == 'network_unreachable' and classify_stderr('\n'.join(row['matchedEvidence']), row['operation'], row['url'])['classification'] == row['classification']
            probe = row['connectProbe']
            assert probe['address'] == '192.0.2.1' and probe['port'] == 9418 and probe['errno'] in (errno.ENETUNREACH, errno.EHOSTUNREACH) and probe['refused'] is True
    except (AssertionError, KeyError, TypeError):
        return False
    return True


if __name__ == '__main__':
    import sys
    root = pathlib.Path(sys.argv[1])
    entry_guard(root)
    subprocess.run(['ip', 'link', 'set', 'lo', 'up'], check=True, capture_output=True)
    prepare(root, sys.argv[2])
