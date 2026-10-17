import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import focused_flow


class Refusal(Exception):
    pass


class FlowTests(unittest.TestCase):
    def test_flow_requires_exactly_two_unique_native_edges(self):
        a = {'artifact': 'src/dist/v2/delivery-file/darwin-arm64/delivery-file.node'}
        b = {'artifact': 'src/dist/v2/peercred/darwin-arm64/peercred.node'}
        focused_flow.validate_native_edges([a, b])
        for bad in ([], [a], [a, a], [a, {'artifact': 'wrong.node'}], [a, b, a]):
            with self.subTest(edges=bad), self.assertRaisesRegex(ValueError, 'exactly the two distinct'):
                focused_flow.validate_native_edges(bad)
    def test_workload_only_narrows_compiler_execution(self):
        base = '(version 1)(allow default)'
        tools = {'clang': '/Applications/Xcode.app/toolchain/bin/clang', 'ld': '/Applications/Xcode.app/toolchain/bin/ld', 'toolchain': '/Applications/Xcode.app/toolchain'}
        result = focused_flow.workload_profile(base, tools)
        self.assertTrue(result.startswith(base + '(deny process-exec '))
        self.assertIn('(literal "/usr/bin/cc")', result)
        self.assertIn('(literal ' + json.dumps(tools['clang']) + ')', result)
        self.assertNotIn('(allow ', result[len(base):])

    def test_listener_failure_fences_every_retained_birth(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            (root / 'logs').mkdir()
            workspace = root / 'src'
            workspace.mkdir()
            parent = ['11', '1', '100', '200']
            child = ['12', '11', '101', '201']
            api = SimpleNamespace(Refusal=Refusal, LEFTOVER_CHILDREN=[], scope_call=Mock(side_effect=[[parent], [parent, child]]), sample_retained_listeners=Mock(return_value=[{'listeners': [{'loopback': False}]}]), write_json=lambda path, value, unused: path.write_text(json.dumps(value)))
            process = Mock(returncode=-15)
            process.pid = 11
            process.poll.return_value = None
            statuses = {}

            def helper(argv, **unused):
                if argv[1] == 'status':
                    count = statuses.get(argv[2], 0)
                    statuses[argv[2]] = count + 1
                    return subprocess.CompletedProcess(argv, 0 if count == 0 else 3, '', '')
                return subprocess.CompletedProcess(argv, 0, '', '')

            with patch('focused_flow.subprocess.Popen', return_value=process), patch('focused_flow.subprocess.run', side_effect=helper) as invoked, patch('focused_flow.time.sleep'), patch('focused_flow.os.write', return_value=1):
                result, _ = focused_flow.supervise(api, root, workspace, {'HOME': str(root)}, ['node', 'pinned-test'], 'fixture')
            self.assertIn('non-loopback', result['reason'])
            self.assertEqual(result['retainedBirths'], [parent, child])
            calls = [call.args[0] for call in invoked.call_args_list if call.args[0][1] == 'signal']
            self.assertEqual({call[2] for call in calls}, {'11', '12'})
            self.assertTrue(all(call[-1] in ('15', '9') for call in calls))
            self.assertTrue(all(0 < call.kwargs['timeout'] <= 2 for call in invoked.call_args_list))
            self.assertEqual(api.LEFTOVER_CHILDREN, [])

    def test_plain_sibling_samples_executable_and_starts_new_session(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            (root / 'logs').mkdir()
            workspace = root / 'src'
            workspace.mkdir()
            birth = ['11', '1', '100', '200']
            api = SimpleNamespace(Refusal=Refusal, LEFTOVER_CHILDREN=[], scope_call=Mock(side_effect=[[birth], [birth]]), sample_retained_listeners=Mock(return_value=[]), write_json=lambda path, value, unused: path.write_text(json.dumps(value)))
            process = Mock(returncode=0)
            process.pid = 11
            process.poll.side_effect = [None, 0]
            def helper(argv, **unused):
                return subprocess.CompletedProcess(argv, 0 if argv[1] in ('executable', 'connections') else 3, '/fixture/node' if argv[1] == 'executable' else '', '')
            with patch('focused_flow.subprocess.Popen', return_value=process) as popen, patch('focused_flow.subprocess.run', side_effect=helper), patch('focused_flow.time.sleep'), patch('focused_flow.os.write', return_value=1), patch('focused_flow.focused_seal.require_quiescent', return_value=[]):
                result, _ = focused_flow.supervise(api, root, workspace, {'SCG_NODE_BIN': '/fixture/node'}, ['/fixture/node', 'pinned-test'], 'plain', sibling=True)
            self.assertTrue(popen.call_args.kwargs['start_new_session'])
            self.assertEqual(result['executableSamples'][0]['executable'], '/fixture/node')
            self.assertEqual(result['executableSamples'][0]['birth'], birth)
            self.assertNotIn('executionTrace', result)
            self.assertIsNone(result['reason'])

    def test_post_run_unknown_root_user_is_recorded_without_unfenced_signal(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            (root / 'logs').mkdir()
            workspace = root / 'src'
            workspace.mkdir()
            birth = ['11', '1', '100', '200']
            api = SimpleNamespace(Refusal=Refusal, LEFTOVER_CHILDREN=[], scope_call=Mock(return_value=[birth]), sample_retained_listeners=Mock(return_value=[]), write_json=lambda path, value, unused: path.write_text(json.dumps(value)))
            process = Mock(returncode=0)
            process.pid = 11
            process.poll.return_value = 0
            busy = focused_flow.focused_seal.BusyRoot([], {'cwd':0,'exe':1,'fd':0})
            with patch('focused_flow.subprocess.Popen', return_value=process), patch('focused_flow.subprocess.run', return_value=subprocess.CompletedProcess([], 3, '', '')) as invoked, patch('focused_flow.os.write', return_value=1), patch('focused_flow.focused_seal.require_quiescent', side_effect=busy):
                result, _ = focused_flow.supervise(api, root, workspace, {'SCG_NODE_BIN': '/fixture/node'}, ['/fixture/node'], 'leftover', sibling=True)
            self.assertIn('run-root process remains', result['reason'])
            self.assertEqual(api.LEFTOVER_CHILDREN, [])
            self.assertNotIn('22', json.dumps(result))
            self.assertNotIn(str(root / 'node'), json.dumps(result))
            self.assertFalse(any(call.args[0][1] == 'signal' and call.args[0][2] == '22' for call in invoked.call_args_list))

    def test_connection_parser_keeps_remote_address_and_fails_unobserved(self):
        birth = ['11', '1', '100', '200']
        with patch('focused_flow.subprocess.run', return_value=subprocess.CompletedProcess([], 0, '4 TCP 192.0.2.1 443\n5 UDP ::1 1234\n', '')):
            row = focused_flow.connection_observation('/scope', birth)
        self.assertFalse(row['connections'][0]['loopback'])
        self.assertTrue(row['connections'][1]['loopback'])
        self.assertEqual(row['birth'], birth)
        for result in (subprocess.CompletedProcess([], 4, '', ''), subprocess.CompletedProcess([], 0, 'truncated', '')):
            with patch('focused_flow.subprocess.run', return_value=result), self.assertRaises(ValueError):
                focused_flow.connection_observation('/scope', birth)

    def test_manifest_partition_is_exact(self):
        data = json.loads((Path(__file__).parent / 'focused-manifest.json').read_text())
        self.assertEqual(sum(len(row['outer']) for row in data['files']), 47)
        self.assertEqual(sum(len(row['sibling']) for row in data['files']), 2)
        self.assertEqual(sum(len(row['excluded']) for row in data['files']), 20)
        for row in data['files']:
            names = row['outer'] + row['sibling'] + row['excluded']
            self.assertEqual(len(names), len(set(names)))
        self.assertTrue(all(not row['sibling'] for row in (data['files'][0], data['files'][2])))


if __name__ == '__main__':
    unittest.main()
