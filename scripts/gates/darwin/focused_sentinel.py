import os
from pathlib import Path
import stat


def metadata(info):
    return {'dev': info.st_dev, 'ino': info.st_ino, 'mode': info.st_mode, 'uid': info.st_uid, 'gid': info.st_gid, 'size': info.st_size, 'mtimeNs': info.st_mtime_ns, 'type': stat.S_IFMT(info.st_mode)}


def snapshot(home, relative_roots):
    rows = {}
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    home_fd = os.open(home, flags)
    try:
        for relative in sorted(set(relative_roots)):
            parts = Path(relative).parts
            if not parts or Path(relative).is_absolute() or '..' in parts:
                raise ValueError('unsafe sentinel root')
            fd = os.dup(home_fd)
            try:
                missing = False
                for part in parts:
                    try:
                        child = os.open(part, flags, dir_fd=fd)
                    except FileNotFoundError:
                        rows[relative] = {'absent': True}
                        missing = True
                        break
                    os.close(fd)
                    fd = child
                if not missing:
                    rows[relative] = metadata(os.fstat(fd))
                    descend(fd, relative, rows, flags)
            finally:
                os.close(fd)
    finally:
        os.close(home_fd)
    return rows


def descend(fd, prefix, rows, flags):
    for name in sorted(os.listdir(fd)):
        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
        key = prefix + '/' + name
        rows[key] = metadata(info)
        if stat.S_ISDIR(info.st_mode):
            child = os.open(name, flags, dir_fd=fd)
            try:
                opened = os.fstat(child)
                if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                    raise ValueError('sentinel directory changed while opening')
                descend(child, key, rows, flags)
            finally:
                os.close(child)
