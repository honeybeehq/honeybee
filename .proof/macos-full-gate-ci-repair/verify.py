#!/usr/bin/env python3
"""Check repaired source identity; read README for receipt custody and scope."""
import hashlib
from pathlib import Path

root = Path(__file__).resolve().parents[2]
expected = {
    'v2/daemon/tests/confined-peer-rpc.test.ts': 'ffe53cd0454c688aa6e097112d19f7768d0ec65c62fa7bf58453f806acb8df04',
    'v2/daemon/tests/helpers-teardown.test.ts': '72d05c23802984e712c5f479485975a1613bfb442a4e6c9c080c8cefd82c3d77',
    'v2/daemon/tests/helpers.ts': 'e6aaddadbe978d3c1568937d3c2ba06e7beb89a2c37f58fe362f90b176783b24',
}
for name, digest in expected.items():
    assert hashlib.sha256((root / name).read_bytes()).hexdigest() == digest, name
print('Repaired three-file source identity matches native Linux-tested files.')
