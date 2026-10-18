import json
from pathlib import Path
import socket
import subprocess

import focused_barrier
import focused_diagnostics
import focused_profile


ENV = 'SCG_FIXTURE_OBSERVATION_SOCKET'
ACK = b'{"version":1,"observed":true}\n'
DISCLOSURE = 'plain run: production argv exact; reader lifetime extended by the Darwin focused gate fixture until the controller acknowledges a complete live reader observation; this proves an extended idle lifetime, not observation during the actual read/write or unextended timing; removal owner: Darwin focused gate (f585).'


def require_evidence(required, evidence):
    if type(required) is not bool:
        raise ValueError('reader-observation-required')
    if not required:
        return
    fields = ('enabled', 'ok', 'authenticated', 'approved', 'readerObservationComplete', 'readerStillLiveAtAck')
    if not isinstance(evidence, dict) or any(evidence.get(key) is not True for key in fields) or type(evidence.get('connections')) is not int or evidence.get('connections') != 1 or evidence.get('failure') is not None:
        raise ValueError('reader-observation-required')


def request(data, row_id):
    if len(data) > 4096 or not data.endswith(b'\n') or data.count(b'\n') != 1:
        raise ValueError('protocol')
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('protocol')
            result[key] = value
        return result
    value = json.loads(data.decode('utf8'), object_pairs_hook=unique)
    if not isinstance(value, dict) or set(value) != {'version', 'operation', 'rowId', 'fixtureRoot'} or type(value['version']) is not int or value['version'] != 1 or value['operation'] != 'reader-observed' or value['rowId'] != row_id or not isinstance(value['fixtureRoot'], str):
        raise ValueError('protocol')
    fixture = Path(value['fixtureRoot'])
    if not fixture.is_absolute() or fixture.resolve(strict=True) != fixture:
        raise ValueError('fixture')
    return fixture


class ReaderBarrier(focused_barrier.Barrier):
    NAMES = ('o-p0.sock', 'o-p1.sock')

    def __init__(self, directory, name, mediation, clock=focused_barrier.time.monotonic):
        rows = (focused_diagnostics.ROW_NAMES['cell-sandbox'], focused_diagnostics.ROW_NAMES['satellite-default'])
        if mediation.row_id not in rows or name != 'o-p' + str(rows.index(mediation.row_id)) + '.sock':
            raise ValueError('reader barrier row')
        super().__init__(directory, name, mediation, clock)
        self.fixture = None
        self.remaining = ACK
        self.sent = False
        self.reader_complete = False
        self.reader_live = False

    def environment(self, env):
        if ENV in env:
            raise ValueError('reader barrier environment collision')
        return dict(env, **{ENV: str(self.path)})

    def proof(self, retained):
        profile = str(self.fixture / 'work/sandbox.sb')
        record = self.mediation.records.get(profile)
        if record is None or record['layout']['fixtureRoot'] != str(self.fixture) or record['layout']['profile'] != profile:
            raise ValueError('profile')
        if focused_profile.profile_state(profile, record['expected']) != record['state']:
            raise ValueError('profile')
        roles = self.mediation.roles
        candidates = [(birth, role, entry) for birth, role, entry in roles.identities.values() if role == 'reader']
        if not candidates:
            return None
        if len(candidates) != 1:
            raise ValueError('reader-count')
        birth, _, entry = candidates[0]
        if entry != self.mediation.reader or self.mediation.observed.get(birth) != profile:
            return None
        if self.mediation.recipient_births.get(birth) != list(birth):
            raise ValueError('reader-birth')
        host = roles.identities.get(int(birth[1]))
        runner = roles.identities.get(int(host[0][1])) if host is not None else None
        root = roles.identities.get(roles.root_pid)
        if host is None or host[1] != 'runner-host-main' or runner is None or runner[1] != 'test-runner' or int(runner[0][0]) not in roles.internal or int(runner[0][1]) != roles.root_pid or root is None or root[1] != 'test-runner' or roles.instrumented:
            raise ValueError('reader-chain')
        policies = [value for value in record['livePolicies'] if tuple(value['birth']) == birth]
        expected_paths = {'cellDir': record['layout']['cwd'], 'deliveryContent': record['content'], 'sealedRoot': str(self.mediation.workspace.parent)}
        expected_policy = {'cellDir': 'allowed', 'deliveryContent': 'denied', 'sealedRoot': 'denied'}
        if not policies:
            return None
        if any(value['policy'] != expected_policy or value['probePaths'] != expected_paths for value in policies):
            raise ValueError('reader-policy')
        for identity in (birth, host[0], runner[0], root[0]):
            if tuple(identity) not in {tuple(map(str, value)) for value in retained.values()}:
                raise ValueError('reader-birth')
        self.reader_complete = True
        return birth

    def drain(self, retained):
        try:
            self.verify_path()
            while True:
                try:
                    peer, _ = self.listener.accept()
                except BlockingIOError:
                    break
                self.connections += 1
                if self.connections != 1:
                    peer.close()
                    raise ValueError('second-connection')
                self.connection = peer
                peer.setblocking(False)
                self.deadline = self.clock() + 15
            if self.connection is None:
                return
            if self.clock() >= self.deadline:
                raise ValueError('timeout')
            if not self.authenticated:
                if not focused_barrier.authenticate(self.mediation.helper, self.connection, retained, self.mediation.roles):
                    return
                self.authenticated = True
            if self.sent:
                try:
                    data = self.connection.recv(1)
                except BlockingIOError:
                    return
                if data:
                    raise ValueError('protocol')
                self.connection.close()
                self.connection = None
                self.approved = True
                return
            if self.fixture is None:
                try:
                    data = self.connection.recv(4097 - len(self.buffer))
                except BlockingIOError:
                    return
                if not data:
                    raise ValueError('eof')
                self.buffer += data
                if len(self.buffer) > 4096:
                    raise ValueError('protocol')
                if b'\n' not in self.buffer:
                    return
                self.fixture = request(self.buffer, self.mediation.row_id)
            else:
                try:
                    extra = self.connection.recv(1, socket.MSG_PEEK)
                except BlockingIOError:
                    extra = None
                if extra is not None:
                    raise ValueError('protocol' if extra else 'eof')
            birth = self.proof(retained)
            if birth is None:
                return
            live = subprocess.run([str(self.mediation.helper), 'status', *birth], capture_output=True, text=True, timeout=min(2, max(0.01, self.deadline - self.clock())))
            if live.returncode != 0:
                raise ValueError('reader-gone')
            self.reader_live = True
            self.verify_path()
            if self.clock() >= self.deadline:
                raise ValueError('timeout')
            try:
                sent = self.connection.send(self.remaining)
            except BlockingIOError:
                return
            if sent <= 0:
                raise ValueError('ack')
            self.remaining = self.remaining[sent:]
            if not self.remaining:
                self.connection.shutdown(socket.SHUT_WR)
                self.sent = True
        except (ValueError, OSError, UnicodeError, subprocess.SubprocessError) as error:
            known = {'protocol', 'fixture', 'profile', 'reader-count', 'reader-birth', 'reader-chain', 'reader-policy', 'reader-gone', 'second-connection', 'timeout', 'eof', 'ack', 'peer_identity', 'peer_birth', 'peer_role', 'barrier_directory_drift', 'barrier_socket_drift'}
            self.failure = str(error) if str(error) in known else 'transport'
            raise ValueError('reader-observation-' + self.failure) from None

    def evidence(self):
        return {'enabled': self.connections != 0, 'ok': self.failure is None and (self.connections == 0 or self.approved), 'connections': self.connections, 'authenticated': self.authenticated, 'approved': self.approved, 'readerObservationComplete': self.reader_complete, 'readerStillLiveAtAck': self.reader_live, 'failure': self.failure, 'disclosure': DISCLOSURE if self.connections else None}

    def finish(self, retained):
        self.drain(retained)
        if not self.evidence()['ok']:
            self.failure = self.failure or 'missing-ack'
            raise ValueError('reader-observation-' + self.failure)
        return self.evidence()
