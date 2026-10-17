import hashlib
import json
from pathlib import Path
import re


FILES = ('v2/daemon/tests/delivery-file.test.ts', 'v2/daemon/tests/delivery-file-read.test.ts', 'v2/daemon/tests/multiline-fallback-tmux.test.ts')
EXECUTABLES = {'node', 'production-sandbox-exec', 'production-wrapWithSandbox', 'delivery-file-reader', 'build-refused-prebuilt-only'}
PACKAGES = {'ajv/dist/2020.js', 'jsonc-parser', 'smol-toml'}
SHA = re.compile(r'[0-9a-f]{64}')
NATIVE_ARTIFACTS = {'src/dist/v2/delivery-file/darwin-arm64/delivery-file.node', 'src/dist/v2/peercred/darwin-arm64/peercred.node'}
NODE_ENTRIES = {'reader': 'v2/daemon/tests/fixtures/delivery-file-reader.mjs', 'test-runner': FILES[1], 'runner-host-main': 'v2/driver-hsr/src/runner-host-main.ts'}


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


def validate_gate_pins(workspace, pins):
    exact_keys(pins, ('manifestSha256', 'preloaderSha256'))
    for key, name in (('manifestSha256', 'focused-manifest.json'), ('preloaderSha256', 'focused-preload.mjs')):
        expected = pins[key]
        if not isinstance(expected, str) or not SHA.fullmatch(expected) or hashlib.sha256(pinned_path(workspace, 'scripts/gates/darwin/' + name).read_bytes()).hexdigest() != expected:
            raise ValueError('reviewed gate pin drift')


def validate(workspace, audit_path):
    audit_file = pinned_path(workspace, audit_path)
    data = json.loads(audit_file.read_text())
    exact_keys(data, ('version', 'files', 'spawns', 'packages', 'capabilityReferences', 'nativeEdges', 'entryPins', 'gatePins', 'nodeEntries'))
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
    validate_gate_pins(workspace, data['gatePins'])
    node_roles = set()
    if not isinstance(data['nodeEntries'], list) or len(data['nodeEntries']) != 3:
        raise ValueError('exactly three Node entry roles required')
    for row in data['nodeEntries']:
        exact_keys(row, ('role', 'path', 'sha256'))
        if row['role'] not in NODE_ENTRIES or row['role'] in node_roles or row['path'] not in closure:
            raise ValueError('invalid or duplicate Node entry role')
        if row['path'] != NODE_ENTRIES[row['role']]:
            raise ValueError('Node entry role path mismatch')
        pin = next(item for item in data['files'] if item['path'] == row['path'])
        if row['sha256'] != pin['sha256']:
            raise ValueError('Node entry hash differs from closure pin')
        node_roles.add(row['role'])
    roles = set()
    if not isinstance(data['entryPins'], list):
        raise ValueError('entryPins array required')
    for row in data['entryPins']:
        exact_keys(row, ('path', 'line', 'context', 'role'))
        citation(row, files, closure)
        if row['role'] not in ('production-sandbox-exec', 'reader-entry') or row['role'] in roles:
            raise ValueError('unapproved or duplicate entry pin role')
        roles.add(row['role'])
    if roles != {'production-sandbox-exec', 'reader-entry'}:
        raise ValueError('required entry pin missing')
    sites = set()
    for row in data['spawns']:
        if not isinstance(row, dict):
            raise ValueError('invalid spawn audit record')
        keys = ('path', 'line', 'context', 'executable', 'receiver', 'manualReview')
        exact_keys(row, (*keys, 'prebuiltGuard') if row.get('executable') == 'build-refused-prebuilt-only' else keys)
        if row['executable'] not in EXECUTABLES or not isinstance(row['receiver'], str) or not row['receiver'].strip():
            raise ValueError('unapproved sibling executable or missing receiver audit')
        if type(row['manualReview']) is not bool:
            raise ValueError('spawn manualReview boolean required')
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
    reference_sites = set()
    for row in data['capabilityReferences']:
        keys = ('kind', 'path', 'line', 'context', 'module', 'manualReview')
        exact_keys(row, (*keys, 'callee', 'executable', 'runtime', 'reachabilityProof') if row.get('kind') == 'unreachable-callsite' else keys)
        if row['kind'] not in ('import', 'binding', 'reference', 'unreachable-callsite') or row['manualReview'] is not True or not isinstance(row['module'], str) or not row['module']:
            raise ValueError('invalid capability citation')
        citation(row, files, closure)
        site = (row['path'], row['line'], row['module'], row['kind'])
        if site in reference_sites:
            raise ValueError('duplicate capability citation')
        reference_sites.add(site)
        if row['kind'] == 'unreachable-callsite':
            if row['runtime'] != 'forbidden' or not all(isinstance(row[key], str) and row[key] for key in ('callee', 'executable')) or not isinstance(row['reachabilityProof'], list) or not row['reachabilityProof']:
                raise ValueError('unreachable callsite requires forbidden runtime and proof')
            for proof in row['reachabilityProof']:
                if not isinstance(proof, str) or not re.fullmatch(r'[^:]+:[1-9][0-9]*', proof):
                    raise ValueError('invalid reachability proof citation')
                name, number = proof.rsplit(':', 1)
                if name not in files or int(number) > len(files[name].splitlines()):
                    raise ValueError('reachability proof outside pinned files')
    edges = data['nativeEdges']
    if not isinstance(edges, list) or len(edges) != 2 or not all(isinstance(row, dict) and isinstance(row.get('artifact'), str) for row in edges) or {row['artifact'] for row in edges} != NATIVE_ARTIFACTS:
        raise ValueError('nativeEdges must name exactly the two distinct approved artifacts')
    for row in edges:
        exact_keys(row, ('kind', 'path', 'line', 'context', 'artifact', 'sha256Source'))
        citation(row, files, closure)
        if row['kind'] != 'native-artifact' or row['sha256Source'] != 'controller-manifest' or row['artifact'] not in NATIVE_ARTIFACTS:
            raise ValueError('unapproved native artifact edge')
    return {**data, 'schemaVersion': 1, 'auditSha256': hashlib.sha256(audit_file.read_bytes()).hexdigest()}


def citation(row, files, closure):
    if row['path'] not in closure or type(row['line']) is not int or row['line'] < 1:
        raise ValueError('invalid capability source citation')
    lines = files[row['path']].splitlines()
    if row['line'] > len(lines) or row['context'] != lines[row['line'] - 1]:
        raise ValueError('capability context drift')
