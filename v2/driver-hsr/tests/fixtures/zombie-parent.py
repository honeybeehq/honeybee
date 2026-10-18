import os
import select
import sys

reader, writer = os.pipe()
pid = os.fork()
if pid == 0:
    os.close(writer)
    select.select([reader], [], [], 20)
    os._exit(7)
os.close(reader)
print(pid, flush=True)
try:
    ready, _, _ = select.select([sys.stdin], [], [], 15)
    if ready:
        sys.stdin.readline()
    os.close(writer)
    ready, _, _ = select.select([sys.stdin], [], [], 5)
    if ready:
        sys.stdin.readline()
finally:
    os.waitpid(pid, 0)
