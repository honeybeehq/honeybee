import json
import os
import pathlib
import subprocess
import sys
import time
from home_guard import entry_guard

root, label = pathlib.Path(sys.argv[1]), sys.argv[2]
ENTRY_GUARD = entry_guard(root)
assert os.getpid() == 1
out = root / 'receipts' / label
(out / 'entry-guard-init.json').write_text(json.dumps(ENTRY_GUARD))
process = subprocess.Popen(sys.argv[3:])
status = None
reaped = []
while status is None:
    pid, result = os.waitpid(-1, 0)
    reaped.append(dict(pid=pid, status=result, at=time.time()))
    if pid == process.pid:
        status = os.waitstatus_to_exitcode(result)
        process.returncode = status
deadline = time.monotonic() + 1
while True:
    try:
        pid, result = os.waitpid(-1, os.WNOHANG)
    except ChildProcessError:
        break
    if pid:
        reaped.append(dict(pid=pid, status=result, at=time.time()))
        continue
    if time.monotonic() >= deadline:
        (out / 'init-lingering.json').write_text(json.dumps(dict(fail=True, at=time.time(), children=pathlib.Path('/proc/1/task/1/children').read_text(), action='private PID namespace teardown')))
        status = 5
        break
    time.sleep(.01)
(out / 'init-reaped.json').write_text(json.dumps(dict(exit=status, reaped=reaped)))
sys.exit(status if status >= 0 else 128-status)
