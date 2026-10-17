import hashlib
import os
from pathlib import Path
import stat
import subprocess


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def copy_descriptor(descriptor, target, expected):
    before = os.fstat(descriptor)
    if not stat.S_ISREG(before.st_mode) or before.st_size > 1073741824:
        raise ValueError('sealed source is non-regular or exceeds bound')
    target.parent.mkdir(parents=True, exist_ok=True)
    hashed = hashlib.sha256()
    size = 0
    with target.open('xb') as outgoing:
        while True:
            block = os.read(descriptor, 1048576)
            if not block:
                break
            size += len(block)
            if size > 1073741824:
                raise ValueError('sealed source grew beyond bound')
            hashed.update(block)
            outgoing.write(block)
    actual = hashed.hexdigest()
    after = os.fstat(descriptor)
    fields = lambda info: (info.st_dev, info.st_ino, info.st_mode, info.st_size, info.st_mtime_ns)
    if fields(before) != fields(after) or size != before.st_size or expected is not None and actual != expected:
        raise ValueError('sealed source changed or differs from reviewed pin')
    target.chmod(stat.S_IMODE(before.st_mode))
    if digest(target) != actual or target.stat().st_nlink != 1:
        raise ValueError('sealed destination differs from independent copy')
    return actual


def directory_descriptor(path):
    path = Path(path)
    if not path.is_absolute():
        raise ValueError('sealed source directory must be absolute')
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    descriptor = os.open('/', flags)
    try:
        for part in path.parts[1:]:
            child = os.open(part, flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def copy_file(source, target, expected=None):
    parent = directory_descriptor(source.parent)
    descriptor = None
    try:
        try:
            descriptor = os.open(source.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        except OSError as error:
            raise ValueError('sealed source redirected or unavailable') from error
        return copy_descriptor(descriptor, target, expected)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        os.close(parent)


def copy_dependencies(source, target, expected=None):
    descriptor = directory_descriptor(source)
    source = Path(source)
    target.mkdir()
    seen = set()
    directories = [0]
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW

    def descend(fd, relative, depth):
        directories[0] += 1
        if depth > 128 or directories[0] > 100000:
            raise ValueError('sealed dependency directory bound exceeded')
        destination = target / relative
        destination.mkdir(exist_ok=True)
        for name in sorted(os.listdir(fd)):
            key = str(relative / name)
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            copied = destination / name
            if stat.S_ISLNK(info.st_mode):
                link = os.readlink(name, dir_fd=fd)
                if expected is not None and expected.get(key) != {'link': link}:
                    raise ValueError('dependency link differs from memory pin')
                resolved = (source / relative / name).resolve(strict=True)
                if source not in resolved.parents or os.path.isabs(link):
                    raise ValueError('dependency link escapes sealed copy')
                copied.symlink_to(link)
                seen.add(key)
            elif stat.S_ISREG(info.st_mode):
                pin = expected.get(key) if expected is not None else None
                if expected is not None and (not pin or set(pin) != {'sha256'}):
                    raise ValueError('dependency file absent from memory pins')
                child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                try:
                    copy_descriptor(child, copied, pin['sha256'] if pin else None)
                finally:
                    os.close(child)
                seen.add(key)
            elif stat.S_ISDIR(info.st_mode):
                child = os.open(name, flags, dir_fd=fd)
                try:
                    opened = os.fstat(child)
                    if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                        raise ValueError('dependency directory changed while opening')
                    descend(child, relative / name, depth + 1)
                finally:
                    os.close(child)
            else:
                raise ValueError('non-regular sealed dependency')
    try:
        descend(descriptor, Path(), 0)
        if expected is not None and seen != set(expected):
            raise ValueError('sealed dependency inventory differs from memory pins')
    finally:
        os.close(descriptor)


def prepare(root, workspace, node, audit, controls, native, dependencies):
    sealed = root / 'sealed-target'
    sealed.mkdir(mode=0o700)
    destination = sealed / 'src'
    destination.mkdir()
    for row in audit['files']:
        if row['siblingClosure']:
            copy_file(workspace / row['path'], destination / row['path'], row['sha256'])
    for name in ('focused-preload.mjs', 'focused-manifest.json', 'focused-render-profile.mjs', 'start_wait.py'):
        source = workspace / 'scripts/gates/darwin' / name
        target = destination / 'scripts/gates/darwin' / name
        expected = controls[str(source)][-1]
        if target.exists():
            if digest(target) != expected:
                raise ValueError('sealed gate control differs from original pin')
        else:
            copy_file(source, target, expected)
    for kind in ('delivery-file', 'peercred'):
        for relative in ('v2/daemon/native/' + kind + '.c', 'dist/v2/' + kind + '/darwin-arm64/' + kind + '.node', 'dist/v2/' + kind + '/darwin-arm64/manifest.json'):
            target = destination / relative
            source = workspace / relative
            expected = native[kind]['files'][str(source.relative_to(root))]['sha256']
            if target.exists():
                if digest(target) != expected:
                    raise ValueError('sealed native artifact differs from controller pin')
            else:
                copy_file(source, target, expected)
    for name in ('scope', 'workload.sb', 'compiler.sb'):
        copy_file(root / name, sealed / 'control' / name, controls[str(root / name)][-1])
    copy_dependencies(workspace / 'node_modules', destination / 'node_modules', dependencies)
    copied_node = sealed / 'node/bin/node'
    copy_file(Path(node), copied_node, controls[str(Path(node))][-1])
    return sealed, destination, str(copied_node)


def root_users(root, output, controller_pid):
    root = str(root.resolve(strict=True))
    pid = None
    rows = []
    for line in output.splitlines():
        if not line:
            continue
        if line[0] == 'p':
            if not line[1:].isdigit():
                raise ValueError('malformed same-uid process observation')
            pid = int(line[1:])
        elif line[0] == 'n' and pid != controller_pid:
            path = line[1:]
            if path == root or path.startswith(root + '/'):
                rows.append({'pid': pid, 'path': path})
    if pid is None:
        raise ValueError('same-uid root-use observation absent')
    return rows


class BusyRoot(ValueError):
    def __init__(self, rows):
        self.rows = rows
        super().__init__('another same-uid process retains run-root access: ' + str(rows))


def require_quiescent(root):
    observed = subprocess.run(['/usr/sbin/lsof', '-nP', '-a', '-u', str(os.getuid()), '-Fpn'], cwd='/', env={'PATH': '/usr/bin:/bin', 'LANG': 'C'}, capture_output=True, text=True, timeout=2)
    if observed.returncode != 0 or observed.stderr:
        raise ValueError('same-uid root-use observation unresolved')
    rows = root_users(root, observed.stdout, os.getpid())
    if rows:
        raise BusyRoot(rows)
    return rows
