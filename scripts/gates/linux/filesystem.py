import ctypes
import errno
import json
import os
import pathlib
import pty
import uuid


class MountAttr(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint64) for name in ('attr_set', 'attr_clr', 'propagation', 'userns_fd')]


def mount_readonly(path, readonly, recursive=False):
    libc = ctypes.CDLL(None, use_errno=True)
    attributes = MountAttr(1 if readonly else 0, 0 if readonly else 1, 0, 0)
    result = libc.syscall(ctypes.c_long(442), ctypes.c_int(-100), ctypes.c_char_p(os.fsencode(path)), ctypes.c_uint(0x8000 if recursive else 0), ctypes.byref(attributes), ctypes.sizeof(attributes))
    if result:
        raise OSError(ctypes.get_errno(), 'mount_setattr failed', str(path))


def seal_filesystem(root):
    mount_readonly('/', True, recursive=True)
    mount_readonly(root, False)
    mount_readonly('/proc', False)
    mount_readonly('/tmp', False)


def private_tmp(root):
    destination = os.stat('/tmp')
    matches = [path for path in (pathlib.Path(root) / 'lab-tmp').iterdir() if (path.stat().st_dev, path.stat().st_ino) == (destination.st_dev, destination.st_ino)]
    if len(matches) != 1:
        raise RuntimeError('/tmp is not a private run-root bind')
    return dict(source=str(matches[0]), destination='/tmp', device=destination.st_dev, inode=destination.st_ino)


def assert_filesystem(root, init_name='init.py'):
    root = str(root)
    temporary = private_tmp(root)
    mounts = []
    for line in pathlib.Path('/proc/self/mountinfo').read_text().splitlines():
        fields = line.split()
        target, options = fields[4], fields[5].split(',')
        writable = 'rw' in options
        allowed = target == root or target.startswith(root + '/') or target in ('/tmp', '/proc')
        if target == '/tmp':
            temporary['filesystem'] = line.split(' - ', 1)[1].split()[0]
        mounts.append(dict(path=target, options=options, writable=writable, allowedWritable=allowed))
        if writable and not allowed:
            raise RuntimeError('writable mount outside run root: ' + target)
    assert any(row['path'] == '/' and not row['writable'] for row in mounts)
    assert any(row['path'] == root and row['writable'] for row in mounts)
    proc = next(row for row in mounts if row['path'] == '/proc')
    proc_type = next(line.split(' - ', 1)[1].split()[0] for line in pathlib.Path('/proc/self/mountinfo').read_text().splitlines() if line.split()[4] == '/proc')
    init_argv = pathlib.Path('/proc/1/cmdline').read_bytes().split(b'\0')
    pidns = os.readlink('/proc/self/ns/pid')
    assert proc_type == 'proc' and proc['writable'], 'private procfs must be writable: ' + str(proc)
    assert os.readlink('/proc/1/ns/pid') == pidns, 'private procfs pid 1 namespace differs'
    assert os.fsencode(str(pathlib.Path(root) / init_name)) in init_argv, 'private procfs pid 1 argv differs: ' + repr(init_argv)
    return dict(asserted=True, uid=os.getuid(), gid=os.getgid(), mounts=mounts, writableRoot=root, privateTmp=temporary, privateProc=dict(filesystem=proc_type, writable=True, pid1Namespace=pidns, pid1Argv=[os.fsdecode(value) for value in init_argv if value], asserted=True))


def privilege_probe(operation):
    readfd, writefd = os.pipe()
    child = os.fork()
    if child == 0:
        os.close(readfd)
        libc = ctypes.CDLL(None, use_errno=True)
        row = dict(operation=operation, refused=False)
        try:
            if operation == 'unshare-mount':
                if libc.unshare(ctypes.c_int(0x10000000 | 0x00020000)) != 0:
                    raise OSError(ctypes.get_errno(), 'unshare refused')
                row['unshareSucceeded'] = True
            if operation == 'umount-tmp':
                if libc.umount2(b'/tmp', 0) != 0:
                    raise OSError(ctypes.get_errno(), 'umount refused')
            else:
                target = '/' if operation in ('remount-root-rw', 'unshare-mount') else '/proc'
                mount_readonly(target, False)
                mount_readonly(target, True)
        except OSError as error:
            row.update(errno=error.errno, refused=error.errno in (errno.EPERM, errno.EACCES, errno.EINVAL, errno.EROFS))
        os.write(writefd, json.dumps(row).encode())
        os._exit(0)
    os.close(writefd)
    with os.fdopen(readfd) as stream:
        row = json.load(stream)
    unused, status = os.waitpid(child, 0)
    row['childExit'] = os.waitstatus_to_exitcode(status)
    row['refused'] = row['refused'] and row['childExit'] == 0
    return row


def proc_probes():
    def snapshot():
        return {path.name:dict(inode=path.lstat().st_ino, device=path.lstat().st_dev, mode=path.lstat().st_mode) for path in pathlib.Path('/').iterdir()}
    before = snapshot()
    denied = []
    for path in ('/proc/sys/kernel/hostname', '/proc/sys/vm/swappiness'):
        try:
            fd = os.open(path, os.O_WRONLY)
        except OSError as error:
            denied.append(dict(path=path, operation='open-for-write', errno=error.errno, refused=error.errno in (errno.EACCES, errno.EPERM)))
        else:
            os.close(fd)
            denied.append(dict(path=path, operation='open-for-write', refused=False))
    after = snapshot()
    readfd, writefd = os.pipe()
    child = os.fork()
    if child == 0:
        os.close(readfd)
        row = dict(asserted=False)
        try:
            uid, gid = os.getuid(), os.getgid()
            libc = ctypes.CDLL(None, use_errno=True)
            if libc.unshare(ctypes.c_int(0x10000000)) != 0:
                raise OSError(ctypes.get_errno(), 'nested user namespace refused')
            pathlib.Path('/proc/self/setgroups').write_text('deny')
            pathlib.Path('/proc/self/uid_map').write_text(f'1000 {uid} 1')
            pathlib.Path('/proc/self/gid_map').write_text(f'1000 {gid} 1')
            row = dict(asserted=os.getuid() == os.getgid() == 1000, uid=os.getuid(), gid=os.getgid(), uidMap=pathlib.Path('/proc/self/uid_map').read_text(), gidMap=pathlib.Path('/proc/self/gid_map').read_text(), setgroups=pathlib.Path('/proc/self/setgroups').read_text())
        except OSError as error:
            row['errno'] = error.errno
        os.write(writefd, json.dumps(row).encode())
        os._exit(0)
    os.close(writefd)
    with os.fdopen(readfd) as stream:
        nested = json.load(stream)
    unused, status = os.waitpid(child, 0)
    nested['childExit'] = os.waitstatus_to_exitcode(status)
    return dict(asserted=all(row['refused'] for row in denied) and before == after and nested['asserted'] and nested['childExit'] == 0, sysctlWrites=denied, outsideStorage=dict(before=before, after=after, unchanged=before == after), nestedUserNamespace=nested)


def proc_receipt_valid(filesystem, root, namespace):
    try:
        state = filesystem['state']
        assert state['uid'] == state['gid'] == 1000
        proc = state['privateProc']
        assert proc['asserted'] is True and proc['filesystem'] == 'proc' and proc['writable'] is True
        assert proc['pid1Namespace'] == namespace and str(pathlib.Path(root) / 'init.py') in proc['pid1Argv']
        probes = filesystem['probes']['privateProc']
        assert probes['asserted'] is True
        denied = probes['sysctlWrites']
        assert len(denied) == 2 and {row['path'] for row in denied} == {'/proc/sys/kernel/hostname','/proc/sys/vm/swappiness'}
        assert all(row['refused'] is True and row['errno'] in (errno.EACCES, errno.EPERM) and row['operation'] == 'open-for-write' for row in denied)
        storage = probes['outsideStorage']
        assert storage['unchanged'] is True and storage['before'] and storage['before'] == storage['after']
        nested = probes['nestedUserNamespace']
        assert nested['asserted'] is True and nested['childExit'] == 0 and nested['uid'] == nested['gid'] == 1000
        assert nested['uidMap'].split() == nested['gidMap'].split() == ['1000','1000','1'] and nested['setgroups'].strip() == 'deny'
    except (AssertionError, KeyError, ValueError, TypeError, AttributeError):
        return False
    return True


def filesystem_probes(root, privilege_checks=True):
    nonce = uuid.uuid4().hex
    rows = []
    for path in ('/runners', '/hbl-' + nonce, '/etc/hbl-' + nonce):
        try:
            os.mkdir(path)
        except OSError as error:
            rows.append(dict(path=path, errno=error.errno, refused=error.errno in (errno.EACCES, errno.EROFS)))
        else:
            os.rmdir(path)
            rows.append(dict(path=path, errno=None, refused=False))
    control = pathlib.Path(root) / ('filesystem-control-' + nonce)
    control.mkdir()
    control.rmdir()
    temporary = private_tmp(root)
    name = 'hbl-private-' + nonce
    pathlib.Path('/tmp', name).write_bytes(b'private tmp gate probe')
    assert (pathlib.Path(temporary['source']) / name).read_bytes() == b'private tmp gate probe'
    with open('/dev/null', 'wb') as stream:
        stream.write(b'gate probe')
    with open('/dev/urandom', 'rb') as stream:
        random_ok = len(stream.read(16)) == 16
    master, slave = pty.openpty()
    try:
        pty_ok = os.isatty(master) and os.isatty(slave)
    finally:
        os.close(master)
        os.close(slave)
    privileges = [privilege_probe(operation) for operation in ('remount-proc-rw', 'remount-root-rw', 'umount-tmp', 'unshare-mount')] if privilege_checks else []
    proc = proc_probes() if privilege_checks else None
    return dict(asserted=all(row['refused'] for row in rows) and random_ok and pty_ok and all(row['refused'] for row in privileges) and (not privilege_checks or proc['asserted']), privilegeChecks=privilege_checks, privilegeProbes=privileges, privateProc=proc, mkdir=rows, runRootWritable=True, privateTmpWrite=dict(name=name, source=temporary['source'], observedUnderRunRoot=True), devNull=True, devUrandom=random_ok, ptyAllocation=pty_ok)
