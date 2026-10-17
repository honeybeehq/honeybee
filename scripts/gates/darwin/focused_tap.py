import re


RESULT = re.compile(r'^( *)(not ok|ok) ([0-9]+) - (.*)$')
DIRECTIVE = re.compile(r'\s+#\s*(SKIP|TODO)\b', re.I)


def adjudicate(text, expected, process_exit):
    if not expected or len(set(expected)) != len(expected):
        raise ValueError('expected names must be nonempty and unique')
    assertions = []
    errors = []
    plans = []
    for line in text.splitlines():
        summary = re.fullmatch(r'# (skipped|todo|cancelled) ([0-9]+)', line)
        if summary and int(summary.group(2)):
            errors.append('nonzero TAP ' + summary.group(1) + ' summary')
        plan = re.fullmatch(r'1\.\.([0-9]+)', line)
        if plan:
            plans.append(int(plan.group(1)))
        match = RESULT.fullmatch(line)
        if not match:
            diagnostic = re.match(r'^\s*# (.*)$', line)
            if diagnostic and assertions and not diagnostic.group(1).startswith('Subtest: '):
                assertions[-1]['diagnostics'].append(diagnostic.group(1))
            if line.lstrip().startswith('Bail out!'):
                errors.append('TAP bailout')
            continue
        indent, outcome, number, tail = match.groups()
        directive = DIRECTIVE.search(tail)
        name = tail[:directive.start()] if directive else tail
        assertions.append({'depth': len(indent), 'name': name.strip(), 'number': int(number), 'outcome': outcome, 'directive': directive.group(1).upper() if directive else None, 'diagnostics': []})
    parents = []
    rows = []
    for assertion in reversed(assertions):
        while parents and parents[-1]['depth'] >= assertion['depth']:
            parents.pop()
        full_name = ' > '.join([item['name'] for item in parents] + [assertion['name']])
        rows.append(dict(assertion, fullName=full_name))
        parents.append(assertion)
    rows.reverse()
    for row in rows:
        if row['outcome'] != 'ok' or row['directive']:
            errors.append('nonpassing TAP row: ' + row['fullName'])
        if row['fullName'] not in expected and not any(name.startswith(row['fullName'] + ' > ') for name in expected):
            errors.append('unexpected TAP row: ' + row['fullName'])
    selected = []
    for name in expected:
        matches = [row for row in rows if row['fullName'] == name]
        if len(matches) != 1:
            selected.append({'fullName': name, 'classification': 'MISSING' if not matches else 'DUPLICATE'})
            errors.append('expected row count differs from one: ' + name)
        else:
            row = matches[0]
            classification = row['directive'] or ('PASS' if row['outcome'] == 'ok' else 'FAIL')
            selected.append(dict(row, classification=classification))
    if process_exit:
        errors.append('test process exited ' + str(process_exit))
    top = [row['number'] for row in assertions if row['depth'] == 0]
    if len(plans) != 1 or not top or top != list(range(1, len(top) + 1)) or plans != [len(top)]:
        errors.append('missing or inconsistent root TAP plan')
    if not text.startswith('TAP version 13\n'):
        errors.append('missing TAP version')
    return {'ok': not errors, 'processExit': process_exit, 'rows': rows, 'expectedRows': selected, 'errors': errors}
