import json
import hashlib
import ast
import ipaddress
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
    bind_module = bool(re.search(r'''(?:from\s*|require\s*\(\s*|import\s*(?:\(\s*)?)["'](?:node:)?dgram["']|\bimport\s+[^\n;]*\bsocket\b|\bfrom\s+socket\s+import\b''', text))
    for call in re.finditer(r'''(?<![\w])(?:\.\s*)?(listen|bind)\s*\(|\[\s*["'](listen|bind)["']\s*\]\s*\(''', text):
        operation = call.group(1) or call.group(2)
        if operation == 'bind' and not bind_module:
            continue
        args = arguments(text, call.end())
        if operation == 'bind' and args and args[0] in ('this', 'null', 'undefined'):
            continue
        reason = 'unresolved listen/bind target or omitted host'
        if args and literal_unix(args[0]):
            reason = None
        elif args and len(args) >= 2 and literal_loopback(args[1]):
            reason = None
        elif args and operation == 'bind':
            try:
                pair = ast.literal_eval(args[0])
            except (ValueError, SyntaxError):
                pair = None
            if isinstance(pair, tuple) and len(pair) >= 2 and isinstance(pair[0], str) and literal_loopback(repr(pair[0])):
                reason = None
        if args and any(re.search(r'''["'`](?:0\.0\.0\.0|::)["'`]''', arg) for arg in args):
            reason = 'wildcard host'
        if reason:
            line = text.count('\n', 0, call.start()) + 1
            context = '\n'.join(text.splitlines()[max(0, line - 3):line + 2])
            normalized = re.sub(r'\s+', ' ', context).strip()
            rows.append({'line': line, 'reason': reason, 'call': text[call.start():call.end()], 'sha256': hashlib.sha256(normalized.encode()).hexdigest()})
    return rows


def literal_unix(text):
    try:
        value = ast.literal_eval(text)
    except (ValueError, SyntaxError):
        return False
    return isinstance(value, str) and value.startswith('/') and '\0' not in value


def literal_loopback(text):
    try:
        value = ast.literal_eval(text)
        address = ipaddress.ip_address(value) if isinstance(value, str) else None
    except (ValueError, SyntaxError):
        return False
    return address is not None and ((address.version == 4 and address in ipaddress.ip_network('127.0.0.0/8')) or str(address) == '::1')


def source_fingerprint(text):
    return hashlib.sha256(re.sub(r'\s+', ' ', text).strip().encode()).hexdigest()


def scan(root, allowlist=None):
    rows = []
    for folder in ('v2', 'tests'):
        for path in sorted((root / folder).rglob('*')):
            if path.is_symlink():
                rows.append({'file': path.relative_to(root).as_posix(), 'reason': 'symlink source requires audit', 'sha256': ''})
                continue
            if not path.is_file():
                continue
            try:
                text = path.read_text()
            except UnicodeError:
                if re.search(rb'\b(?:listen|bind)\b', path.read_bytes()):
                    rows.append({'file': path.relative_to(root).as_posix(), 'reason': 'non-text source contains listen/bind', 'sha256': ''})
                continue
            if path.suffix not in ('.ts', '.mts', '.cts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.c', '.h', '.cc', '.cpp', '.rs', '.go', '.sh', '.bash', '.md', '.json', '.txt') and re.search(r'\b(?:listen|bind)\b', text):
                rows.append({'file': path.relative_to(root).as_posix(), 'reason': 'unknown extension contains listen/bind', 'sha256': source_fingerprint(text)})
            for row in violations(text):
                rows.append(dict(row, file=path.relative_to(root).as_posix()))
    if allowlist is None:
        allowlist = json.loads(Path(__file__).with_name('listener-allowlist.json').read_text())['entries']
    indexed = {(row['file'], row['sha256']): row for row in rows}
    approved = {(row['file'], row['sha256']) for row in allowlist if declaration_matches(root, row)}
    remaining = [row for row in rows if (row['file'], row['sha256']) not in approved]
    for row in allowlist:
        if (row['file'], row['sha256']) not in indexed or (row['file'], row['sha256']) not in approved:
            remaining.append(dict(row, reason='audited Unix call fingerprint missing or changed'))
    return remaining


def declaration_matches(root, row):
    declaration = row.get('receiverDeclaration', {})
    relative = Path(declaration.get('file', ''))
    if relative.is_absolute() or '..' in relative.parts:
        return False
    path = root / relative
    if not path.is_file() or not path.resolve().is_relative_to(root.resolve()):
        return False
    lines = path.read_text().splitlines()
    start, end = declaration.get('startLine', 0), declaration.get('endLine', 0)
    if not 0 < start <= end <= len(lines):
        return False
    digest = hashlib.sha256('\n'.join(lines[start - 1:end]).encode()).hexdigest()
    combined = hashlib.sha256((row['sha256'] + '\n' + digest).encode()).hexdigest()
    return digest == declaration.get('sha256') and combined == row.get('fingerprintSha256')


if __name__ == '__main__':
    rows = scan(Path(sys.argv[1]))
    print(json.dumps({'violations': rows}))
    sys.exit(bool(rows))
