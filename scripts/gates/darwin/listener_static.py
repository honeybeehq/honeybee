import json
import hashlib
from pathlib import Path
import re
import sys


def arguments(text, start):
    depth = 1
    quote = None
    escaped = False
    parts = []
    begin = start
    for index in range(start, len(text)):
        char = text[index]
        if quote:
            if escaped:
                escaped = False
            elif char == '\\':
                escaped = True
            elif char == quote:
                quote = None
        elif char in "'\"`":
            quote = char
        elif char in '([{':
            depth += 1
        elif char in ')]}':
            depth -= 1
            if not depth:
                tail = text[begin:index].strip()
                return parts + ([tail] if tail else [])
        elif char == ',' and depth == 1:
            parts.append(text[begin:index].strip())
            begin = index + 1
    return None


def violations(text):
    rows = []
    for call in re.finditer(r'\.\s*(listen|bind)\s*\(', text):
        args = arguments(text, call.end())
        reason = None
        if args is None:
            reason = 'unresolved listen/bind syntax'
        elif any(re.search(r'''["'`](?:0\.0\.0\.0|::)["'`]''', arg) for arg in args):
            reason = 'wildcard host'
        elif call.group(1) == 'listen':
            if not args:
                reason = 'omitted host (zero-argument wrapper requires source audit)'
            elif args[0].startswith('{'):
                if not re.search(r'\bpath\s*:', args[0]) and not re.search(r'''\bhost\s*:\s*["'`](?:127(?:\.[0-9]+){3}|::1|localhost)["'`]''', args[0]):
                    reason = 'omitted or unresolved host in options'
            elif not (re.match(r'''["'`]/''', args[0]) or re.fullmatch(r'(?:[A-Za-z_$][\w$]*\.)?(?:socketPath|socket|path|local)', args[0])):
                if len(args) < 2 or not re.fullmatch(r'''["'`](?:127(?:\.[0-9]+){3}|::1|localhost)["'`]''', args[1]):
                    reason = 'omitted or unresolved IP host'
        elif call.group(1) == 'bind' and args and re.match(r'[0-9{]', args[0]):
            if len(args) < 2 or not re.fullmatch(r'''["'`](?:127(?:\.[0-9]+){3}|::1|localhost)["'`]''', args[1]):
                reason = 'omitted or unresolved UDP bind host'
        if reason:
            line = text.count('\n', 0, call.start()) + 1
            context = '\n'.join(text.splitlines()[max(0, line - 3):line + 2])
            normalized = re.sub(r'\s+', ' ', context).strip()
            rows.append({'line': line, 'reason': reason, 'call': text[call.start():call.end()], 'sha256': hashlib.sha256(normalized.encode()).hexdigest()})
    return rows


def scan(root, allowlist=None):
    rows = []
    for folder in ('v2', 'tests'):
        for path in sorted((root / folder).rglob('*')):
            if path.is_symlink() or not path.is_file() or path.suffix not in ('.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.py'):
                continue
            for row in violations(path.read_text()):
                rows.append(dict(row, file=path.relative_to(root).as_posix()))
    if allowlist is None:
        allowlist = json.loads(Path(__file__).with_name('listener-allowlist.json').read_text())['entries']
    indexed = {(row['file'], row['sha256']): row for row in rows}
    approved = {(row['file'], row['sha256']) for row in allowlist}
    remaining = [row for row in rows if (row['file'], row['sha256']) not in approved]
    for row in allowlist:
        if (row['file'], row['sha256']) not in indexed:
            remaining.append(dict(row, reason='audited Unix call fingerprint missing or changed'))
    return remaining


if __name__ == '__main__':
    rows = scan(Path(sys.argv[1]))
    print(json.dumps({'violations': rows}))
    sys.exit(bool(rows))
