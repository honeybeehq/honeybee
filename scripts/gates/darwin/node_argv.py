import json
import os
from pathlib import Path
import re
import stat


REPORT = 'node-default-argv-self-test.json'


def validate_flags(flags):
    if not isinstance(flags, list) or len(flags) > 128 or not all(isinstance(value, str) for value in flags):
        raise ValueError('procargs_read')
    expected = json.loads((Path(__file__).parent / 'node24-linux-argv.json').read_text())['flags']
    allowed = set(expected)
    names = json.loads((Path(__file__).parent / 'focused-manifest.json').read_text())['files'][1]['sibling']
    for name in names:
        pattern = '--test-name-pattern=^(?:' + re.escape(name) + ')$'
        allowed.update((pattern, pattern.replace('\\', '\\\\')))
    rows, unsupported = [], []
    for flag in flags:
        name, separator, value = flag.partition('=')
        safe_name = name if re.fullmatch(r'--[a-z0-9-]{1,92}', name) else 'invalid_name'
        if flag not in allowed:
            unsupported.append(safe_name)
            continue
        rows.append({'name': safe_name, 'value': 'reviewed-row-pattern' if name == '--test-name-pattern' else value if separator else 'true'})
    return {'ok': not unsupported, 'names': sorted(set(row['name'] for row in rows) | set(unsupported)), 'flags': rows, 'unsupportedNames': sorted(set(unsupported)), 'version': '24.18.0', 'source': 'real default-isolation Node child execArgv; no environment parsed'}


def receipt_report(root):
    try:
        fd = os.open(Path(root) / REPORT, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 65536:
            raise ValueError('invalid Node argv self-test evidence')
        data = json.loads(os.read(fd, 65537))
    finally:
        os.close(fd)
    if not isinstance(data, dict) or set(data) != {'ok', 'names', 'flags', 'unsupportedNames', 'version', 'source', 'platform', 'reviewedPatternCaptures'}:
        raise ValueError('Node argv self-test evidence schema')
    if type(data['reviewedPatternCaptures']) is not int or data['reviewedPatternCaptures'] != 2:
        raise ValueError('Node argv pattern capture count')
    if any(not isinstance(data[key], list) or len(data[key]) > 128 for key in ('flags', 'names', 'unsupportedNames')):
        raise ValueError('Node argv evidence collections')
    expected = json.loads((Path(__file__).parent / 'node24-linux-argv.json').read_text())['flags']
    pairs = {(flag.partition('=')[0], 'reviewed-row-pattern' if flag.startswith('--test-name-pattern=') else flag.partition('=')[2] if '=' in flag else 'true') for flag in expected}
    for row in data['flags']:
        if not isinstance(row, dict) or set(row) != {'name', 'value'} or not isinstance(row['name'], str) or not isinstance(row['value'], str) or (row['name'], row['value']) not in pairs:
            raise ValueError('unapproved Node argv value in evidence')
    if data['platform'] not in ('linux', 'darwin') or data['version'] != '24.18.0' or not isinstance(data['ok'], bool) or any(not isinstance(name, str) or not re.fullmatch(r'--[a-z0-9-]{1,92}|invalid_name', name) for key in ('names', 'unsupportedNames') for name in data[key]) or data['source'] != 'real default-isolation Node child execArgv; no environment parsed':
        raise ValueError('unapproved Node argv evidence metadata')
    if data['ok'] != (not data['unsupportedNames']) or set(data['names']) != {row['name'] for row in data['flags']} | set(data['unsupportedNames']):
        raise ValueError('Node argv evidence verdict inconsistent')
    return data
