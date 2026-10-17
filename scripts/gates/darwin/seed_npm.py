import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile

import seed_policy


LIFECYCLE = ('preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'preprepare', 'postprepare')
ALLOWED = {'esbuild': {'postinstall': 'node install.js'}, 'node-pty': {'install': 'node scripts/prebuild.js || node-gyp rebuild', 'postinstall': 'node scripts/post-install.js'}}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify_input(path, expected):
    if path.is_symlink() or not path.is_file() or digest(path) != expected:
        raise ValueError('seed input hash mismatch')


def scan_tarball(data):
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        members = archive.getmembers()
        roots = [m for m in members if m.isfile() and len(Path(m.name).parts) == 2 and Path(m.name).name == 'package.json']
        if len(roots) != 1:
            raise ValueError('seed package manifest ambiguous')
        package = json.load(archive.extractfile(roots[0]))
        scripts = {k: v for k, v in package.get('scripts', {}).items() if k in LIFECYCLE}
        for event, command in scripts.items():
            if event == 'prepare':
                continue
            if ALLOWED.get(package['name'], {}).get(event) != command:
                raise ValueError('unexpected dependency lifecycle: ' + package['name'] + ':' + event)
        gyp = [m.name for m in members if Path(m.name).name == 'binding.gyp']
        if gyp and (package['name'] != 'node-pty' or gyp != ['package/binding.gyp']):
            raise ValueError('unexpected binding.gyp')
        return {'name': package['name'], 'version': package['version'], 'lifecycle': scripts, 'bindingGyp': gyp, 'sha256': hashlib.sha256(data).hexdigest()}


def verify_cached(path, expected):
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != expected:
        raise ValueError('verified cache tarball changed')
    return scan_tarball(data)


def pack(root, target):
    cache = root / 'npm/_cacache'
    with tarfile.open(target, 'w', format=tarfile.USTAR_FORMAT) as archive:
        for path in [cache.parent, cache, *sorted(cache.rglob('*'))]:
            if path.is_symlink() or not (path.is_file() or path.is_dir()):
                raise ValueError('unsafe seed cache member')
            info = tarfile.TarInfo(path.relative_to(root).as_posix())
            info.uid = info.gid = info.mtime = 0
            info.uname = info.gname = ''
            info.mode = 0o755 if path.is_dir() else 0o644
            if path.is_dir():
                info.type = tarfile.DIRTYPE
                archive.addfile(info)
            else:
                info.size = path.stat().st_size
                with path.open('rb') as source:
                    archive.addfile(info, source)


def run(args):
    node = args.node.resolve(strict=True)
    npm = args.npm.resolve(strict=True)
    verify_input(node, args.node_sha256)
    verify_input(npm, args.npm_sha256)
    for path, expected in ((args.package, args.package_sha256), (args.lock, args.lock_sha256)):
        verify_input(path, expected)
    seed_policy.validate_lock(json.loads(args.lock.read_text()))
    package = json.loads(args.package.read_text())
    root_scripts = {k: v for k, v in package.get('scripts', {}).items() if k in LIFECYCLE}
    if root_scripts or package.get('workspaces'):
        raise ValueError('root lifecycle or workspaces need explicit review')
    root = args.root.absolute()
    root.mkdir(mode=0o700)
    if root.resolve(strict=True) != root:
        raise ValueError('seed root redirected')
    for name in ('src', 'h', 't', 'npm'):
        (root / name).mkdir(mode=0o700)
    (root / 'src/package.json').write_bytes(args.package.read_bytes())
    (root / 'src/package-lock.json').write_bytes(args.lock.read_bytes())
    for name in ('user.npmrc', 'global.npmrc'):
        (root / name).write_text('')
    env = {'PATH': str(node.parent) + ':/usr/local/bin:/usr/bin:/bin', 'HOME': str(root / 'h'), 'TMPDIR': str(root / 't'), 'LANG': 'C.UTF-8', 'NPM_CONFIG_USERCONFIG': str(root / 'user.npmrc'), 'NPM_CONFIG_GLOBALCONFIG': str(root / 'global.npmrc')}
    command = [str(node), str(npm), 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--include=dev', '--include=optional', '--os=darwin', '--cpu=arm64', '--cache=' + str(root / 'npm')]
    subprocess.run(command, cwd=root / 'src', env=env, check=True, timeout=600)
    verify_input(root / 'src/package.json', args.package_sha256)
    verify_input(root / 'src/package-lock.json', args.lock_sha256)
    verifier = Path(__file__).with_name('seed-cache-verify.mjs').resolve(strict=True)
    subprocess.run([str(node), str(verifier), str(root), str(npm)], cwd=root, env=env, check=True, timeout=120)
    inventory = json.loads((root / 'integrity.json').read_text())
    scans = [verify_cached(root / 'verified-tarballs' / row['file'], row['sha256']) for row in inventory]
    seen = {row['sha256'] for row in scans}
    for path in sorted((root / 'npm/_cacache/content-v2').rglob('*')):
        if path.is_file():
            data = path.read_bytes()
            if data.startswith(b'\x1f\x8b') and hashlib.sha256(data).hexdigest() not in seen:
                raise ValueError('unresolved extra cached tarball provenance')
    target = root / 'darwin-npm-seed.tar'
    cache_index_entries = seed_policy.audit_index(root / 'npm/_cacache')
    pack(root, target)
    report = {'version': 1, 'packageSha256': args.package_sha256, 'lockSha256': args.lock_sha256, 'nodeSha256': digest(node), 'npmCliSha256': digest(npm), 'nodeVersion': subprocess.check_output([str(node), '--version'], env=env, text=True).strip(), 'npmVersion': subprocess.check_output([str(node), str(npm), '--version'], env=env, text=True).strip(), 'rootLifecycle': root_scripts, 'registryPrepareOnlyAllowed': True, 'cacheIndexEntriesAudited': cache_index_entries, 'command': command, 'environmentKeys': sorted(env), 'integrity': inventory, 'tarballScan': scans, 'archive': str(target), 'archiveSha256': digest(target)}
    manifest = root / 'inventory-manifest.json'
    manifest.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'archive': str(target), 'archiveSha256': digest(target), 'inventory': str(manifest), 'inventorySha256': digest(manifest)}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ('node', 'npm', 'package', 'lock', 'root'):
        parser.add_argument('--' + name, type=Path, required=True)
    for name in ('package-sha256', 'lock-sha256', 'node-sha256', 'npm-sha256'):
        parser.add_argument('--' + name, required=True)
    run(parser.parse_args())

