import hashlib
import json
from pathlib import Path
import re
import stat
import subprocess


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def confined(path, root):
    path = Path(path)
    resolved = path.resolve(strict=True)
    if resolved != path.absolute() or root.resolve() not in resolved.parents:
        raise ValueError('native build path escapes or redirects')
    return resolved


def artifact_state(workspace, root, kind='delivery-file'):
    if kind not in ('delivery-file', 'peercred'):
        raise ValueError('unapproved native artifact')
    directory = workspace / 'dist/v2' / kind / 'darwin-arm64'
    source = confined(workspace / 'v2/daemon/native' / (kind + '.c'), root)
    binary = confined(directory / (kind + '.node'), root)
    manifest = confined(directory / 'manifest.json', root)
    data = json.loads(manifest.read_text())
    expected = {'version': 1, 'target': 'darwin-arm64', 'napi': 8, 'sourceSha256': digest(source), 'sha256': digest(binary)}
    if data != expected:
        raise ValueError('native manifest does not match source and binary')
    records = {}
    for path in (source, binary, manifest):
        info = path.stat()
        if not stat.S_ISREG(info.st_mode):
            raise ValueError('native artifact is not regular')
        records[str(path.relative_to(root))] = {'dev': info.st_dev, 'ino': info.st_ino, 'mode': info.st_mode, 'size': info.st_size, 'mtimeNs': info.st_mtime_ns, 'sha256': digest(path)}
    return {'manifest': data, 'files': records}


def build(root, workspace, tools, node, env, kind='delivery-file'):
    if kind not in ('delivery-file', 'peercred'):
        raise ValueError('unapproved native build')
    source = confined(workspace / 'v2/daemon/native' / (kind + '.c'), root)
    include = confined(Path(node).parent.parent / 'include/node', root)
    if kind == 'peercred' and len(source.read_text().rstrip().split('\n')) >= 200:
        raise ValueError('peercred bridge exceeds product source-line limit')
    directory = workspace / 'dist/v2' / kind / 'darwin-arm64'
    if directory.resolve() != directory.absolute() or root.resolve() not in directory.resolve().parents:
        raise ValueError('native output directory escapes or redirects before mkdir')
    directory.mkdir(parents=True, exist_ok=True)
    confined(directory, root)
    binary = directory / (kind + '.node')
    manifest = directory / 'manifest.json'
    if binary.exists() or manifest.exists() or binary.is_symlink() or manifest.is_symlink():
        raise ValueError('native build requires absent output')
    toolchain = Path(tools['toolchain'])
    version = re.search(r'clang version ([0-9]+)\.', (root / 'compiler-version.log').read_text())
    if version is None:
        raise ValueError('native compiler resource version unavailable')
    resource = toolchain / 'usr/lib/clang' / version.group(1)
    argv = ['/usr/bin/sandbox-exec', '-f', str(root / 'compiler.sb'), tools['clang'], '-fintegrated-cc1', '-ccc-install-dir', str(Path(tools['clang']).parent), '-resource-dir', str(resource), '-isysroot', tools['sdk'], '--ld-path=' + tools['ld'], '-Wl,-lto_library,' + str(toolchain / 'usr/lib/libLTO.dylib'), '-fmodules-cache-path=' + str(root / 'cache/clang'), '-DNAPI_VERSION=8', '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-bundle', '-undefined', 'dynamic_lookup', '-I' + str(include), str(source), '-o', str(binary)]
    with (root / ('native-build-' + kind + '.log')).open('xb') as output:
        result = subprocess.run(argv, cwd=workspace, env=env, stdout=output, stderr=subprocess.STDOUT, timeout=120)
    if result.returncode:
        raise ValueError('confined native compiler failed')
    data = {'version': 1, 'target': 'darwin-arm64', 'napi': 8, 'sourceSha256': digest(source), 'sha256': digest(confined(binary, root))}
    with manifest.open('x') as output:
        json.dump(data, output, sort_keys=True)
        output.write('\n')
    return {'argv': argv, 'compilerProfileSha256': digest(root / 'compiler.sb'), 'state': artifact_state(workspace, root, kind)}
