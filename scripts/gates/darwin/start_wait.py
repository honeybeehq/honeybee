import os
import sys

fd = int(sys.argv[1])
release = os.read(fd, 1)
os.close(fd)
if release != b'1':
    sys.exit(70)
os.execvpe(sys.argv[2], sys.argv[2:], os.environ)
