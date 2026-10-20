from pathlib import Path
import json, re, subprocess
root = Path('.proof/E2')
code = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
rows = [json.loads(line) for line in (root / 'lab.log').read_text().splitlines() if line.startswith('{')]
assert len(rows) == 8 and all(row['passed'] for row in rows)
assert len((root / 'seams.log').read_text().splitlines()) == 13
assert json.loads((root / 'failed-successor.log').read_text())['passed']
assert json.loads((root / 'failed-successor-seam.log').read_text())['passed']
assert (root / 'gates.exit').read_text().strip() == '0'
suites = (root / 'suites.log').read_text()
assert 'ℹ fail 0' in suites and 'ℹ pass 160' in suites
lines = ['E2 automatic quota recovery attention: 9/9 real-daemon cases passed;14/14 seam phases passed.',
    f'Implementation {code}', 'Base 975ab53eb7b1842113d6874dfd777a47e910d9f7',
    'Branch review/sar-E2-recovery-not-needs-you', 'check,v2:check,build: PASS (gates.exit0).',
    'Existing suites:160 passed,1 existing real-HOME import skipped,0 failed. No new unit tests or production comments.',
    'Capacity(account_wait, including null retryAt), completion_reserve, rotating and allocation_owner_required are automatic.',
    'account_unavailable only hides with operation_in_progress; credential_login_required, lease_needs_operator, paused, unavailable and unknown details retain attention.',
    'blocked and resource_blocked stay visible in every daemon case. Core single/list and stale readonly agree.',
    'Typed reasonDetail lives on recovery rows and quota.recovery.wait, not compact notices. Contractv23 snapshot is quota-contract.md.',
    'Credential cases publish a typed owner-refusal receipt through real daemon RPC; no real provider or credential service is used.',
    'Queen condition: stopped spawn_failed successor raises attention while rotating; one owed continue remains pending without boot churn or growth over100polls.',
    'Author ran the gates and labs; independent reviewer reads the product and committed receipts.',
    'Carried LOWs: active initial-vs-owner wait label uses undefined/null reasonDetail distinction; old null-reason rows retain attention until next typed update.',
    'No deployment; DEPLOY HOLD remains. C2d owns owner typed-reason propagation; F2 owns copy.']
(root / 'verification.log').write_text('\n'.join(lines) + '\n' + (root / 'lab.log').read_text() + (root / 'seams.log').read_text() + (root / 'failed-successor.log').read_text() + (root / 'failed-successor-seam.log').read_text())
pattern = re.compile(r"/home/trmd/\.hive/v2/cells/[^/\s\"'<>]+/[^/\s\"'<>]+")
changed = []
for path in root.iterdir():
    if path.is_file():
        original = path.read_text()
        updated, count = pattern.subn('<CELL>', original)
        if count:
            path.write_text(updated)
            changed.append(f'{path.name}: {count} Cell-root replacements')
(root / 'sanitization.log').write_text('\n'.join(changed) + '\n')
for path in root.glob('*.json'):
    json.loads(path.read_text())
print('9 daemon cases;14 seam phases;160 passed1skip;all gates0;JSON parsed;Cell paths masked')
