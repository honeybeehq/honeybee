import re
import json


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


def read_result(row, kind):
    lines = [value[len('SCG_READ_RESULT='):] for value in row.get('diagnostics', []) if value.startswith('SCG_READ_RESULT=')]
    if len(lines) != 1:
        return {'ok': False, 'reason': 'missing or duplicate read-result diagnostic'}
    try:
        value = json.loads(lines[0])
        if set(value) != {'substrate', 'expectedDigest', 'observedDigest', 'expectedHeaderSha256', 'observedHeaderSha256', 'readClass', 'writeDenied'}:
            raise ValueError('wrong read-result schema')
        if value['substrate'] != kind or value['readClass'] != 'read':
            raise ValueError('wrong read-result substrate or class')
        for key in ('expectedDigest', 'observedDigest', 'expectedHeaderSha256', 'observedHeaderSha256'):
            if not isinstance(value[key], str) or not re.fullmatch(r'[0-9a-f]{64}', value[key]):
                raise ValueError('invalid read-result digest')
        if value['expectedDigest'] != value['observedDigest'] or value['expectedHeaderSha256'] != value['observedHeaderSha256']:
            raise ValueError('read-result expected and observed differ')
        if (kind == 'hsr' and value['writeDenied'] is not None) or (kind != 'hsr' and value['writeDenied'] is not True):
            raise ValueError('wrong write-denial outcome')
        return {'ok': True, 'values': value}
    except (ValueError, TypeError):
        return {'ok': False, 'reason': 'malformed or inconsistent read-result diagnostic'}


def check(rows, expected_substrates=('hsr', 'cell-sandbox', 'satellite-default')):
    validate_ready()
    outcomes = []
    observed = []
    for row in rows:
        diagnostics = row.get('diagnostics', [])
        missing = [value for value in TABLE['harnessLabels'] if value not in diagnostics]
        name = row['fullName']
        kind = next((value for value in expected_substrates if ': ' + value + ';' in name), None)
        observed.append(kind)
        if ': hsr;' in name:
            if TABLE['hsrWrite'] not in diagnostics:
                missing.append(TABLE['hsrWrite'])
        else:
            pattern = TABLE['cellDenial'] if ': cell-sandbox;' in name else TABLE['satelliteDenial'] if ': satellite-default;' in name else None
            if pattern is None or not any(re.fullmatch(pattern, value) for value in diagnostics):
                missing.append('operation-bound production-profile denial diagnostic')
        result = read_result(row, kind)
        outcomes.append({'fullName': name, 'missing': missing, 'readResult': result, 'ok': not missing and result['ok']})
    return {'ok': sorted(str(value) for value in observed) == sorted(expected_substrates) and all(row['ok'] for row in outcomes), 'rows': outcomes}


def compare_pair(instrumented, production):
    left = {row['fullName']: row for row in instrumented['diagnostics']['rows']}
    right = {row['fullName']: row for row in production['diagnostics']['rows']}
    rows = []
    for name in sorted(set(left) | set(right)):
        a, b = left.get(name), right.get(name)
        ok = bool(a and b and a['ok'] and b['ok'])
        values = [row['readResult'].get('values') if row else None for row in (a, b)]
        if ok:
            ok = all(values[0][key] == values[1][key] for key in ('readClass', 'writeDenied'))
        rows.append({'fullName': name, 'ok': ok, 'instrumented': values[0], 'production': values[1]})
    return {'ok': instrumented['ok'] and production['ok'] and len(rows) == 2 and all(row['ok'] for row in rows), 'rows': rows}
