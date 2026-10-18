import json
import os
from pathlib import Path
import socket
import stat
import subprocess
import time


DISCLOSURE = 'plain run: production argv exact; harness synchronized by gate fixture barrier before exec'


def environment(env, barrier=None):
    return env if barrier is None else barrier.environment(env)


def locator(data, row_id):
    if len(data) > 4096 or not data.endswith(b'\n') or data.count(b'\n') != 1:
        raise ValueError('locator_frame')
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('locator_schema')
            result[key] = value
        return result
    value = json.loads(data.decode('utf-8'), object_pairs_hook=unique)
    if not isinstance(value, dict) or set(value) != {'version', 'operation', 'rowId', 'fixtureRoot'} or type(value['version']) is not int or value['version'] != 1 or value['operation'] != 'profile-ready' or value['rowId'] != row_id or not isinstance(value['fixtureRoot'], str) or not Path(value['fixtureRoot']).is_absolute():
        raise ValueError('locator_schema')
    return Path(value['fixtureRoot'])


def authenticate(helper, connection, retained, roles):
    fd = connection.fileno()
    result = subprocess.run([str(helper), 'peer-fd', str(fd)], pass_fds=(fd,), capture_output=True, text=True, timeout=2)
    parts = result.stdout.split()
    if result.returncode != 0 or len(parts) != 5 or not all(part.isdigit() for part in parts) or int(parts[0]) != os.getuid():
        raise ValueError('peer_identity')
    birth = tuple(parts[1:])
    matches = [tuple(map(str, row)) for row in retained.values() if str(row[0]) == birth[0]]
    if not matches:
        return False
    if matches != [birth]:
        raise ValueError('peer_birth')
    identity = roles.identities.get(int(birth[0])) if roles is not None else None
    if identity is None:
        return False
    if identity[0] != birth or identity[1] != 'test-runner' or int(birth[0]) not in roles.internal:
        raise ValueError('peer_role')
    return True


class Barrier:
    def __init__(self, directory, name, mediation, clock=time.monotonic):
        self.directory = Path(directory)
        info = self.directory.lstat()
        if self.directory.resolve(strict=True) != self.directory or not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o700 or info.st_uid != os.getuid():
            raise ValueError('barrier_directory')
        if name not in ('b-p0.sock', 'b-p1.sock'):
            raise ValueError('barrier_name')
        self.path = self.directory / name
        if len(os.fsencode(self.path)) > 103:
            raise ValueError('barrier_path_bound')
        self.directory_identity = (info.st_dev, info.st_ino, info.st_mode, info.st_uid)
        self.mediation = mediation
        self.clock = clock
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            self.listener.bind(str(self.path))
            self.listener.listen(2)
            self.listener.setblocking(False)
            info = self.path.lstat()
            if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
                raise ValueError('barrier_socket')
            self.socket_identity = (info.st_dev, info.st_ino, info.st_mode, info.st_uid)
        except Exception:
            self.listener.close()
            raise
        self.connection = None
        self.connections = 0
        self.authenticated = False
        self.approved = False
        self.failure = None
        self.buffer = b''
        self.deadline = None

    def environment(self, env):
        if 'SCG_FIXTURE_CONTROL_SOCKET' in env:
            raise ValueError('barrier_environment_collision')
        return dict(env, SCG_FIXTURE_CONTROL_SOCKET=str(self.path))

    def verify_path(self):
        info = self.directory.lstat()
        if self.directory.resolve(strict=True) != self.directory or (info.st_dev, info.st_ino, info.st_mode, info.st_uid) != self.directory_identity:
            raise ValueError('barrier_directory_drift')
        info = self.path.lstat()
        if (info.st_dev, info.st_ino, info.st_mode, info.st_uid) != self.socket_identity:
            raise ValueError('barrier_socket_drift')

    def drain(self, retained):
        try:
            self.verify_path()
            while True:
                try:
                    connection, _ = self.listener.accept()
                except BlockingIOError:
                    break
                self.connections += 1
                if self.connections != 1:
                    connection.close()
                    raise ValueError('second_connection')
                self.connection = connection
                self.connection.setblocking(False)
                self.deadline = self.clock() + 15
            if self.connection is None:
                return
            if self.clock() >= self.deadline:
                raise ValueError('timeout')
            if not self.authenticated:
                if not authenticate(self.mediation.helper, self.connection, retained, getattr(self.mediation, 'roles', None)):
                    return
                self.authenticated = True
            try:
                data = self.connection.recv(4097 - len(self.buffer))
            except BlockingIOError:
                return
            if not data:
                raise ValueError('locator_eof')
            self.buffer += data
            if len(self.buffer) > 4096:
                raise ValueError('locator_bound')
            if b'\n' not in self.buffer:
                return
            fixture = locator(self.buffer, self.mediation.row_id)
            self.mediation.approve_profile(fixture, fixture / 'work/sandbox.sb')
            if self.clock() >= self.deadline:
                raise ValueError('timeout')
            self.verify_path()
            self.connection.settimeout(min(2, self.deadline - self.clock()))
            self.connection.sendall(b'{"version":1,"approved":true}\n')
            self.connection.close()
            self.connection = None
            self.approved = True
        except (ValueError, OSError, UnicodeError, subprocess.SubprocessError) as error:
            known = {'peer_identity', 'peer_birth', 'peer_role', 'barrier_directory_drift', 'barrier_socket_drift', 'second_connection', 'timeout', 'locator_eof', 'locator_bound', 'locator_frame', 'locator_schema'}
            self.failure = str(error) if str(error) in known else 'approval_or_transport_refused'
            raise ValueError('fixture barrier ' + self.failure) from None

    def evidence(self):
        return {'ok': self.approved and self.failure is None and self.connections == 1, 'connections': self.connections, 'authenticated': self.authenticated, 'approved': self.approved, 'failure': self.failure, 'disclosure': DISCLOSURE}

    def finish(self, retained):
        self.drain(retained)
        if not self.evidence()['ok']:
            self.failure = self.failure or 'missing_approval'
            raise ValueError('fixture barrier ' + self.failure)
        return self.evidence()

    def close(self):
        if self.connection is not None:
            self.connection.close()
            self.connection = None
        self.listener.close()
