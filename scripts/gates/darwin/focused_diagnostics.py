import re
import json


TABLE = {
    'harnessLabels': [name + ': tool-policy read UNVERIFIED (OS-level only)' for name in ('Claude', 'Codex', 'Grok', 'Kimi', 'Muse', 'Agy')],
    'hsrWrite': 'write denied: NOT APPLICABLE (unsandboxed by design)',
    'cellDenial': r'write denied: cell-sandbox; errno=(EACCES|EPERM|EROFS); scratchPaths:\[\] fixture narrowing; all other SBPL rules byte-for-byte production',
    'satelliteDenial': r'write denied: satellite-default; errno=(EACCES|EPERM|EROFS); scratchPaths:\[\] fixture narrowing; all other SBPL rules byte-for-byte production',
    'scope': 'tool-policy read UNVERIFIED (OS-level only)',
}


SIBLING_SUBSTRATES = ('cell-sandbox', 'satellite-default')
ROW_NAMES = {kind: 'Darwin OS-level file read outside cwd: ' + kind + '; tool-policy read UNVERIFIED (OS-level only)' for kind in ('hsr', *SIBLING_SUBSTRATES)}


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
        def unique_keys(pairs):
            value = {}
            for key, item in pairs:
                if key in value:
                    raise ValueError('duplicate read-result key')
                value[key] = item
            return value
        value = json.loads(lines[0], object_pairs_hook=unique_keys)
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
        kind = next((value for value in expected_substrates if ROW_NAMES.get(value) == name), None)
        observed.append(kind)
        if ': hsr;' in name:
            if TABLE['hsrWrite'] not in diagnostics:
                missing.append(TABLE['hsrWrite'])
        else:
            pattern = TABLE['cellDenial'] if ': cell-sandbox;' in name else TABLE['satelliteDenial'] if ': satellite-default;' in name else None
            if pattern is None or not any(re.fullmatch(pattern, value) for value in diagnostics):
                missing.append('operation-bound production-profile denial diagnostic')
        result = read_result(row, kind)
        outcomes.append({'fullName': name, 'substrate': kind, 'missing': missing, 'readResult': result, 'ok': not missing and result['ok']})
    return {'ok': bool(expected_substrates) and len(set(expected_substrates)) == len(expected_substrates) and sorted(str(value) for value in observed) == sorted(expected_substrates) and all(row['ok'] for row in outcomes), 'rows': outcomes}


def check_phase(rows, selected_names, sibling):
    expected = tuple(kind for kind in SIBLING_SUBSTRATES if ROW_NAMES[kind] in selected_names) if sibling else ('hsr',)
    valid = not sibling or len(selected_names) == len(expected) == 1
    result = check(rows, expected if valid else ())
    result['ok'] = valid and result['ok']
    return result


def sibling_index(rows):
    result = {}
    valid = len(rows) == 2
    for row in rows:
        kind = row.get('substrate')
        if kind not in SIBLING_SUBSTRATES or row.get('fullName') != ROW_NAMES.get(kind) or kind in result:
            valid = False
            continue
        values = row.get('readResult', {}).get('values')
        if not values or values.get('substrate') != kind:
            valid = False
        result[kind] = row
    return result, valid and set(result) == set(SIBLING_SUBSTRATES)


def aggregate_mode(phases):
    rows = [row for phase in phases for row in phase.get('diagnostics', {}).get('rows', [])]
    _, coverage = sibling_index(rows)
    valid = len(phases) == 2 and coverage and all(phase.get('ok') is True and phase.get('diagnostics', {}).get('ok') is True and len(phase['diagnostics']['rows']) == 1 for phase in phases)
    return {'ok': valid, 'diagnostics': {'ok': valid, 'rows': rows}, 'harnessArgv': [phase.get('harnessArgv') for phase in phases]}


def compare_pair(instrumented, production):
    left, left_coverage = sibling_index(instrumented['diagnostics']['rows'])
    right, right_coverage = sibling_index(production['diagnostics']['rows'])
    rows = []
    for kind in SIBLING_SUBSTRATES:
        a, b = left.get(kind), right.get(kind)
        ok = bool(a and b and a['ok'] and b['ok'])
        values = [row['readResult'].get('values') if row else None for row in (a, b)]
        if ok:
            ok = all(values[0][key] == values[1][key] for key in ('readClass', 'writeDenied'))
        rows.append({'fullName': ROW_NAMES[kind], 'substrate': kind, 'ok': ok, 'instrumented': values[0], 'production': values[1]})
    return {'ok': instrumented['ok'] and production['ok'] and left_coverage and right_coverage and all(row['ok'] for row in rows), 'rows': rows, 'instrumentedHarnessArgv': instrumented.get('harnessArgv'), 'productionHarnessArgv': production.get('harnessArgv'), 'isolationDifference': 'instrumented uses --test-isolation=none to preserve the inherited trace fd; production uses default isolation without a preloader'}
