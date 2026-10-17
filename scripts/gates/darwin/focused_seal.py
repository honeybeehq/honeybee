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
    existed = sealed.exists() or sealed.is_symlink()
    sealed.mkdir(mode=0o700, exist_ok=True)
    if existed:
        validate_probe(root, initial=True)
    info = sealed.lstat()
    if not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o700 or info.st_uid != os.getuid() or sealed.resolve(strict=True) != sealed:
        raise ValueError('sealed directory is redirected or unsafe')
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
    lines = output.splitlines()
    if not lines or lines[-1] != 'COMPLETE':
        raise ValueError('same-uid root-use observation absent or incomplete')
    rows = []
    for line in lines[:-1]:
        parts = line.split('\t')
        if len(parts) != 2 or not parts[0].isdigit() or int(parts[0]) <= 0:
            raise ValueError('malformed same-uid process observation')
        pid, path = int(parts[0]), parts[1]
        if pid != controller_pid and (path == root or path.startswith(root + '/')):
            rows.append({'pid': pid, 'path': path})
    return rows


class BusyRoot(ValueError):
    def __init__(self, rows):
        self.rows = rows
        super().__init__('another same-uid process retains run-root access: ' + str(rows))


SEALED_PROBES = {}
GATE_LAUNCH_PIDS = set()
GATE_LAUNCH_BIRTHS = set()


def remember_launch(pid):
    GATE_LAUNCH_PIDS.add(int(pid))


def remember_birth(birth):
    if len(birth) != 4 or not all(str(value).isdigit() for value in birth):
        raise ValueError('malformed gate launch birth')
    GATE_LAUNCH_BIRTHS.add(tuple(map(str, birth)))
    remember_launch(birth[0])


ROOT_CREATION = {}
ROOT_INODES = {}
def fd_disclosure(count):
    return "fd introspection denied by MAC for " + str(count) + " same-uid sandboxed processes; accepted because each one's own sandbox denies read and write on the run root; an fd passed in over IPC by another process is not excluded."


def fd_write_disclosure(count):
    return str(count) + " same-uid sandboxed processes with MAC-denied fd introspection may READ the run root; each one's own sandbox denies write and create on all probed root paths; integrity relies on that write denial plus N1 before/after hashing; read access and an fd passed in over IPC are not excluded."


def fd_platform_disclosure(count):
    return str(count) + " same-uid Apple platform binaries with MAC-denied fd introspection were accepted by code-signing platform status and SIP-protected executable path; their open descriptors were not observed."


FD_UNOBSERVABLE_LIMIT = 'fdUnobservableSandboxDenied: fd-passing residual remains; sampled sandbox denial on the four probe paths does not prove that a pre-existing or passed descriptor cannot access another root path.'
UNLINKED_LIMIT = 'exeUnlinkedPreRoot accepted by birth-time; exec-after-birth of a since-unlinked root binary by a non-gate process is not excluded.'


def validate_probe(root, initial=False):
    key = str(root.resolve(strict=True))
    expected = SEALED_PROBES.get(key)
    if expected is None:
        raise ValueError('sealed probe creation identity unavailable')
    sealed = root / 'sealed-target'
    directory_info = sealed.lstat()
    file_info = (sealed / 'quiescence-probe').lstat()
    if (directory_info.st_dev, directory_info.st_ino, file_info.st_dev, file_info.st_ino) != expected or not stat.S_ISDIR(directory_info.st_mode) or stat.S_IMODE(directory_info.st_mode) != 0o700 or directory_info.st_uid != os.getuid() or sealed.resolve(strict=True) != sealed or not stat.S_ISREG(file_info.st_mode) or file_info.st_nlink != 1 or file_info.st_uid != os.getuid():
        raise ValueError('sealed probe identity or permissions changed')
    if initial and set(os.listdir(sealed)) != {'quiescence-probe'}:
        raise ValueError('sealed probe directory has extra entry')


def quiescence_input(root, helper):
    key = str(root.resolve(strict=True))
    stamp = ROOT_CREATION.get(key)
    if stamp is None:
        raise ValueError('run-root creation clock unavailable')
    sealed = root / 'sealed-target'
    probe = sealed / 'quiescence-probe'
    if key not in SEALED_PROBES:
        sealed.mkdir(mode=0o700)
        descriptor = os.open(probe, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            file_info = os.fstat(descriptor)
        finally:
            os.close(descriptor)
        directory_info = sealed.lstat()
        SEALED_PROBES[key] = (directory_info.st_dev, directory_info.st_ino, file_info.st_dev, file_info.st_ino)
    validate_probe(root)
    package = root / 'src/package.json'
    for path in (probe, package):
        if path.resolve(strict=True) != path or not stat.S_ISREG(path.lstat().st_mode):
            raise ValueError('quiescence probe is not canonical regular file')
    parent = root / 't'
    if parent.resolve(strict=True) != parent or not parent.is_dir():
        raise ValueError('quiescence absent probe parent unsafe')
    absent = parent / 'quiescence-must-not-exist'
    if absent.exists() or absent.is_symlink():
        raise ValueError('quiescence absent probe unexpectedly exists')
    inodes = ROOT_INODES.setdefault(key, set())
    def collect(descriptor, depth):
        if depth > 128:
            raise ValueError('root inode depth exceeds bound')
        for name in os.listdir(descriptor):
            info = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
            inodes.add((info.st_dev, info.st_ino))
            if len(inodes) > 1000000:
                raise ValueError('root inode inventory exceeds bound')
            if stat.S_ISDIR(info.st_mode):
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
                try:
                    opened = os.fstat(child)
                    if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                        raise ValueError('root inode directory changed')
                    collect(child, depth + 1)
                finally:
                    os.close(child)
    descriptor = directory_descriptor(root)
    try:
        info = os.fstat(descriptor)
        inodes.add((info.st_dev, info.st_ino))
        collect(descriptor, 0)
    finally:
        os.close(descriptor)
    text = str(len(inodes)) + '\n' + ''.join(str(dev) + ' ' + str(ino) + '\n' for dev, ino in sorted(inodes))
    text += str(len(GATE_LAUNCH_PIDS)) + '\n' + ''.join(str(pid) + '\n' for pid in sorted(GATE_LAUNCH_PIDS))
    return [str(helper), 'quiescence', str(os.getpid()), key, str(stamp['beforeMkdirNs'] // 1000), str(probe), str(package), str(absent)], text


def require_quiescent(root, helper):
    command, inventory = quiescence_input(root, helper)
    observed = subprocess.run(command, input=inventory, cwd='/', env={'PATH': '/usr/bin:/bin', 'LANG': 'C'}, capture_output=True, text=True, timeout=2)
    quiescence_evidence(observed)
    if observed.returncode != 0:
        raise ValueError('same-uid root-use observation unresolved')
    rows = root_users(root, observed.stdout, os.getpid())
    if rows:
        raise BusyRoot(rows)
    return rows


QUIESCENCE_OBSERVATIONS = []


def quiescence_evidence(result):
    import json
    evidence = {'exit': result.returncode, 'reason': None}
    if result.returncode or result.stderr:
        try:
            if len(result.stderr) > 4096:
                raise ValueError('oversized quiescence diagnostic')
            reason = json.loads(result.stderr)
            if set(reason) != {'type', 'call', 'errno', 'errnoNumber', 'sameBirth', 'counts', 'fdAllowedByQuery', 'fdFailedQueryResults', 'fdWriteDeniedReadResults'} or reason['type'] != ('QuiescenceFailure' if result.returncode else 'QuiescenceComplete'):
                raise ValueError('unexpected quiescence diagnostic schema')
            if reason['call'] not in ('root', 'allocation', 'proc_listpids', 'pidinfo vnode', 'pidpath', 'listfds', 'fdinfo', 'birth', 'none', 'unlinked policy', 'region inode') or reason['errno'] not in ('NONE', 'EPERM', 'EACCES', 'ESRCH', 'EBADF', 'ENOENT', 'EINVAL', 'ENOMEM', 'EINTR', 'OTHER'):
                raise ValueError('unexpected quiescence diagnostic value')
            if type(reason['errnoNumber']) is not int or type(reason['sameBirth']) is not int or reason['sameBirth'] not in (-1, 0, 3, 4):
                raise ValueError('unexpected quiescence numeric value')
            if set(reason['counts']) != {'scanned', 'skippedGone', 'skippedUidChanged', 'skippedFdClosed', 'matched', 'failed', 'exeUnlinkedPreRoot', 'regionCompared', 'regionUnavailable', 'sessionLeaderNotUidListed', 'fdUnobservableSandboxDenied', 'fdNonGateFailed', 'fdCleanFailed', 'fdSandboxFailed', 'fdDeniedQueries', 'fdAllowedQueries', 'fdQueryErrors', 'fdNotSandboxed', 'fdUnobservableWriteDenied', 'fdUnobservablePlatformBinary', 'notPlatform', 'pathDisallowed', 'csopsError', 'csopsUnavailable', 'inodeMatch', 'platformInodeUnobserved'} or any(type(value) is not int or value < 0 for value in reason['counts'].values()):
                raise ValueError('unexpected quiescence counts')
            slots = {'root:read', 'root:write', 'probe:read', 'probe:write', 'src:read', 'src:write', 'absent:read', 'absent:write', 'root:create', 'root:unlink', 'probe:create', 'probe:unlink', 'src:create', 'src:unlink', 'absent:create', 'absent:unlink'}
            if not isinstance(reason['fdAllowedByQuery'], dict) or set(reason['fdAllowedByQuery']) != slots or any(type(value) is not int or value < 0 for value in reason['fdAllowedByQuery'].values()):
                raise ValueError('unexpected fixed-slot query counts')
            if not isinstance(reason['fdFailedQueryResults'], list) or len(reason['fdFailedQueryResults']) != 16 or any(type(value) is not int or value not in (-2, -1, 0, 1) for value in reason['fdFailedQueryResults']):
                raise ValueError('unexpected anonymous query vector')
            reads = reason['fdWriteDeniedReadResults']
            if not isinstance(reads, dict) or set(reads) != {'root:read', 'probe:read', 'src:read', 'absent:read'} or any(not isinstance(row, dict) or set(row) != {'allowed', 'denied'} or any(type(value) is not int or value < 0 for value in row.values()) for row in reads.values()):
                raise ValueError('unexpected write-denied read diagnostics')
            evidence['reason'] = reason
        except (ValueError, TypeError, KeyError):
            evidence['reason'] = {'type': 'UnobservedQuiescenceFailure'}
    counts = evidence.get('reason', {}).get('counts', {}) if isinstance(evidence.get('reason'), dict) else {}
    evidence['fdUnobservablePlatformBinaryDisclosure'] = fd_platform_disclosure(counts.get('fdUnobservablePlatformBinary', 0))
    evidence['fdUnobservableWriteDeniedDisclosure'] = fd_write_disclosure(counts.get('fdUnobservableWriteDenied', 0))
    evidence['fdUnobservableDisclosure'] = fd_disclosure(counts.get('fdUnobservableSandboxDenied', 0))
    QUIESCENCE_OBSERVATIONS.append(evidence)
    return evidence
