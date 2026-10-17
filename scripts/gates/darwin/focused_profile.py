import hashlib
import os
import re
from pathlib import Path
import stat


TEMPLATE = {'version': 1, 'fixturePrefix': 'fr-', 'profile': 'work/sandbox.sb', 'cellDir': 'work', 'cwd': 'work', 'writablePaths': [], 'scratchPaths': [], 'readerRoot': 'data', 'readerEntry': 'v2/daemon/tests/fixtures/delivery-file-reader.mjs'}


def materialize(template, temporary, fixture, profile, declaration=None):
    if template != TEMPLATE:
        raise ValueError('reviewed recipient template mismatch')
    temporary, fixture, profile = Path(temporary), Path(fixture), Path(profile)
    if not temporary.is_absolute() or temporary.resolve(strict=True) != temporary or fixture.parent != temporary or not re.fullmatch(r'fr-[A-Za-z0-9]{6}', fixture.name) or fixture.resolve(strict=True) != fixture:
        raise ValueError('recipient fixture is not a canonical direct mkdtemp child')
    for path in (temporary, fixture, fixture / 'work', fixture / 'data'):
        if path.resolve(strict=True) != path or not path.is_dir() or stat.S_IMODE(path.stat().st_mode) != 0o700:
            raise ValueError('recipient fixture directory redirected or unsafe')
    if profile != fixture / TEMPLATE['profile'] or profile.resolve(strict=True) != profile:
        raise ValueError('recipient profile path differs from template')
    expected = {'cellDir': str(fixture / 'work'), 'writablePaths': [], 'scratchPaths': []}
    if declaration is not None and declaration != expected:
        raise ValueError('recipient declaration has extra or different allows')
    return {'policy': expected, 'cwd': str(fixture / 'work'), 'readerRoot': str(fixture / 'data'), 'fixtureRoot': str(fixture), 'profile': str(profile)}


def profile_state(path, expected):
    path = Path(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or stat.S_IMODE(before.st_mode) != 0o600:
            raise ValueError('recipient profile must be a private singly linked regular file')
        content = b''
        while True:
            block = os.read(fd, 65536)
            if not block:
                break
            content += block
            if len(content) > 1048576:
                raise ValueError('recipient profile exceeds bound')
        after = os.fstat(fd)
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_nlink) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_nlink) or (path.lstat().st_dev, path.lstat().st_ino, path.lstat().st_mode, path.lstat().st_nlink) != (before.st_dev, before.st_ino, before.st_mode, before.st_nlink) or path.resolve(strict=True) != path or content != expected:
            raise ValueError('recipient profile differs from production template render or changed')
        return {'path': str(path), 'sha256': hashlib.sha256(content).hexdigest(), 'dev': before.st_dev, 'inode': before.st_ino, 'mtimeNs': before.st_mtime_ns, 'nlink': before.st_nlink, 'size': before.st_size}
    finally:
        os.close(fd)



def parse_node_observation(output, node):
    lines = output.splitlines()
    prefixes = ('NODE ', 'ENTRY ', 'CWD ', 'SANDBOX ')
    if len(lines) < 4 or not all(line.startswith(prefix) for line, prefix in zip(lines[:4], prefixes)):
        raise ValueError('Node argv/cwd/sandbox observation incomplete')
    values = [line[len(prefix):] for line, prefix in zip(lines[:4], prefixes)]
    flags = []
    for line in lines[4:]:
        match = re.fullmatch(r'FLAG (--[a-z0-9-]{1,92}) ([^\s]{1,2048})', line)
        if match is None:
            raise ValueError('Node flag observation malformed')
        flags.append({'name': match.group(1), 'value': match.group(2)})
    if values[0] != node or values[3] not in ('0', '1') or not all(Path(value).is_absolute() for value in values[:3]):
        raise ValueError('Node observation differs from pinned executable or is ambiguous')
    return {'node': values[0], 'entry': values[1], 'cwd': values[2], 'sandboxed': values[3] == '1', 'flags': flags}


def parse_write_policy(output):
    if output.splitlines() != ['CELL 0', 'CONTENT 1', 'SEALED 1']:
        raise ValueError('live sandbox write policy differs from template or is unobserved')
    return {'cellDir': 'allowed', 'deliveryContent': 'denied', 'sealedRoot': 'denied'}
