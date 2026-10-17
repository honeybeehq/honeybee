import hashlib
import json
import os
import pathlib
import sys
import tarfile
import time
from home_guard import entry_guard
from filesystem import assert_filesystem, filesystem_probes

root = pathlib.Path(sys.argv[1])
ENTRY_GUARD = entry_guard(root)
label = sys.argv[2]
command = sys.argv[3:]
out = root / 'receipts' / label
config = json.loads((root / 'config.json').read_text())
proof = json.loads((out / 'mask-proof.json').read_text())
assert proof['maskAsserted'] and proof['insideAsserted'] and proof['outsideAssertion']['asserted']
assert os.environ['HIVE_REAL_HOME'] == os.environ['HOME']
assert not [key for key in os.environ if key.startswith(('HIVE_', 'APIARY_')) and key != 'HIVE_REAL_HOME']
version = label.split('-', 1)[0]
source = root / version


def save(name, value):
    (out / name).write_text(json.dumps(value, indent=2))

save('entry-guard-workload.json', ENTRY_GUARD)
filesystem = dict(state=assert_filesystem(root), probes=filesystem_probes(root))
save('filesystem-workload.json', filesystem)
assert filesystem['probes']['asserted']


def verify():
    manifest = json.loads((root / (version + '-manifest.json')).read_text())
    mismatches = []
    for entry in manifest:
        path = source / entry['path']
        if entry['type'] == 'symlink':
            match = path.is_symlink() and os.readlink(path) == entry['target']
        else:
            match = path.is_file() and not path.is_symlink() and hashlib.sha256(path.read_bytes()).hexdigest() == entry['sha256'] and path.stat().st_mode & 0o111 == entry['executable']
        if not match:
            mismatches.append(entry['path'])
    deps = source / 'node_modules'
    result = dict(sha=config['shas'][version], archiveSha256=hashlib.sha256(pathlib.Path(config['sourceArchives'][version]).read_bytes()).hexdigest(), files=len(manifest), mismatches=mismatches, nodeModulesExists=deps.is_dir(), nodeModulesSymlink=deps.is_symlink())
    save('source-verification.json', result)
    assert not mismatches and not deps.is_symlink()
    return result


save('workload-started.json', dict(command=command, at=time.time(), maskAssertedAt=proof['maskAssertedAt']))
if command == ['@prepare']:
    source.mkdir()
    archive = pathlib.Path(config['sourceArchives'][version])
    with tarfile.open(archive) as stream:
        stream.extractall(source, filter='data')
    manifest = []
    for path in sorted(source.rglob('*')):
        if path.is_symlink():
            manifest.append(dict(path=str(path.relative_to(source)), type='symlink', target=os.readlink(path)))
        elif path.is_file():
            manifest.append(dict(path=str(path.relative_to(source)), type='file', sha256=hashlib.sha256(path.read_bytes()).hexdigest(), executable=path.stat().st_mode & 0o111))
    (root / (version + '-manifest.json')).write_text(json.dumps(manifest))
    verify()
    sys.exit(0)
os.chdir(source)
verify()
if command == ['@verify']:
    assert (source / 'node_modules').is_dir()
    sys.exit(0)
if '--test' in command:
    path=source/command[-1]
    save('test-input.json',dict(path=command[-1],exists=path.is_file() and not path.is_symlink(),sha256=hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None))
if command[:2] == ['npm', 'ci']:
    archive = pathlib.Path(config['cacheArchive'])
    assert hashlib.sha256(archive.read_bytes()).hexdigest() == config['cacheSha256']
    cache = pathlib.Path(os.environ['HOME']) / '.npm'
    cache.mkdir()
    with tarfile.open(archive) as stream:
        members = stream.getmembers()
        assert all(member.isdir() or member.isfile() for member in members)
        assert all(pathlib.PurePosixPath(member.name).parts[0] == '_cacache' for member in members)
        stream.extractall(cache, filter='data')
    save('cache-seed.json', dict(source=config['cacheSource'], sha256=config['cacheSha256'], files=sum(member.isfile() for member in members), destination=str(cache), offline=True, audit=False, fund=False))
    os.environ.update(npm_config_offline='true', npm_config_audit='false', npm_config_fund='false', npm_config_cache=str(cache))
os.execvpe(command[0], command, os.environ)
