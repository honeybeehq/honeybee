import ctypes
import errno
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


def assert_filesystem(root):
    root = str(root)
    temporary = private_tmp(root)
    mounts = []
    for line in pathlib.Path('/proc/self/mountinfo').read_text().splitlines():
        fields = line.split()
        target, options = fields[4], fields[5].split(',')
        writable = 'rw' in options
        allowed = target == root or target.startswith(root + '/') or target == '/tmp'
        if target == '/tmp':
            temporary['filesystem'] = line.split(' - ', 1)[1].split()[0]
        mounts.append(dict(path=target, options=options, writable=writable, allowedWritable=allowed))
        if writable and not allowed:
            raise RuntimeError('writable mount outside run root: ' + target)
    assert any(row['path'] == '/' and not row['writable'] for row in mounts)
    assert any(row['path'] == root and row['writable'] for row in mounts)
    return dict(asserted=True, uid=os.getuid(), gid=os.getgid(), mounts=mounts, writableRoot=root, privateTmp=temporary)


def filesystem_probes(root):
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
    return dict(asserted=all(row['refused'] for row in rows) and random_ok and pty_ok, mkdir=rows, runRootWritable=True, privateTmpWrite=dict(name=name, source=temporary['source'], observedUnderRunRoot=True), devNull=True, devUrandom=random_ok, ptyAllocation=pty_ok)
