import hashlib
import os
from pathlib import Path
import subprocess
import tarfile

VERSION = '24.18.0'
ARCHIVE = 'node-v' + VERSION + '-darwin-arm64.tar.gz'
URL = 'https://nodejs.org/dist/v' + VERSION + '/' + ARCHIVE
SHA256 = 'e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1'
TOP = ARCHIVE[:-7]


def extract_verified(archive, destination, expected=SHA256):
    if hashlib.sha256(Path(archive).read_bytes()).hexdigest() != expected:
        raise ValueError('Node archive sha256 mismatch; nothing extracted')
    destination = Path(destination)
    with tarfile.open(archive, 'r:gz') as source:
        members = source.getmembers()
        names = set()
        for member in members:
            path = Path(member.name)
            if path.is_absolute() or '..' in path.parts or not path.parts or path.parts[0] != TOP or path.as_posix() in names:
                raise ValueError('unsafe Node archive path')
            names.add(path.as_posix())
            if not (member.isdir() or member.isfile() or member.issym()):
                raise ValueError('unsafe Node archive type')
            if member.issym():
                target = Path(member.linkname)
                resolved = (destination / path.parent / target).resolve()
                base = (destination / TOP).resolve()
                if target.is_absolute() or (resolved != base and base not in resolved.parents):
                    raise ValueError('unsafe Node archive link')
        links = {Path(m.name) for m in members if m.issym()}
        if any(parent in links for m in members for parent in Path(m.name).parents):
            raise ValueError('Node archive traverses a link')
        destination.mkdir()
        for member in members:
            path = destination / member.name
            if member.isdir():
                path.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                path.parent.mkdir(parents=True, exist_ok=True)
                with source.extractfile(member) as src, path.open('xb') as dst:
                    dst.write(src.read())
                path.chmod(member.mode & 0o755)
        for member in members:
            if member.issym():
                path = destination / member.name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.symlink_to(member.linkname)
    node = destination / TOP / 'bin/node'
    if not node.is_file() or node.is_symlink() or not os.access(node, os.X_OK):
        raise ValueError('verified Node archive lacks executable')
    return str(node.resolve())


def download(root, env):
    archive = root / ARCHIVE
    with archive.open('xb'):
        pass
    command = ['/usr/bin/curl', '--disable', '--proto', '=https', '--tlsv1.2', '--fail', '--silent', '--show-error', '--max-time', '180', '--output', str(archive), URL]
    result = subprocess.run(command, env=env, capture_output=True)
    (root / 'node-download.log').write_bytes(result.stdout + result.stderr)
    result.check_returncode()
    return extract_verified(archive, root / 'node-distribution')
