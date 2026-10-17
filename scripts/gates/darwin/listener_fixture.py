import socket
import os
from pathlib import Path
import subprocess
import sys
import time


mode = sys.argv[1]
root = Path(os.environ['GATE_ROOT'])
if mode == 'reparent-parent':
    subprocess.Popen([sys.executable, '-B', __file__, 'reparent-child'])
    deadline = time.monotonic() + 5
    while not (root / 'reparent-parent-release').exists() and time.monotonic() < deadline:
        time.sleep(0.01)
    sys.exit(0)
if mode == 'reparent-child':
    deadline = time.monotonic() + 5
    while not (root / 'reparent-listen-release').exists():
        if time.monotonic() >= deadline:
            sys.exit(1)
        time.sleep(0.01)
with socket.socket(socket.AF_INET, socket.SOCK_STREAM if mode in ('TCP', 'reparent-child') else socket.SOCK_DGRAM) as listener:
    listener.bind(('0.0.0.0', 0))
    if mode in ('TCP', 'reparent-child'):
        listener.listen(1)
    print('EXPECTED_WILDCARD_READY', flush=True)
    time.sleep(5)
