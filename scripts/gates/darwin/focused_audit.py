import hashlib
import json
from pathlib import Path
import re


FILES = ('v2/daemon/tests/delivery-file.test.ts', 'v2/daemon/tests/delivery-file-read.test.ts', 'v2/daemon/tests/multiline-fallback-tmux.test.ts')
EXECUTABLES = {'node', 'production-sandbox-exec', 'production-wrapWithSandbox', 'delivery-file-reader', 'build-refused-prebuilt-only'}
PACKAGES = {'ajv/dist/2020.js', 'jsonc-parser', 'smol-toml'}
SHA = re.compile(r'[0-9a-f]{64}')
SPAWN = re.compile(r'\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork|wrapWithSandbox)\s*\(')


def exact_keys(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise ValueError('audit schema mismatch')


def pinned_path(workspace, relative):
    if not isinstance(relative, str):
        raise ValueError('audit path must be text')
    path = Path(relative)
    if path.is_absolute() or '..' in path.parts or path.as_posix() != relative:
        raise ValueError('unsafe audit path')
    full = workspace / path
    if full.resolve(strict=True) != full.absolute() or workspace.resolve() not in full.resolve().parents or not full.is_file():
        raise ValueError('audit source redirected or outside workspace')
    return full


def validate(workspace, audit_path):
    audit_file = pinned_path(workspace, audit_path)
    data = json.loads(audit_file.read_text())
    exact_keys(data, ('version', 'files', 'spawns', 'packages'))
    if data['version'] != 1 or not isinstance(data['files'], list) or not isinstance(data['spawns'], list):
        raise ValueError('unsupported audit schema')
    files = {}
    closure = set()
    packages = {}
    for row in data['packages']:
        exact_keys(row, ('specifier', 'path', 'version', 'packageJson', 'packageJsonSha256', 'entrySha256'))
        if row['specifier'] not in PACKAGES or row['specifier'] in packages or not isinstance(row['version'], str) or not row['version']:
            raise ValueError('unapproved or duplicate bare package pin')
        if not all(isinstance(row[key], str) and SHA.fullmatch(row[key]) for key in ('packageJsonSha256', 'entrySha256')):
            raise ValueError('invalid bare package hash')
        for key in ('path', 'packageJson'):
            path = Path(row[key])
            if path.is_absolute() or '..' in path.parts or not path.parts or path.parts[0] != 'node_modules':
                raise ValueError('package pin outside run-root node_modules')
        packages[row['specifier']] = row
    for row in data['files']:
        exact_keys(row, ('path', 'sha256', 'siblingClosure'))
        if type(row['siblingClosure']) is not bool or (not row['siblingClosure'] and row['path'] not in (FILES[0], FILES[2])):
            raise ValueError('only outer-only manifest entries may be outside sibling closure')
        if not isinstance(row['sha256'], str) or not SHA.fullmatch(row['sha256']) or row['path'] in files:
            raise ValueError('invalid or duplicate source pin')
        path = pinned_path(workspace, row['path'])
        content = path.read_bytes()
        if hashlib.sha256(content).hexdigest() != row['sha256']:
            raise ValueError('audited source hash drift')
        files[row['path']] = content.decode('utf-8')
        if row['siblingClosure']:
            closure.add(row['path'])
    if not set(FILES).issubset(files):
        raise ValueError('audit must pin all three manifest files')
    sites = set()
    for row in data['spawns']:
        if not isinstance(row, dict):
            raise ValueError('invalid spawn audit record')
        keys = ('path', 'line', 'context', 'executable', 'receiver')
        exact_keys(row, (*keys, 'prebuiltGuard') if row.get('executable') == 'build-refused-prebuilt-only' else keys)
        if row['executable'] not in EXECUTABLES or not isinstance(row['receiver'], str) or not row['receiver'].strip():
            raise ValueError('unapproved sibling executable or missing receiver audit')
        if row['path'] not in closure or type(row['line']) is not int or row['line'] < 1:
            raise ValueError('invalid spawn citation')
        lines = files[row['path']].splitlines()
        if row['line'] > len(lines) or row['context'] != lines[row['line'] - 1]:
            raise ValueError('spawn context drift')
        if row['executable'] == 'build-refused-prebuilt-only':
            guard = row['prebuiltGuard']
            exact_keys(guard, ('path', 'line', 'context'))
            if guard['path'] != row['path'] or type(guard['line']) is not int or not 0 < guard['line'] < row['line']:
                raise ValueError('prebuilt guard must precede build spawn in the same file')
            if lines[guard['line'] - 1] != guard['context'] or not re.match(r'^\s*if\s*\(\s*process\.env\.SCG_DELIVERY_FILE_PREBUILT_ONLY\s*===\s*[\'\"]1[\'\"]\s*\)\s*throw\b', guard['context']):
                raise ValueError('prebuilt refusal guard drift or wrong guard syntax')
        site = (row['path'], row['line'])
        if site in sites:
            raise ValueError('duplicate spawn citation')
        sites.add(site)
    for path, text in files.items():
        if path not in closure:
            continue
        for number, line in enumerate(text.splitlines(), 1):
            if SPAWN.search(line) and (path, number) not in sites:
                raise ValueError('uncited spawn call')
        imports = re.findall(r'(?:from\s*|import\s*\(|require\s*\()\s*[\'\"]([^\'\"]+)[\'\"]', text)
        for relative in imports:
            if relative.startswith('node:'):
                continue
            if not relative.startswith('.'):
                if relative not in packages:
                    raise ValueError('bare package import lacks audited package pin')
                continue
            target = ((workspace / path).parent / relative).resolve()
            if workspace.resolve() not in target.parents:
                raise ValueError('relative import outside workspace')
            candidates = [target, target.with_suffix('.ts'), target.with_suffix('.mjs'), target.with_suffix('.js'), target / 'index.ts']
            found = [candidate for candidate in candidates if candidate.is_file()]
            if not found or not any(str(candidate.relative_to(workspace)) in closure for candidate in found):
                raise ValueError('relative import missing from audited closure')
    return {'schemaVersion': 1, 'auditSha256': hashlib.sha256(audit_file.read_bytes()).hexdigest(), 'files': data['files'], 'spawns': data['spawns'], 'packages': data['packages']}
