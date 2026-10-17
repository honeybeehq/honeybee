import json
import os
from pathlib import Path
import stat
import subprocess


def regular(path, workspace):
    if path.resolve(strict=True) != path.absolute() or workspace not in path.parents or not stat.S_ISREG(path.lstat().st_mode):
        raise ValueError('dependency readiness path redirected or non-regular')
    return path


def check(workspace):
    workspace = workspace.resolve(strict=True)
    modules = workspace / 'node_modules'
    wrapper = regular(modules / 'esbuild/package.json', workspace)
    platform = regular(modules / '@esbuild/darwin-arm64/package.json', workspace)
    if any(json.loads(path.read_text())['version'] != '0.27.7' for path in (wrapper, platform)):
        raise ValueError('esbuild package version mismatch')
    binary = regular(modules / '@esbuild/darwin-arm64/bin/esbuild', workspace)
    if not os.access(binary, os.X_OK):
        raise ValueError('esbuild binary not executable')
    result = subprocess.run([str(binary), '--version'], capture_output=True, text=True, timeout=5)
    if result.returncode or result.stdout.strip() != '0.27.7':
        raise ValueError('esbuild binary version probe failed')
    pty = modules / 'node-pty'
    if pty.exists() or pty.is_symlink():
        if pty.resolve(strict=True) != pty.absolute() or not pty.is_dir():
            raise ValueError('optional node-pty redirected')
        regular(pty / 'package.json', workspace)
        status = 'present; install scripts disabled; not built or loaded'
    else:
        status = 'absent optional; unused'
    return {'ok': True, 'esbuildVersion': '0.27.7', 'esbuildBinary': str(binary), 'nodePty': status, 'installScripts': 'disabled'}


if __name__ == '__main__':
    result = check(Path.cwd())
    destination = Path(os.environ['GATE_ROOT']) / 'focused-dependency-readiness.json'
    with destination.open('x') as output:
        json.dump(result, output, indent=2)
