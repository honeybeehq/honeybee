#!/usr/bin/env python3
"""Validate the explicitly scoped stored receipts, not a new execution."""
import hashlib
import json
from pathlib import Path
import re

directory = Path(__file__).resolve().parent
root = directory.parent.parent
expected = {
    'v2/daemon/src/daemon.ts', 'v2/daemon/src/main.ts',
    'v2/daemon/tests/helpers-teardown.test.ts', 'v2/daemon/tests/helpers.ts',
    'v2/driver-hsr/src/driver.ts', 'v2/driver-hsr/tests/driver.test.ts',
    'v2/driver-hsr/tests/runner-host.test.ts',
    'v2/daemon/tests/fixtures/refuse-first-shutdown-signal.mjs',
    'v2/driver-hsr/tests/status-exit.test.ts',
    'v2/driver-hsr/tests/fixtures/hold-status-pump.mjs',
}
manifest = json.loads((directory / 'source-manifest.json').read_text())
assert set(manifest) == expected
for name, digest in manifest.items():
    assert hashlib.sha256((root / name).read_bytes()).hexdigest() == digest, name

for run, passed, skipped in [
    ('driver-final-full-a', 282, 4), ('driver-final-full-b', 282, 4),
    ('shutdown-combined-final', 13, 0), ('driver-final-focused-green', 5, 0),
]:
    result = json.loads((directory / (run + '-result.json')).read_text())
    assert result['exit'] == 0, run
    log = (directory / (run + '-suite.log')).read_text()
    for key, count in [('pass', passed), ('skipped', skipped), ('fail', 0), ('cancelled', 0)]:
        values = re.findall(r'^ℹ ' + key + r' (\d+)$', log, re.M)
        assert values and sum(map(int, values)) == count, (run, key, values)
    if run == 'shutdown-combined-final':
        for case in ['transient identity refusal', 'transient signal refusal', 'signal identity never recovers', 'mid-turn restart']:
            assert case in log, (run, case)
    else:
        for case in ['the spawn booted is SYNTHETIC', 'first parsed output pushes a REAL booted', 'late init must not close', 'genuinely long-running silent', 'host exit retains synthetic startup evidence']:
            assert case in log, (run, case)
    workload = json.loads((directory / (run + '-workload.json')).read_text())
    # The inherited capture harness records TS launch hashes, but does not
    # include the two v2 fixture MJS files. Do not call this an all-file freeze.
    for name in expected:
        if name.endswith('.ts'):
            assert workload['sourceFingerprints'].get(name) == manifest[name], (run, name)
    print(f'{run}: stored exit0, pass={passed}, skip={skipped}, fail/cancel=0; eight TS launch hashes match')
print('Current ten defined source hashes match. No continuous stress, full daemon census or independent execution is asserted.')
