import json
import os
from pathlib import Path
import secrets
import socket
import time

from guard import write_json


def main():
    root = Path(os.environ['GATE_ROOT'])
    nonce = secrets.token_hex(32)
    row = {'diagnosticOnly': True, 'nonce': nonce, 'address': '0.0.0.0', 'waitLimitSeconds': 30, 'peer': None}
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
        server.bind(('0.0.0.0', 0))
        server.listen(1)
        server.settimeout(30)
        row['port'] = server.getsockname()[1]
        row['startedAt'] = time.time()
        print('INBOUND_PROBE_PORT=' + str(row['port']), flush=True)
        try:
            accepted, peer = server.accept()
            with accepted:
                accepted.settimeout(2)
                accepted.sendall((nonce + '\n').encode('ascii'))
            row.update({'result': 'accepted', 'peer': peer})
        except socket.timeout:
            row['result'] = 'timeout'
        except OSError as error:
            row.update({'result': 'error', 'errno': error.errno, 'error': str(error)})
        finally:
            row['endedAt'] = time.time()
    row['listenerClosed'] = True
    write_json(root / 'inbound-probe.json', row, root)
    print('INBOUND_PROBE_RESULT=' + json.dumps(row), flush=True)


if __name__ == '__main__':
    main()
