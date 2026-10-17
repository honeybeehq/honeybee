import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import subprocess
import sys
import uuid

from guard import environment, receipt_hashes, validate, write_json


def main():
    source = sys.argv[1]
    if not re.fullmatch('[0-9a-f]{40}', source) or sys.platform != 'darwin':
        raise ValueError('pinned Darwin source required')
    root = Path('/private/var/tmp/g.syntax-' + uuid.uuid4().hex[:8])
    home = Path(pwd.getpwuid(os.getuid()).pw_dir).resolve()
    env = environment(root, '/usr/bin/true')
    guard = validate(root, env, home)
    root.mkdir(mode=0o700)
    write_json(root / 'entry-guard.json', guard, root)
    print('GATE_ROOT=' + str(root), flush=True)
    q = json.dumps
    path = str(root / 'candidate.sock')
    regex = '#'+ q('^' + re.escape(str(root)) + '/')
    candidates = {
        'strict-network-deny': '',
        'remote-path-literal': '(allow network-outbound (remote unix-socket (path-literal ' + q(path) + ')))',
        'remote-path-regex': '(allow network-outbound (remote unix-socket (path-regex ' + regex + ')))',
        'remote-subpath': '(allow network-outbound (remote unix-socket (subpath ' + q(str(root)) + ')))',
        'direct-literal': '(allow network-outbound (literal ' + q(path) + '))',
        'direct-regex': '(allow network-outbound (regex ' + regex + '))',
        'direct-subpath': '(allow network-outbound (subpath ' + q(str(root)) + '))',
    }
    read_rule = '(allow file-read* (require-not (require-any (subpath ' + q(str(home)) + ') (subpath "/Library/Keychains") (subpath "/private/var/db/Keychains"))))'
    base = '(version 1)(allow default)(deny file-write*)(allow file-write* (subpath ' + q(str(root)) + '))(deny file-read* (subpath ' + q(str(home)) + ') (subpath "/Library/Keychains") (subpath "/private/var/db/Keychains"))(deny process-exec)(allow process-exec (literal "/usr/bin/true"))(deny mach-lookup)(deny network*)'
    candidates['default-deny-no-network-rule'] = '(version 1)(deny default)(allow process-exec (literal "/usr/bin/true"))' + read_rule + '(allow sysctl-read)'
    rows = []
    for name, rule in candidates.items():
        policy = rule if name == 'default-deny-no-network-rule' else base + rule
        file = root / (name + '.sb')
        file.write_text(policy)
        command = ['/usr/bin/sandbox-exec', '-f', str(file), '/usr/bin/true']
        result = subprocess.run(command, env=env, cwd=root, capture_output=True)
        log = result.stdout + result.stderr
        (root / (name + '.log')).write_bytes(log)
        text = log[-8192:].decode('utf-8', errors='replace')
        rows.append({'name': name, 'argv': command, 'exit': result.returncode, 'syntaxError': 'syntax error' in text, 'diagnostic': '\n'.join(text.splitlines()[-12:]), 'profileSha256': hashlib.sha256(policy.encode()).hexdigest(), 'logSha256': hashlib.sha256(log).hexdigest()})
    receipt = {'source': source, 'diagnosticOnly': True, 'onlyPayload': '/usr/bin/true', 'productionPolicyUnchanged': True, 'rows': rows}
    write_json(root / 'receipt.json', receipt, root)
    print(json.dumps(receipt), flush=True)
    print('GATE_RECEIPT_SHA256=' + receipt_hashes(root), flush=True)


if __name__ == '__main__':
    main()
