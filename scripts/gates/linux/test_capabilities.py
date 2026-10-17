import json
import os
import pathlib
import sys
from home_guard import entry_guard
from policy import RULE_VERSION

SETPRIV_ARGS = ['setpriv', '--inh-caps=-all', '--bounding-set=-all', '--ambient-caps=-all', '--no-new-privs']
CAPABILITY_SETS = ('CapEff', 'CapPrm', 'CapBnd', 'CapInh', 'CapAmb')


def assert_capabilities(fields):
    for name in CAPABILITY_SETS:
        if int(fields[name], 16) != 0:
            raise ValueError('Capabilities retained in ' + name)
    if fields['NoNewPrivs'] != '1':
        raise ValueError('NoNewPrivs missing')


def capability_receipt_valid(record, config, command, label):
    try:
        expected = config['toolHashes']['test_capabilities.py']
        assert isinstance(expected, str) and expected
        assert record['asserted'] is True and record['helperSha256'] == expected
        assert record['uid'] == record['gid'] == 1000
        assert record['uidMap'].split() == record['gidMap'].split() == ['1000','0','1']
        assert record['setprivArgv'] == SETPRIV_ARGS and record['command'] == command
        root = config['runRoot']
        assert record['execArgv'] == ['python3','-B',str(pathlib.Path(root) / 'workload.py'),root,label,*command]
        guard = record['entryGuard']
        assert guard['allowed'] is True and guard['beforeFirstWrite'] is True and guard['ruleVersion'] == RULE_VERSION
        assert_capabilities(record['status'])
    except (AssertionError, KeyError, ValueError, TypeError):
        return False
    return True


def main():
    root, label = pathlib.Path(sys.argv[1]), sys.argv[2]
    guard = entry_guard(root)
    command = sys.argv[3:]
    prefix = ['python3', '-B', str(root / 'workload.py'), str(root), label]
    assert command[:5] == prefix and command[5:]
    fields = {name: value.strip() for line in pathlib.Path('/proc/self/status').read_text().splitlines() for name, separator, value in [line.partition(':')] if name in (*CAPABILITY_SETS, 'NoNewPrivs')}
    assert_capabilities(fields)
    assert os.getuid() == os.getgid() == 1000
    record = dict(asserted=True, uid=os.getuid(), gid=os.getgid(), uidMap=pathlib.Path('/proc/self/uid_map').read_text(), gidMap=pathlib.Path('/proc/self/gid_map').read_text(), status=fields, setprivArgv=SETPRIV_ARGS, command=command[5:], execArgv=command, entryGuard=guard, helperSha256=__import__('hashlib').sha256(pathlib.Path(__file__).read_bytes()).hexdigest())
    (root / 'receipts' / label / 'capability-drop.json').write_text(json.dumps(record, indent=2))
    os.execvpe(command[0], command, os.environ)


if __name__ == '__main__':
    main()
