# Nightly evidence manifest correction

The manifest added in `487972cf1f6a7818766b422d116d6f997c0c8129` described the CRLF capture of `mini-daemon-guard-scorecard.csv`. Git stored its LF form. The entry therefore failed a checksum verification on both frozen main `98cc89c3` and exhaustive head `02aa424e`.

This correction updates only the manifest byte count and SHA-256 to identify the committed file. No measurement, CSV field, production code or captured result changes.

| Representation | Bytes | SHA-256 |
|---|---:|---|
| Original CRLF capture | 4815 | `ab1fc821e4a89d2739d0f0c76692664ee5ef953155976c2fab081075808426a8` |
| Committed LF file | 4775 | `da751beae1cf8004cf70f24ab89bc7e687a6f302ac4b8f1888c666fec478f32c` |

Replacing each LF with CRLF reproduces the original capture digest exactly. The 40 newline conversions explain all 40 differing bytes. Original metadata remains above and in Git history.

The independent audit checked 22,944 manifest references across 23 historical versions. Only this inherited entry mismatched. A fresh check of every current manifest entry failed before the correction and passed afterward. This is a low severity evidence-integrity defect; it does not alter product behavior.

Reproduce from the repository root:

```sh
python3 - <<'CHECK'
import hashlib, json
from pathlib import Path
root = Path('docs/performance/2026-09-07-exhaustive')
manifest = json.loads((root / 'evidence-manifest.json').read_text())
for name, expected in manifest['files'].items():
    data = (root / name).read_bytes()
    assert len(data) == expected['bytes'], name
    assert hashlib.sha256(data).hexdigest() == expected['sha256'], name
print('all manifest entries match')
CHECK
```
