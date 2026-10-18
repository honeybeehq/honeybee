import json
import os
from pathlib import Path
import socket
import shutil
import struct
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from focused_barrier import Barrier, authenticate, environment, locator, DISCLOSURE
import focused_mediation_test
import focused_flow


class BarrierTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform.startswith('linux'), 'Linux peer credential integration')
    def test_default_isolation_internal_child_reaches_barrier_without_extra_argv(self):
        node = os.environ.get('SCG_NODE_BIN') or shutil.which('node')
        self.assertIsNotNone(node)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            barrier, mediation, unused, message, rendered, _, _ = self.setup_barrier(root)
            unused.close()
            barrier.listener.close()
            other = root / 'next'
            other.mkdir(mode=0o700)
            barrier = Barrier(other, 'b-p0.sock', mediation)
            self.addCleanup(barrier.close)
            path = root / 'barrier.test.mjs'
            path.write_text("import {test} from 'node:test'; import net from 'node:net'; test('barrier',async()=>{await new Promise((resolve,reject)=>{const socket=net.createConnection(process.env.SCG_FIXTURE_CONTROL_SOCKET); const timer=setTimeout(()=>{socket.destroy();reject(new Error('timeout'));},5000); let data=''; socket.on('connect',()=>socket.write(" + json.dumps(message.decode()) + "));socket.on('data',chunk=>data+=chunk);socket.on('error',reject);socket.on('end',()=>{clearTimeout(timer);if(data!== '{\\\"version\\\":1,\\\"approved\\\":true}\\n')reject(new Error('bad ACK'));else resolve();});});});")
            process = subprocess.Popen([node, '--test', str(path)], env=barrier.environment(dict(os.environ)), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            peer_pids = []
            def peer(helper, connection, retained, roles):
                pid, uid, _ = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                self.assertEqual(uid, os.getuid())
                self.assertNotEqual(pid, process.pid)
                peer_pids.append(pid)
                return True
            try:
                deadline = time.monotonic() + 10
                with patch('focused_barrier.authenticate', side_effect=peer), patch('focused_mediation.subprocess.run', return_value=rendered):
                    while process.poll() is None and time.monotonic() < deadline:
                        barrier.drain({})
                        time.sleep(0.01)
                stdout, stderr = process.communicate(timeout=2)
                self.assertEqual(process.returncode, 0, (stdout, stderr))
                self.assertEqual(len(peer_pids), 1)
                self.assertTrue(barrier.finish({})['ok'])
            finally:
                barrier.close()
                if process.poll() is None:
                    process.terminate()
                    process.communicate(timeout=2)

    @unittest.skipUnless(sys.platform.startswith('linux'), 'C peer mock compiles on Linux only')
    def test_scope_peer_fences_uid_and_birth_before_returning_identity(self):
        source = Path(__file__).with_name('scope.c').read_text()
        function = source[source.index('static int socket_peer('):source.index('#define CS_OPS_STATUS')]
        stub = r'''#include <sys/types.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
typedef unsigned int socklen_t;
#define SOL_LOCAL 0
#define LOCAL_PEERPID 1
struct proc_bsdinfo {uid_t pbi_uid; unsigned long long pbi_start_tvsec,pbi_start_tvusec;};
static int mode, births, credentials;
static int mock_peereid(int fd,uid_t *uid,gid_t *gid) {(void)fd;*gid=0;*uid=getuid()+(mode==1);return mode==2?-1:0;}
static int mock_sockopt(int fd,int level,int option,void *out,socklen_t *size) {(void)fd;(void)level;(void)option;credentials++;*(pid_t*)out=mode==5&&credentials==2?99:11;*size=sizeof(pid_t);return mode==3?-1:0;}
#define getpeereid mock_peereid
#define getsockopt mock_sockopt
static int identity(int pid,struct proc_bsdinfo *b) {(void)pid;b->pbi_uid=getuid();b->pbi_start_tvsec=100;b->pbi_start_tvusec=1;return mode==4?0:1;}
static int same_birth(int pid,unsigned long long sec,unsigned long long usec) {(void)pid;(void)sec;(void)usec;births++;return mode==6&&births==2?4:0;}
static void print_identity(int pid,struct proc_bsdinfo *b) {(void)pid;(void)b;}
'''
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'peer.c').write_text(stub + function + '\nint main(int argc,char **argv) {mode=argc>1?atoi(argv[1]):0;return socket_peer(7);}\n')
            subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror', str(root / 'peer.c'), '-o', str(root / 'peer')], check=True, capture_output=True)
            for mode in range(7):
                result = subprocess.run([str(root / 'peer'), str(mode)], capture_output=True)
                self.assertEqual(result.returncode, 0 if mode == 0 else 4)

    def test_locator_and_endpoint_drift_fail_closed(self):
        for data in (b'{}\n', b'\xff\n', b'{}\n{}\n', b'{}', b'{"version":true,"operation":"profile-ready","rowId":"row","fixtureRoot":"/root"}\n'):
            with self.assertRaises((ValueError, UnicodeError)):
                locator(data, 'row')
        with tempfile.TemporaryDirectory() as temporary:
            barrier, _, _, _, _, _, _ = self.setup_barrier(Path(temporary).resolve())
            barrier.path.rename(str(barrier.path) + '.old')
            substitute = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.addCleanup(substitute.close)
            substitute.bind(str(barrier.path))
            with self.assertRaisesRegex(ValueError, 'barrier_socket_drift'):
                barrier.drain({})

    def setup_barrier(self, root):
        mediation, fixture, profile, rendered = focused_mediation_test.MediationTests().make(root)
        self.addCleanup(mediation.close)
        directory = root / 'control'
        directory.mkdir(mode=0o700)
        now = [0]
        barrier = Barrier(directory, 'b-p0.sock', mediation, clock=lambda: now[0])
        self.addCleanup(barrier.close)
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.addCleanup(client.close)
        client.settimeout(1)
        client.connect(str(barrier.path))
        message = json.dumps({'version': 1, 'operation': 'profile-ready', 'rowId': 'reviewed-row', 'fixtureRoot': str(fixture)}).encode() + b'\n'
        return barrier, mediation, client, message, rendered, profile, now

    def test_approval_reads_real_profile_before_ack_and_second_connection_fails(self):
        with tempfile.TemporaryDirectory() as temporary:
            barrier, mediation, client, message, rendered, profile, _ = self.setup_barrier(Path(temporary).resolve())
            client.sendall(message)
            with patch('focused_barrier.authenticate', return_value=True), patch('focused_mediation.subprocess.run', return_value=rendered):
                barrier.drain({})
            self.assertEqual(client.recv(256), b'{"version":1,"approved":true}\n')
            self.assertEqual(client.recv(1), b'')
            self.assertEqual(mediation.records[str(profile)]['state']['nlink'], 1)
            self.assertTrue(barrier.finish({})['ok'])
            self.assertEqual(barrier.evidence()['disclosure'], DISCLOSURE)
            other = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.addCleanup(other.close)
            other.connect(str(barrier.path))
            with self.assertRaisesRegex(ValueError, 'second_connection'):
                barrier.drain({})
            self.assertFalse(barrier.evidence()['ok'])

    def test_no_bytes_read_until_peer_role_known_and_timeout_fails(self):
        with tempfile.TemporaryDirectory() as temporary:
            barrier, mediation, client, message, _, _, now = self.setup_barrier(Path(temporary).resolve())
            client.sendall(message)
            with patch('focused_barrier.authenticate', return_value=False):
                barrier.drain({})
            self.assertEqual(barrier.buffer, b'')
            self.assertEqual(mediation.records, {})
            now[0] = 15
            with self.assertRaisesRegex(ValueError, 'timeout'):
                barrier.drain({})

    def test_protocol_refusals_and_disk_mismatch_never_ack(self):
        for case in ('oversize', 'malformed', 'wrong-row', 'extra-policy', 'duplicate-key', 'eof', 'missing', 'changed', 'links', 'permission', 'render-error', 'render-schema', 'ack-error'):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as temporary:
                barrier, mediation, client, message, rendered, profile, _ = self.setup_barrier(Path(temporary).resolve())
                if case == 'oversize': message = b'x' * 4097
                if case == 'malformed': message = b'not json\n'
                if case == 'wrong-row': message = message.replace(b'reviewed-row', b'wrong-row')
                if case == 'extra-policy': message = message[:-2] + b',"policy":{}}\n'
                if case == 'duplicate-key': message = message.replace(b'"version": 1', b'"version": 1,"version": 1')
                if case == 'missing': profile.unlink()
                if case == 'changed': profile.write_text('different')
                if case == 'links': os.link(profile, profile.parent / 'alias')
                if case == 'eof': client.shutdown(socket.SHUT_WR)
                else: client.sendall(message)
                if case == 'render-error': rendered = subprocess.CompletedProcess([], 1, '', '')
                if case == 'render-schema': rendered = subprocess.CompletedProcess([], 0, '{}', '')
                with patch('focused_barrier.authenticate', return_value=True), patch('focused_mediation.subprocess.run', return_value=rendered):
                    if case == 'permission':
                        with patch('focused_mediation.focused_profile.profile_state', side_effect=PermissionError()), self.assertRaises(ValueError):
                            barrier.drain({})
                    elif case == 'ack-error':
                        with patch('socket.socket.sendall', side_effect=BrokenPipeError()), self.assertRaises(ValueError):
                            barrier.drain({})
                    else:
                        with self.assertRaises(ValueError): barrier.drain({})
                self.assertFalse(barrier.evidence()['ok'])

    def test_absent_barrier_does_not_modify_environment_and_missing_approval_fails(self):
        env = {'HOME': '/fake'}
        with patch('socket.socket', side_effect=AssertionError('unexpected I/O')):
            self.assertIs(environment(env), env)
        self.assertNotIn('SCG_FIXTURE_CONTROL_SOCKET', env)
        with tempfile.TemporaryDirectory() as temporary:
            barrier, _, _, _, _, _, _ = self.setup_barrier(Path(temporary).resolve())
            self.assertEqual(barrier.environment(env), dict(env, SCG_FIXTURE_CONTROL_SOCKET=str(barrier.path)))
            self.assertEqual(env, {'HOME': '/fake'})
            with patch('focused_barrier.authenticate', return_value=False), self.assertRaisesRegex(ValueError, 'missing_approval'):
                barrier.finish({})

    def test_peer_uid_exact_birth_and_internal_test_runner_role(self):
        birth = ('11', '10', '100', '1')
        retained = {('11', '100', '1'): birth}
        connection = SimpleNamespace(fileno=lambda: 7)
        for uid, peer, role, internal, expected in ((os.getuid(), birth, 'test-runner', {11}, True), (os.getuid() + 1, birth, 'test-runner', {11}, False), (os.getuid(), ('11', '10', '101', '1'), 'test-runner', {11}, False), (os.getuid(), birth, 'reader', {11}, False), (os.getuid(), birth, 'test-runner', set(), False)):
            roles = SimpleNamespace(identities={11: (birth, role, '/entry')}, internal=internal)
            result = subprocess.CompletedProcess([], 0, str(uid) + ' ' + ' '.join(peer) + '\n', '')
            with patch('focused_barrier.subprocess.run', return_value=result):
                if expected: self.assertTrue(authenticate('/scope', connection, retained, roles))
                else:
                    with self.assertRaises(ValueError): authenticate('/scope', connection, retained, roles)

    def test_sampler_only_classifies_explicit_controller_endpoint(self):
        result = subprocess.CompletedProcess([], 0, '7 UNIX gate-barrier 0\n8 TCP 192.0.2.1 443\n', '')
        with patch('focused_flow.subprocess.run', return_value=result) as run:
            row = focused_flow.connection_observation('/scope', ['11', '10', '100', '1'], '/controller/b-p0.sock')
        self.assertEqual(run.call_args.args[0][-1], '/controller/b-p0.sock')
        self.assertEqual(row['connections'][0]['classification'], 'gate-barrier')
        self.assertFalse(row['connections'][1]['loopback'])
        with patch('focused_flow.subprocess.run', return_value=result), self.assertRaises(ValueError):
            focused_flow.connection_observation('/scope', ['11', '10', '100', '1'])


if __name__ == '__main__':
    unittest.main()
