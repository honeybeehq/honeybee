import socket
import sys
import time


with socket.socket(socket.AF_INET, socket.SOCK_STREAM if sys.argv[1] == 'TCP' else socket.SOCK_DGRAM) as listener:
    listener.bind(('0.0.0.0', 0))
    if sys.argv[1] == 'TCP':
        listener.listen(1)
    print('EXPECTED_WILDCARD_READY', flush=True)
    time.sleep(5)
