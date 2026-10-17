import re


TABLE = {
    'harnessLabels': [name + ': tool-policy read UNVERIFIED (OS-level only)' for name in ('Claude', 'Codex', 'Grok', 'Kimi', 'Muse', 'Agy')],
    'hsrWrite': 'write denied: NOT APPLICABLE (unsandboxed by design)',
    'cellDenial': r'write denied: cell-sandbox; errno=(EACCES|EPERM|EROFS); scratchPaths:\[\] fixture narrowing; all other SBPL rules byte-for-byte production',
    'satelliteDenial': r'write denied: satellite-default; errno=(EACCES|EPERM|EROFS); scratchPaths:\[\] fixture narrowing; all other SBPL rules byte-for-byte production',
    'scope': 'tool-policy read UNVERIFIED (OS-level only)',
}


def validate_ready():
    if not isinstance(TABLE['harnessLabels'], list) or len(TABLE['harnessLabels']) != 6 or not all(isinstance(value, str) and value for value in TABLE['harnessLabels']):
        raise ValueError('byte-exact harness diagnostic pins pending author manifest')
    if not TABLE['cellDenial'] or not TABLE['satelliteDenial']:
        raise ValueError('byte-exact denial diagnostic pins pending author manifest')


def check(rows):
    validate_ready()
    outcomes = []
    for row in rows:
        diagnostics = row.get('diagnostics', [])
        missing = [value for value in TABLE['harnessLabels'] if value not in diagnostics]
        name = row['fullName']
        if ': hsr;' in name:
            if TABLE['hsrWrite'] not in diagnostics:
                missing.append(TABLE['hsrWrite'])
        else:
            pattern = TABLE['cellDenial'] if ': cell-sandbox;' in name else TABLE['satelliteDenial'] if ': satellite-default;' in name else None
            if pattern is None or not any(re.fullmatch(pattern, value) for value in diagnostics):
                missing.append('operation-bound production-profile denial diagnostic')
        outcomes.append({'fullName': name, 'missing': missing, 'ok': not missing})
    return {'ok': len(outcomes) == 3 and all(row['ok'] for row in outcomes), 'rows': outcomes}
