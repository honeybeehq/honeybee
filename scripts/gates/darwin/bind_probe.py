"""Self-test-only bind mediation diagnostic; never changes the production policy."""
import errno
import json
from pathlib import Path
import socket
import sys

from guard import write_json


def main():
    root = Path(sys.argv[1])
    rows = []
    for family, address, port in ((socket.AF_INET, '0.0.0.0', 49197), (socket.AF_INET6, '::', 0), (socket.AF_INET, '127.0.0.1', 0)):
        row = {'operation': 'bind', 'family': int(family), 'address': address, 'requestedPort': port}
        try:
            with socket.socket(family, socket.SOCK_STREAM) as probe:
                probe.bind((address, port))
                row.update({'result': 'allowed', 'boundAddress': probe.getsockname()})
        except OSError as error:
            row.update({'result': 'REFUSED' if error.errno in (errno.EPERM, errno.EACCES) else 'INCONCLUSIVE', 'errno': error.errno, 'error': str(error)})
        rows.append(row)
    row = {'operation': 'loopback listen and connect', 'address': '127.0.0.1', 'requestedPort': 0, 'phase': 'bind'}
    try:
        with socket.socket() as server:
            server.settimeout(2)
            server.bind(('127.0.0.1', 0))
            row['boundAddress'] = server.getsockname()
            row['phase'] = 'listen'
            server.listen(1)
            row['phase'] = 'connect'
            with socket.socket() as client:
                client.settimeout(2)
                client.connect(server.getsockname())
                row['phase'] = 'accept'
                accepted, peer = server.accept()
                with accepted:
                    row.update({'result': 'allowed', 'peer': peer})
    except OSError as error:
        row.update({'result': 'REFUSED' if error.errno in (errno.EPERM, errno.EACCES) else 'INCONCLUSIVE', 'errno': error.errno, 'error': str(error)})
    rows.append(row)
    write_json(root / 'no-ip-bind-results.json', rows, root)
    print('NO_IP_BIND_DIAGNOSTIC=' + json.dumps(rows), flush=True)


if __name__ == '__main__':
    main()
