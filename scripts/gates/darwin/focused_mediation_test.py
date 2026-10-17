import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from focused_mediation import Mediation
from focused_profile import TEMPLATE


class MediationTests(unittest.TestCase):
    def make(self, root):
        temporary = root / 't'
        temporary.mkdir(mode=0o700)
        fixture = temporary / 'fr-ABC123'
        fixture.mkdir(mode=0o700)
        (fixture / 'work').mkdir(mode=0o700)
        (fixture / 'data').mkdir(mode=0o700)
        profile = fixture / 'work/sandbox.sb'
        profile.write_text('production bytes')
        profile.chmod(0o600)
        content = fixture / 'data/delivery-content' / hashlib.sha256(b'["owner","bee"]').hexdigest() / 'fixture.txt'
        content.parent.mkdir(parents=True)
        content.write_text('fixture bytes')
        mediation = Mediation(root, root / 'src', '/pinned/node', temporary, 'reviewed-row', TEMPLATE, root / 'renderer.mjs', {}, ['/sandbox', '-f', '/outer.sb'])
        rendered = json.dumps({'policy': {'cellDir': str(fixture / 'work'), 'writablePaths': [], 'scratchPaths': []}, 'profile': 'production bytes'})
        return mediation, fixture, profile, subprocess.CompletedProcess([], 0, rendered, '')

    def test_plain_recipient_requires_observed_exec_and_unchanged_profile(self):
        with tempfile.TemporaryDirectory() as temporary:
            mediation, fixture, profile, rendered = self.make(Path(temporary).resolve())
            with patch('focused_mediation.subprocess.run', return_value=rendered):
                mediation.approve_profile(fixture, profile)
            with self.assertRaisesRegex(ValueError, 'plain exec observation'):
                mediation.finish(False)
        with tempfile.TemporaryDirectory() as temporary:
            mediation, fixture, profile, rendered = self.make(Path(temporary).resolve())
            birth = ['11', '10', '100', '1']
            queried = subprocess.CompletedProcess([], 0, 'CELL 0\nCONTENT 1\nSEALED 1\n', '')
            with patch('focused_mediation.subprocess.run', side_effect=[rendered, queried]):
                mediation.observe_reader('/scope', birth, {'sandboxed': True, 'entry': mediation.reader, 'cwd': str(fixture / 'work')})
            with patch('focused_mediation.subprocess.run', return_value=subprocess.CompletedProcess([], 3, '', '')):
                result = mediation.finish(False)
            self.assertTrue(result['ok'])
            self.assertEqual(result['observedRecipientBirths'], [birth])

    def test_request_response_approves_only_reviewed_policy_before_launch(self):
        with tempfile.TemporaryDirectory() as temporary:
            mediation, fixture, profile, rendered = self.make(Path(temporary).resolve())
            request_fd = os.dup(mediation.request_fd)
            response_fd = os.dup(mediation.response_fd)
            mediation.parent_close()
            request = {'pid': 11, 'id': 1, 'operation': 'profile', 'rowId': 'reviewed-row', 'fixtureRoot': str(fixture), 'profile': str(profile), 'node': '/pinned/node', 'entry': mediation.reader, 'cwd': str(fixture / 'work')}
            os.write(request_fd, (json.dumps(request) + '\n').encode())
            with patch('focused_mediation.subprocess.run', side_effect=[subprocess.CompletedProcess([], 0, '', ''), rendered]):
                mediation.drain({('11', '100', '1'): ['11', '10', '100', '1']})
            response = json.loads(os.read(response_fd, 4096))
            self.assertTrue(response['allowed'])
            os.close(request_fd)
            os.close(response_fd)
            mediation.recipient_births[('12', '11', '101', '2')] = ['12', '11', '101', '2']
            mediation.observed[('12', '11', '101', '2')] = str(profile)
            mediation.records[str(profile)]['livePolicies'] = [{'policy': 'unit fixture'}]
            with patch('focused_mediation.subprocess.run', return_value=subprocess.CompletedProcess([], 3, '', '')):
                result = mediation.finish(True)
            self.assertTrue(result['ok'])
            self.assertEqual(result['profiles'][0]['before'], result['profiles'][0]['after'])

    def test_post_exit_ack_precedes_cleanup_and_plain_missing_is_unobservable(self):
        for instrumented in (True, False):
            with self.subTest(instrumented=instrumented), tempfile.TemporaryDirectory() as temporary:
                mediation, fixture, profile, rendered = self.make(Path(temporary).resolve())
                with patch('focused_mediation.subprocess.run', return_value=rendered):
                    mediation.approve_profile(fixture, profile)
                birth = ['12', '11', '101', '2']
                mediation.recipient_births[tuple(birth)] = birth
                mediation.observed[tuple(birth)] = str(profile)
                mediation.records[str(profile)]['livePolicies'] = [{'policy': 'unit fixture'}]
                with patch('focused_mediation.subprocess.run', return_value=subprocess.CompletedProcess([], 3, '', '')):
                    if instrumented:
                        mediation.check_deaths(True, required=True)
                    profile.unlink()
                    result = mediation.finish(instrumented)
                self.assertTrue(result['ok'])
                self.assertTrue(result['profiles'][0]['finalObservation']['unobservable'])
                self.assertEqual(result['profiles'][0]['after'].get('unobservable', False), not instrumented)
                self.assertIn('swap-and-restore', result['acceptedLimit'])

    def test_group_kill_ack_waits_for_verified_exit_and_snapshots_profile(self):
        with tempfile.TemporaryDirectory() as temporary:
            mediation, fixture, profile, rendered = self.make(Path(temporary).resolve())
            with patch('focused_mediation.subprocess.run', return_value=rendered):
                mediation.approve_profile(fixture, profile)
            root = ['10', '1', '100', '1']
            child = ['11', '10', '101', '2']
            reader = ['12', '11', '102', '3']
            retained = {(row[0], row[2], row[3]): row for row in (root, child, reader)}
            mediation.recipient_births[tuple(reader)] = reader
            count = [0]
            commands = []
            def helper(argv, **unused):
                commands.append(argv)
                if argv[1] == 'group':
                    return subprocess.CompletedProcess(argv, 0, '11 10 101 2\n12 11 102 3\n', '')
                if argv[1] == 'status':
                    count[0] += 1
                    return subprocess.CompletedProcess(argv, 0 if count[0] <= 3 else 3, '', '')
                return subprocess.CompletedProcess(argv, 0, '', '')
            with patch('focused_mediation.subprocess.run', side_effect=helper):
                mediation.signal({'pid': 10, 'id': 1, 'operation': 'signal', 'target': -11, 'signal': 'SIGKILL'}, root, retained, {11: child, 12: reader})
            self.assertIn('postExit', mediation.records[str(profile)])
            command = next(row for row in commands if row[1] == 'signal-group')
            self.assertEqual(command[-2:], ['11:101:2', '12:102:3'])
            mediation.close()

    def test_unobserved_plain_exec_and_duplicate_recipient_fail(self):
        with tempfile.TemporaryDirectory() as temporary:
            mediation, fixture, profile, rendered = self.make(Path(temporary).resolve())
            with patch('focused_mediation.subprocess.run', return_value=rendered):
                mediation.approve_profile(fixture, profile)
                with self.assertRaisesRegex(ValueError, 'duplicate recipient'):
                    mediation.approve_profile(fixture, profile)
            profile.write_text('changed')
            with self.assertRaises(ValueError):
                mediation.finish(True)


if __name__ == '__main__':
    unittest.main()
