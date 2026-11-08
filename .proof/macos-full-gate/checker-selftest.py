"""Exercise receipt-scope rejection paths without running services or altering source."""
import hashlib
import json
import pathlib
import runpy
import tempfile

root = pathlib.Path(__file__).resolve().parents[2]
proof = pathlib.Path(__file__).resolve().parent
api = runpy.run_path(str(proof / 'verify-receipts.py'))
api['check_source'](root, proof)
api['check_harness'](proof)
base = root / '.audit/macos-gate/checker-controls'
base.mkdir(parents=True, exist_ok=True)
fixture = pathlib.Path(tempfile.mkdtemp(prefix='owned-', dir=base))
shadow = fixture / 'source'
shadow_proof = fixture / 'proof'
shadow_proof.mkdir()
for path, value in {
    'package.json': '{}', 'package-lock.json': '{}',
    'v2/daemon/tests/a.test.ts': '// fixture a\n',
    'v2/daemon/tests/b.test.ts': '// fixture b\n',
    'scripts/run-v2-daemon-tests.mjs': 'const UNIT_FILES = new Set(["v2/daemon/tests/a.test.ts"]);\n',
}.items():
    destination = shadow / path
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(value)
manifest = {p: hashlib.sha256((shadow / p).read_bytes()).hexdigest() for p in api['source_paths'](shadow)}
(shadow_proof / 'source-fingerprints.json').write_text(json.dumps(manifest))
census = {'daemon': ['v2/daemon/tests/a.test.ts', 'v2/daemon/tests/b.test.ts'], 'cli': [],
          'daemonCount': 2, 'cliCount': 0, 'unitCount': 1, 'serialCount': 1, 'groupCount': 2,
          'groups': [['v2/daemon/tests/a.test.ts'], ['v2/daemon/tests/b.test.ts']]}
(shadow_proof / 'census.json').write_text(json.dumps(census))
api['check_source'](shadow, shadow_proof)
passed = []

def rejects(label, operation):
    try:
        operation()
    except AssertionError:
        passed.append(label)
    else:
        raise AssertionError(label + ' accepted')

expected = api['launch_fingerprints'](manifest)
rejects('empty launch', lambda: api['require_exact']({}, expected, 'launch'))
rejects('partial launch', lambda: api['require_exact'](dict(list(expected.items())[:-1]), expected, 'launch'))
renamed = dict(census, daemon=['v2/daemon/tests/a.test.ts', 'v2/daemon/tests/c.test.ts'])
(shadow_proof / 'census.json').write_text(json.dumps(renamed))
rejects('same-count replaced filename', lambda: api['check_source'](shadow, shadow_proof))
(shadow_proof / 'census.json').write_text(json.dumps(census))
(shadow / 'v2/added.ts').write_text('// owned added source fixture\n')
rejects('new matching source file', lambda: api['check_source'](shadow, shadow_proof))
for name in ['run-capture-harness-v1.py', 'run-stressed-suite.py']:
    (shadow_proof / name).write_text((proof / name).read_text())
api['check_harness'](shadow_proof)
with (shadow_proof / 'run-stressed-suite.py').open('a') as file:
    file.write('# unexpected change\n')
rejects('unapproved reproducer change', lambda: api['check_harness'](shadow_proof))
print(json.dumps({'controlsRejected': passed, 'realSourceAndHarness': 'passed', 'retainedOwnedFixture': str(fixture)}))
