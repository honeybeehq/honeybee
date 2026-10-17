import errno
import json
from pathlib import Path
import socket
import sys


def main():
    root = Path(sys.argv[1]).resolve()
    path = str(root / 'stricter-socket.sock')
    stage = 'bind'
    try:
        with socket.socket(socket.AF_UNIX) as server, socket.socket(socket.AF_UNIX) as client:
            server.bind(path)
            server.listen(1)
            stage = 'connect'
            client.connect(path)
            accepted, _ = server.accept()
            accepted.close()
    except OSError as error:
        print(json.dumps({'allowed': False, 'stage': stage, 'errno': error.errno}))
        return 3 if error.errno in (errno.EPERM, errno.EACCES) else 4
    print(json.dumps({'allowed': True, 'stage': 'bind+connect'}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
