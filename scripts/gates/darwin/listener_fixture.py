import socket
import os
from pathlib import Path
import subprocess
import sys
import time


mode = sys.argv[1]
root = Path(os.environ['GATE_ROOT'])
if mode == 'reparent-parent':
    child = subprocess.Popen([sys.executable, '-B', __file__, 'reparent-child'])
    (root / 'reparent-child-pid').write_text(str(child.pid))
    while not (root / 'reparent-parent-release').exists():
        if (root / 'reparent-abort').exists():
            child.wait(timeout=3)
            sys.exit(1)
        time.sleep(0.01)
    sys.exit(0)
if mode == 'reparent-child':
    (root / 'reparent-child-ready').write_text(str(os.getpid()))
    while not (root / 'reparent-listen-release').exists():
        if (root / 'reparent-abort').exists():
            sys.exit(1)
        time.sleep(0.01)
with socket.socket(socket.AF_INET, socket.SOCK_STREAM if mode in ('TCP', 'reparent-child') else socket.SOCK_DGRAM) as listener:
    listener.bind(('0.0.0.0', 0))
    if mode in ('TCP', 'reparent-child'):
        listener.listen(1)
    print('EXPECTED_WILDCARD_READY', flush=True)
    time.sleep(5)
