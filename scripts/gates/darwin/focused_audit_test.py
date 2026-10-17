import hashlib
import json
from pathlib import Path
import tempfile
import unittest

import focused_audit


def entry_pins(files, texts):
    name = focused_audit.FILES[1]
    return [{'path': name, 'line': 1, 'context': texts[name].splitlines()[0], 'role': role} for role in ('production-sandbox-exec', 'reader-entry')]


def native_edges(text):
    return [{'kind': 'native-artifact', 'path': focused_audit.FILES[1], 'line': 1, 'context': text, 'artifact': artifact, 'sha256Source': 'controller-manifest'} for artifact in sorted(focused_audit.NATIVE_ARTIFACTS)]


def gate_pins(workspace):
    pins = {}
    for key, name in (('manifestSha256', 'focused-manifest.json'), ('preloaderSha256', 'focused-preload.mjs')):
        path = workspace / 'scripts/gates/darwin' / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('fixture')
        pins[key] = hashlib.sha256(path.read_bytes()).hexdigest()
    return pins


def node_entries(workspace, files):
    rows = []
    for role, name in tuple(focused_audit.NODE_ENTRIES.items()):
        path = workspace / name
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('fixture')
            files.append({'path': name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'siblingClosure': True})
        rows.append({'role': role, 'path': name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    return rows


class AuditTests(unittest.TestCase):
    def test_disabled_build_requires_pinned_prior_refusal(self):
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary).resolve()
            guard = 'if (process.env.SCG_DELIVERY_FILE_PREBUILT_ONLY === "1") throw new Error("prebuilt required");'
            call = 'execFileSync(process.execPath, ["build-delivery-file.mjs"]);'
            files = []
            for name in focused_audit.FILES:
                path = workspace / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text((guard + '\n' + call + '\n') if name == focused_audit.FILES[1] else '')
                files.append({'path': name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'siblingClosure': name == focused_audit.FILES[1]})
            row = {'path': focused_audit.FILES[1], 'line': 2, 'context': call, 'executable': 'build-refused-prebuilt-only', 'receiver': 'before-hook build path is dominated by prebuilt refusal', 'manualReview': True, 'prebuiltGuard': {'path': focused_audit.FILES[1], 'line': 1, 'context': guard}}
            audit = workspace / 'audit.json'
            data = {'version': 1, 'files': files, 'spawns': [row], 'packages': [], 'nativeEdges': native_edges(guard), 'capabilityReferences': [], 'entryPins': entry_pins(files, {focused_audit.FILES[1]: guard})}
            data.update(gatePins=gate_pins(workspace), nodeEntries=node_entries(workspace, files))
            audit.write_text(json.dumps(data))
            focused_audit.validate(workspace, 'audit.json')
            row['prebuiltGuard']['context'] = 'wrong guard'
            audit.write_text(json.dumps(data))
            with self.assertRaisesRegex(ValueError, 'guard drift'):
                focused_audit.validate(workspace, 'audit.json')

    def test_schema_pins_and_executable_allowlist(self):
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary).resolve()
            files = []
            for path in focused_audit.FILES:
                full = workspace / path
                full.parent.mkdir(parents=True, exist_ok=True)
                full.write_text('spawn(process.execPath, []);\n')
                files.append({'path': path, 'sha256': hashlib.sha256(full.read_bytes()).hexdigest(), 'siblingClosure': True})
            spawns = [{'path': path, 'line': 1, 'context': 'spawn(process.execPath, []);', 'executable': 'node', 'receiver': 'node:child_process spawn; process.execPath is pinned Node', 'manualReview': True} for path in focused_audit.FILES]
            audit = workspace / 'audit.json'
            data = {'version': 1, 'files': files, 'spawns': spawns, 'packages': [], 'nativeEdges': native_edges('spawn(process.execPath, []);'), 'capabilityReferences': [], 'entryPins': entry_pins(files, {focused_audit.FILES[1]: 'spawn(process.execPath, []);'})}
            data.update(gatePins=gate_pins(workspace), nodeEntries=node_entries(workspace, files))
            audit.write_text(json.dumps(data))
            self.assertEqual(len(focused_audit.validate(workspace, 'audit.json')['files']), 5)
            correct_gate = dict(data['gatePins'])
            data['gatePins']['preloaderSha256'] = '0' * 64
            audit.write_text(json.dumps(data))
            with self.assertRaisesRegex(ValueError, 'gate pin drift'):
                focused_audit.validate(workspace, 'audit.json')
            data['gatePins'] = correct_gate
            correct_nodes = list(data['nodeEntries'])
            for nodes in ([], correct_nodes[:2], [correct_nodes[0], correct_nodes[0], correct_nodes[2]], [dict(correct_nodes[0], sha256='0' * 64), *correct_nodes[1:]]):
                data['nodeEntries'] = nodes
                audit.write_text(json.dumps(data))
                with self.subTest(nodes=nodes), self.assertRaises(ValueError):
                    focused_audit.validate(workspace, 'audit.json')
            data['nodeEntries'] = correct_nodes
            edges = data['nativeEdges']
            for bad in ([], edges[:1], [edges[0], edges[0]], [edges[0], dict(edges[1], artifact='wrong.node')], [*edges, edges[0]]):
                data['nativeEdges'] = bad
                audit.write_text(json.dumps(data))
                with self.subTest(edges=bad), self.assertRaisesRegex(ValueError, 'exactly the two distinct'):
                    focused_audit.validate(workspace, 'audit.json')
            data['nativeEdges'] = edges
            pins = data['entryPins']
            data['entryPins'] = []
            audit.write_text(json.dumps(data))
            with self.assertRaisesRegex(ValueError, 'entry pin missing'):
                focused_audit.validate(workspace, 'audit.json')
            data['entryPins'] = [dict(pin) for pin in pins]
            data['entryPins'][0]['context'] = 'drift'
            audit.write_text(json.dumps(data))
            with self.assertRaisesRegex(ValueError, 'context drift'):
                focused_audit.validate(workspace, 'audit.json')
            data['entryPins'] = pins
            for executable in ('git', 'security', 'tmux', '/bin/sh'):
                data['spawns'][0]['executable'] = executable
                audit.write_text(json.dumps(data))
                with self.assertRaisesRegex(ValueError, 'unapproved'):
                    focused_audit.validate(workspace, 'audit.json')
            data['spawns'][0]['executable'] = 'node'
            (workspace / files[0]['path']).write_text('changed')
            with self.assertRaisesRegex(ValueError, 'hash drift'):
                focused_audit.validate(workspace, 'audit.json')

    def test_absent_audit_refuses(self):
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaises(FileNotFoundError):
                focused_audit.validate(Path(temporary), 'audit.json')


if __name__ == '__main__':
    unittest.main()
