import errno
import os
from pathlib import Path
import stat


DIRECTORIES = ('Library/LaunchAgents', 'Library/Keychains', '.ssh', '.gnupg')
PROVIDER_ROOTS = ('.claude', '.codex', '.grok', '.kimi', '.gemini', '.cursor', '.muse', '.config/opencode', '.config/muse')
CONFIG_NAMES = ('.claude.json', 'config.toml', 'mcp.json', 'opencode.json', 'opencode.jsonc', 'settings.json', 'tui.toml')
FILES = ('.gitconfig', '.zshrc', '.zprofile', '.bashrc', '.profile', '.claude.json') + tuple(root + '/' + name for root in PROVIDER_ROOTS for name in CONFIG_NAMES)


def metadata(info):
    return {'dev': info.st_dev, 'ino': info.st_ino, 'mode': info.st_mode, 'uid': info.st_uid, 'gid': info.st_gid, 'size': info.st_size, 'mtimeNs': info.st_mtime_ns, 'type': stat.S_IFMT(info.st_mode)}


def inaccessible(error):
    if error.errno in (errno.EPERM, errno.EACCES):
        return {'unobservable': True, 'errno': error.errno}
    if error.errno == errno.ENOENT:
        return {'absent': True}
    raise error


def snapshot(home):
    rows = {}
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    home_fd = os.open(home, flags)
    try:
        for relative in sorted(set(DIRECTORIES + FILES)):
            parts = Path(relative).parts
            fd = os.dup(home_fd)
            try:
                for part in parts[:-1]:
                    child = os.open(part, flags, dir_fd=fd)
                    os.close(fd)
                    fd = child
                info = os.stat(parts[-1], dir_fd=fd, follow_symlinks=False)
                rows[relative] = metadata(info)
                if relative in DIRECTORIES and stat.S_ISDIR(info.st_mode):
                    child = os.open(parts[-1], flags, dir_fd=fd)
                    try:
                        opened = os.fstat(child)
                        if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                            raise ValueError('sentinel directory changed while opening')
                        try:
                            names = sorted(os.listdir(child))
                        except OSError as error:
                            rows[relative].update(inaccessible(error))
                            names = []
                        for name in names:
                            try:
                                rows[relative + '/' + name] = metadata(os.stat(name, dir_fd=child, follow_symlinks=False))
                            except OSError as error:
                                rows[relative + '/' + name] = inaccessible(error)
                    finally:
                        os.close(child)
            except OSError as error:
                rows[relative] = inaccessible(error)
            finally:
                os.close(fd)
    finally:
        os.close(home_fd)
    return rows
