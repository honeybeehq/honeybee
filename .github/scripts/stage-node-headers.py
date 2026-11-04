import os
import stat
import sys

source, destination = sys.argv[1:]
if not os.path.isabs(source) or not os.path.isabs(destination):
    raise ValueError('absolute staging paths required')
for directory, names, files in os.walk(source, followlinks=False):
    info = os.lstat(directory)
    if not stat.S_ISDIR(info.st_mode):
        raise ValueError('header directory is not regular')
    relative = os.path.relpath(directory, source)
    target = destination if relative == '.' else os.path.join(destination, relative)
    os.makedirs(target, mode=0o755, exist_ok=True)
    if not stat.S_ISDIR(os.lstat(target).st_mode) or os.path.realpath(target) != target:
        raise ValueError('unsafe header destination')
    os.chown(target, 0, 0)
    os.chmod(target, 0o755)
    for name in names:
        if not stat.S_ISDIR(os.lstat(os.path.join(directory, name)).st_mode):
            raise ValueError('symlink or special header directory refused')
    for name in files:
        path = os.path.join(directory, name)
        original = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            if not stat.S_ISREG(os.fstat(original).st_mode):
                raise ValueError('special header file refused')
            copied = os.open(os.path.join(target, name), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
            try:
                while data := os.read(original, 1024 * 1024):
                    remaining = memoryview(data)
                    while remaining:
                        remaining = remaining[os.write(copied, remaining):]
                os.fchown(copied, 0, 0)
                os.fchmod(copied, 0o644)
            finally:
                os.close(copied)
        finally:
            os.close(original)
