"""Verify portable nightly evidence from a clone containing the candidate objects.

Run: python3 docs/review/art-nightly-2026-09-08-evidence/verify.py
This reads Git and files only. It does not fetch or contact any daemon.
"""
import hashlib
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
EVIDENCE = Path(__file__).resolve().parent


def git(*args):
    return subprocess.check_output(['git', '-C', str(ROOT), *args])


def digest(data):
    return hashlib.sha256(data).hexdigest()


inventory = json.loads((EVIDENCE / 'inventory.json').read_text())
outcomes = json.loads((EVIDENCE / 'outcomes.json').read_text())
assert len(inventory) == len(outcomes) == 27
assert {row['sha'] for row in inventory} == {row['sha'] for row in outcomes}
for row in inventory:
    sha = row['sha']
    diff = git('show', '--format=fuller', '--binary', sha)
    assert digest(diff) == row['diffSha256'], sha
    parents = git('show', '-s', '--format=%P', sha).decode().split()
    assert parents == row['parents'] and len(parents) == 1, sha
    patch_id = subprocess.check_output(['git', 'patch-id', '--stable'], input=diff).decode().split()[0]
    assert patch_id == row['patchId'], sha

for row in json.loads((EVIDENCE / 'prior-evidence-identity.json').read_text()):
    data = git('show', row['sourceCommit'] + ':' + row['path'])
    assert digest(data) == row['sha256'], row['path']
for row in json.loads((EVIDENCE / 'legacy-current-identity.json').read_text()):
    blob = git('rev-parse', 'a60e679:' + row['path']).decode().strip()
    assert blob == row['priorBlob'] == row['currentBlob'], row['path']

manifest_root = ROOT / 'docs/performance/2026-09-07-exhaustive'
manifest = json.loads((manifest_root / 'evidence-manifest.json').read_text())
for name, expected in manifest['files'].items():
    data = (manifest_root / name).read_bytes()
    assert len(data) == expected['bytes'] and digest(data) == expected['sha256'], name

supply_sha = '64fbfe4702052cced13f5fc14ffb618e6907b9de'
for row in json.loads((EVIDENCE / 'supply-artifact-audit.json').read_text()):
    data = git('show', supply_sha + ':' + row['path'])
    assert len(data) == row['bytes'] and digest(data) == row['sha256'], row['path']
    if not row.get('recomputedDistributions'):
        continue
    value = json.loads(data)
    count = 0
    for case in value['results']:
        for side, raw in enumerate(case['raw']):
            for field, key in [('cpu', 'cpuMs'), ('wall', 'wallMs')]:
                values = sorted(sample[field] for sample in raw)
                expected = dict(n=len(values), median=values[len(values) // 2], min=values[0], max=values[-1])
                assert case['summaries'][side][key] == expected
                count += 1
    assert count == row['recomputedDistributions']
print(f"27 exact diffs, prior/legacy identities, {len(manifest['files'])} manifest entries and supply evidence verified")
