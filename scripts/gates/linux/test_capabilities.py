import json
import os
import pathlib
import sys
from home_guard import entry_guard

SETPRIV_ARGS = ['setpriv', '--inh-caps=-dac_override,-dac_read_search', '--bounding-set=-dac_override,-dac_read_search', '--ambient-caps=-dac_override,-dac_read_search', '--no-new-privs']
CAPABILITY_SETS = ('CapEff', 'CapPrm', 'CapBnd', 'CapInh', 'CapAmb')


def is_test_command(command):
    return command[:2] == ['npm', 'test'] or command[:2] == ['npm', 'run'] and command[2:] in [[name] for name in ('v2:test', 'v2:daemon', 'v2:driver', 'v2:driver2', 'v2:harness')] or '--test' in command or bool(command) and pathlib.Path(command[-1]).name == 'policy_test.py'


def assert_capabilities(fields):
    for name in CAPABILITY_SETS:
        if int(fields[name], 16) & 6:
            raise ValueError('DAC capabilities retained in ' + name)
    if fields['NoNewPrivs'] != '1':
        raise ValueError('NoNewPrivs missing')


def main():
    root, label = pathlib.Path(sys.argv[1]), sys.argv[2]
    guard = entry_guard(root)
    command = sys.argv[3:]
    fields = {name: value.strip() for line in pathlib.Path('/proc/self/status').read_text().splitlines() for name, separator, value in [line.partition(':')] if name in (*CAPABILITY_SETS, 'NoNewPrivs')}
    assert_capabilities(fields)
    record = dict(asserted=True, status=fields, setprivArgv=SETPRIV_ARGS, command=command, entryGuard=guard, helperSha256=__import__('hashlib').sha256(pathlib.Path(__file__).read_bytes()).hexdigest())
    (root / 'receipts' / label / 'capability-drop.json').write_text(json.dumps(record, indent=2))
    os.execvpe(command[0], command, os.environ)


if __name__ == '__main__':
    main()
