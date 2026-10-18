import json
import os
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
    def test_bootstrap_requires_controller_path_parent_and_exact_launch_birth(self):
        executable = '/Applications/Xcode.app/Contents/Developer/Library/Frameworks/Python3.framework/Versions/3.9/Resources/Python.app/Contents/MacOS/Python'
        controller = {'birth': ['10', '1', '90', '1'], 'executable': executable}
        birth = ['11', '10', '100', '2']
        self.assertTrue(focused_flow.bootstrap_matches(executable, birth, birth, controller, controller['birth']))
        for path, observed, launch, current in (
            ('/usr/bin/python3', birth, birth, controller['birth']),
            ('/Applications/Other/Python', birth, birth, controller['birth']),
            (executable, ['11', '12', '100', '2'], birth, controller['birth']),
            (executable, ['12', '10', '100', '2'], birth, controller['birth']),
            (executable, ['11', '10', '100', '3'], birth, controller['birth']),
            (executable, birth, birth, ['10', '1', '91', '1']),
        ):
            with self.subTest(path=path, birth=observed, controller=current):
                self.assertFalse(focused_flow.bootstrap_matches(path, observed, launch, controller, current))

    def test_controller_executable_is_observed_and_birth_rechecked(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            pid = str(focused_flow.os.getpid())
            birth = [pid, '1', '90', '1']
            api = SimpleNamespace(scope_call=Mock(side_effect=[[birth], [birth]]), write_json=Mock())
            with patch('focused_flow.subprocess.run', return_value=subprocess.CompletedProcess([], 0, '/framework/Python.app/Python\n', '')) as run:
                result = focused_flow.observe_controller(api, root, root / 'scope')
            self.assertEqual(result['executable'], '/framework/Python.app/Python')
            self.assertEqual(result['birth'], birth)
            self.assertEqual(run.call_args.args[0][1:], ['executable', *birth])
            self.assertEqual(api.scope_call.call_count, 2)
            api.write_json.assert_called_once_with(root / 'controller-bootstrap.json', result, root)
            api.scope_call = Mock(side_effect=[[birth], [[pid, '1', '91', '1']]])
            with patch('focused_flow.subprocess.run', return_value=subprocess.CompletedProcess([], 0, '/framework/Python.app/Python\n', '')), self.assertRaisesRegex(ValueError, 'birth changed'):
                focused_flow.observe_controller(api, root, root / 'scope')

    def test_excluded_readoption_name_and_disclosure_are_exact(self):
        data = json.loads((Path(__file__).parent / 'focused-manifest.json').read_text())
        name = 'SIGKILL after in_flight on a surviving HSR generation becomes UNKNOWN and later mail flows'
        item = data['files'][1]
        self.assertNotIn(name, item['outer'] + item['sibling'])
        self.assertEqual(item['excluded'], [name])
        self.assertEqual(item['excludedDisclosures'][name], 'HSR re-adoption on Darwin needs a ps-based zombie census the gate forbids; recovery logic is platform-neutral and proven on Linux (receipt 7668b5f6)')

    def test_tmux_diagnostics_are_bounded_and_grouped_by_exact_row(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'diagnostics'
            path.write_text(json.dumps({'row': 'selected', 'kind': 'tmux-command', 'exit': 7, 'signal': None, 'error': None, 'operation': 'new-session', 'diagnosticFailure': None, 'stderr': {'byteCount': 0, 'sha256': '0' * 64, 'classes': ['empty']}}) + '\n')
            result = focused_flow.load_tmux_diagnostics(path, ['selected'])
            self.assertEqual(result['rows']['selected'][0]['stderr']['classes'], ['empty'])
            clean = json.loads(path.read_text())
            for contaminated in (dict(clean, raw='SECRET_PAYLOAD'), dict(clean, stderr=dict(clean['stderr'], text='SECRET_PAYLOAD'))):
                path.write_text(json.dumps(contaminated) + '\n')
                with self.assertRaisesRegex(ValueError, 'outside selected'):
                    focused_flow.load_tmux_diagnostics(path, ['selected'])
            path.write_text(json.dumps(clean) + '\n')
            with self.assertRaisesRegex(ValueError, 'outside selected'):
                focused_flow.load_tmux_diagnostics(path, ['other'])
            with path.open('wb') as stream:
                stream.truncate(8388609)
            with self.assertRaisesRegex(ValueError, 'oversized'):
                focused_flow.load_tmux_diagnostics(path, ['selected'])

    def test_tmux_observer_faults_and_redaction(self):
        node = os.environ.get('SCG_NODE_BIN')
        if not node:
            self.skipTest('pinned Node not configured')
        result = subprocess.run([node, '--test', str(Path(__file__).parent.resolve() / 'focused-tmux-observer.test.mjs')], capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_tmux_fallback_closed_pipe_and_invalid_stderr_preserve_teardown(self):
        node = os.environ.get('SCG_NODE_BIN')
        if not node:
            self.skipTest('pinned Node not configured')
        preloader = Path(__file__).parent.resolve() / 'focused-tmux-diagnostics.mjs'
        self.assertNotIn('process.stderr', preloader.read_text())
        for mode in ('EPIPE', 'EBADF'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary).resolve()
                binary = root / 'tmux'
                marker = root / 'teardown'
                binary.write_text('#!/bin/sh\ncase "$3" in\nkill-server) echo killed > ' + str(marker) + '; exit 0;;\nlist-panes) exit 0;;\n*) echo original-stderr >&2; exit 7;;\nesac\n')
                binary.chmod(0o700)
                script = root / 'fixture.mjs'
                script.write_text("import {test} from 'node:test'; import {spawnSync} from 'node:child_process'; import {closeSync,writeSync} from 'node:fs'; import assert from 'node:assert/strict'; process.on('SIGPIPE',()=>{}); test('selected',async t=>{t.after(()=>{const r=spawnSync('tmux',['-S'," + json.dumps(str(root / 'socket')) + ",'kill-server']); assert.equal(r.status,0);}); " + ('closeSync(2);' if mode == 'EBADF' else '') + "assert.throws(()=>writeSync(2,'probe'),{code:" + json.dumps(mode) + "}); const r=spawnSync('tmux',['-S'," + json.dumps(str(root / 'socket')) + ",'new-session'],{encoding:'utf8'}); assert.equal(r.status,7); assert.equal(r.stderr.trim(),'original-stderr'); await new Promise(resolve=>setImmediate(resolve));});\n")
                if mode == 'EBADF':
                    script.write_text("import {test} from 'node:test'; import cp from 'node:child_process'; import {closeSync,writeSync,openSync,writeFileSync} from 'node:fs'; import assert from 'node:assert/strict'; const original={status:7,signal:null,error:null,stderr:'original-stderr',stdout:''}; cp.spawnSync=(_cmd,args)=>{if(args[2]==='kill-server'){writeFileSync(" + json.dumps(str(marker)) + ",'killed\\n');return {...original,status:0};} return original;}; await import(" + json.dumps(preloader.as_uri()) + "); test('selected',async t=>{t.after(()=>assert.equal(cp.spawnSync('tmux',['-S'," + json.dumps(str(root / 'socket')) + ",'kill-server']).status,0)); closeSync(2); try {assert.throws(()=>writeSync(2,'probe'),{code:'EBADF'}); const r=cp.spawnSync('tmux',['-S'," + json.dumps(str(root / 'socket')) + ",'new-session']); assert.equal(r,original);} finally {assert.equal(openSync('/dev/null','w'),2);} await new Promise(resolve=>setImmediate(resolve));});\n")
                read_fd, write_fd = os.pipe()
                os.close(read_fd)
                try:
                    argv = [node, str(script)] if mode == 'EBADF' else [node, '--import', str(preloader), str(script)]
                    result = subprocess.run(argv, env={'PATH': str(root) + ':/usr/bin:/bin', 'HOME': str(root), 'TMPDIR': str(root), 'SCG_TMUX_DIAGNOSTIC_FILE': str(root / 'missing' / 'diagnostic')}, stdout=subprocess.PIPE, stderr=write_fd, text=True, timeout=15)
                finally:
                    os.close(write_fd)
                self.assertEqual(result.returncode, 0, result.stdout)
                self.assertIn('pass 1', result.stdout)
                self.assertNotIn('uncaughtException', result.stdout)
                self.assertEqual(marker.read_text(), 'killed\n')

    def test_tmux_preload_preserves_status_and_captures_before_teardown(self):
        node = os.environ.get('SCG_NODE_BIN')
        if not node:
            self.skipTest('pinned Node not configured')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            binary = root / 'tmux'
            binary.write_text('#!/bin/sh\ncase "$3" in\nlist-panes) echo %1;;\ncapture-pane) echo fixture-terminal;;\nkill-server) exit 0;;\n*) echo fixture-pty-denied >&2; exit 7;;\nesac\n')
            binary.chmod(0o700)
            evidence = root / 'diagnostics'
            evidence.touch(mode=0o600)
            script = root / 'fixture.test.mjs'
            script.write_text("import {test} from 'node:test'; import {spawnSync} from 'node:child_process'; import assert from 'node:assert/strict'; test('selected',()=>{const r=spawnSync('tmux',['-S'," + json.dumps(str(root / 'socket')) + ", 'new-session'],{encoding:'utf8'}); assert.equal(r.status,7); assert.equal(r.stderr.trim(),'fixture-pty-denied'); spawnSync('tmux',['-S'," + json.dumps(str(root / 'socket')) + ", 'kill-server']);});\n")
            preloader = Path(__file__).parent.resolve() / 'focused-tmux-diagnostics.mjs'
            result = subprocess.run([node, '--import', str(preloader), '--test', str(script)], env={'PATH': str(root) + ':/usr/bin:/bin', 'HOME': str(root), 'TMPDIR': str(root), 'SCG_TMUX_DIAGNOSTIC_FILE': str(evidence)}, capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            data = focused_flow.load_tmux_diagnostics(evidence, ['selected'])['rows']['selected']
            self.assertTrue(any(row.get('exit') == 7 and row.get('stderr', {}).get('classes') == ['other_nonempty'] for row in data))
            self.assertTrue(any(row.get('pane', {}).get('byteCount') == len('fixture-terminal\n') for row in data))
            self.assertNotIn('fixture-terminal', evidence.read_text())
            self.assertNotIn('fixture-pty-denied', evidence.read_text())
            self.assertLess(next(i for i, row in enumerate(data) if row['kind'] == 'terminal-capture'), next(i for i, row in enumerate(data) if row.get('operation') == 'kill-server'))

    def test_tmux_config_is_absent_and_confined_to_fake_home(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            home = root / 'h'
            home.mkdir()
            env = {'HOME': str(home), 'XDG_CONFIG_HOME': str(home / '.config')}
            self.assertTrue(focused_flow.require_tmux_config_absent(root, env)['ok'])
            with self.assertRaisesRegex(ValueError, 'outside fake HOME'):
                focused_flow.require_tmux_config_absent(root, dict(env, XDG_CONFIG_HOME=str(root / 'config')))
            (home / '.tmux.conf').write_text('fixture')
            with self.assertRaisesRegex(ValueError, 'configuration present'):
                focused_flow.require_tmux_config_absent(root, env)
            (home / '.tmux.conf').unlink()
            (home / '.config').symlink_to(root)
            with self.assertRaisesRegex(ValueError, 'redirected'):
                focused_flow.require_tmux_config_absent(root, env)

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
            import guard
            partial = subprocess.CompletedProcess([], 4, '3 TCP 0.0.0.0 1234\n', '')
            gone = subprocess.CompletedProcess([], 3, 'gone', '')
            with patch('guard.subprocess.run', side_effect=[partial, gone]):
                sample = guard.sample_listeners(root / 'scope', parent)
            self.assertNotIn('error', sample)
            api = SimpleNamespace(Refusal=Refusal, LEFTOVER_CHILDREN=[], scope_call=Mock(side_effect=[[parent], [parent, child]]), sample_retained_listeners=Mock(return_value=[sample]), write_json=lambda path, value, unused: path.write_text(json.dumps(value)))
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

    def test_complete_role_birth_survives_both_gone_sampling_orderings(self):
        for case in ('executable-gone', 'observation-gone', 'never-observed', 'wrong-prior-birth', 'birth-mismatch', 'other-error', 'shortfall'):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary).resolve()
                (root / 'logs').mkdir()
                workspace = root / 'src'
                workspace.mkdir()
                births = [['11', '1', '100', '1'], ['12', '11', '101', '1'], ['13', '12', '102', '1'], ['14', '13', '103', '1']]
                entries = [str(workspace / 'test.ts'), str(workspace / 'host.ts'), str(workspace / 'reader.mjs')]
                mediation = SimpleNamespace(helper=root / 'scope', entries=dict(zip(entries, ('test-runner', 'runner-host-main', 'reader'))), reader=entries[2], parent_close=Mock(), check_deaths=Mock(), finish=Mock(return_value={'ok': True}), close=Mock(), observe_reader=Mock(), requests=[], records={})
                api = SimpleNamespace(Refusal=Refusal, LEFTOVER_CHILDREN=[], scope_call=Mock(side_effect=[[births[0]], births[:-1] if case == 'shortfall' else births, births[:-1] if case == 'shortfall' else births]), sample_retained_listeners=Mock(return_value=[]), write_json=lambda path, value, unused: path.write_text(json.dumps(value)))
                process = Mock(returncode=0, pid=11)
                process.poll.side_effect = [None, None, 0]
                visits = {}
                def helper(argv, **unused):
                    operation, pid = argv[1], argv[2]
                    if operation == 'status':
                        return subprocess.CompletedProcess(argv, 3, '', '')
                    if operation == 'connections':
                        return subprocess.CompletedProcess(argv, 0, '', '')
                    if operation == 'executable':
                        visits[pid] = visits.get(pid, 0) + 1
                        if pid == '12' and visits[pid] == 2 and case == 'executable-gone':
                            return subprocess.CompletedProcess(argv, 3, '', '')
                        return subprocess.CompletedProcess(argv, 0, '/pinned/node', '')
                    if operation == 'node-observation':
                        late = pid == '12' and visits[pid] == 2
                        if pid == '12' and case == 'never-observed':
                            return subprocess.CompletedProcess(argv, 3, '', '')
                        if late and case in ('observation-gone', 'wrong-prior-birth', 'birth-mismatch', 'other-error', 'shortfall'):
                            if case == 'wrong-prior-birth':
                                old = mediation.roles.identities[12]
                                mediation.roles.identities[12] = (('12', '11', '999', '1'), old[1], old[2])
                            return subprocess.CompletedProcess(argv, 4 if case in ('birth-mismatch', 'other-error') else 3, '', '')
                        entry = entries[0] if pid in ('11', '12') else entries[1] if pid == '13' else entries[2]
                        return subprocess.CompletedProcess(argv, 0, 'NODE /pinned/node\nENTRY ' + entry + '\nCWD ' + str(workspace) + '\nSANDBOX ' + ('1' if pid == '14' else '0') + '\n', '')
                    raise AssertionError(operation)
                with patch('focused_flow.subprocess.Popen', return_value=process), patch('focused_flow.subprocess.run', side_effect=helper), patch('focused_flow.time.sleep'), patch('focused_flow.os.write', return_value=1), patch('focused_flow.focused_seal.require_quiescent', return_value=[]):
                    result, _ = focused_flow.supervise(api, root, workspace, {'SCG_NODE_BIN': '/pinned/node'}, ['/pinned/node'], case, sibling=True, mediation=mediation)
                if case in ('executable-gone', 'observation-gone'):
                    self.assertIsNone(result['reason'])
                    self.assertTrue(result['nodeEntryRoles']['ok'])
                    if case == 'observation-gone':
                        sample = next(row for row in result['executableSamples'] if row.get('observationStatus'))
                        self.assertEqual(sample['observationStatus'], 'verified-gone-after-complete-observation')
                        self.assertNotIn('roleObservation', sample)
                elif case == 'shortfall':
                    self.assertIn('recipient profile or signal mediation failed', result['reason'])
                    self.assertIn('missing or duplicate Node entry role observation', result['recipientMediation']['error'])
                else:
                    self.assertIn('own Node argv/cwd/sandbox observation unresolved', result['reason'])
                self.assertFalse(any(row.get('observationStatus') for row in result['executableSamples']) and case not in ('observation-gone', 'shortfall'))

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

    def test_partial_connection_before_verified_gone_is_retained_and_rejected(self):
        birth = ['11','1','100','200']
        for code in (0,3):
            with patch('focused_flow.subprocess.run', return_value=subprocess.CompletedProcess([], code, '4 TCP 192.0.2.1 443\n', '')):
                row = focused_flow.connection_observation('/scope', birth)
            self.assertFalse(row['connections'][0]['loopback'])
        for code, stdout in ((3,'truncated'),(3,'4 TCP 192.0.2.1 443'),(3,'4 TCP invalid 443\n'),(4,'4 TCP 192.0.2.1 443\n')):
            with patch('focused_flow.subprocess.run', return_value=subprocess.CompletedProcess([], code, stdout, '')), self.assertRaises(ValueError):
                focused_flow.connection_observation('/scope', birth)
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary).resolve();(root/'logs').mkdir();workspace=root/'src';workspace.mkdir()
            api=SimpleNamespace(Refusal=Refusal,LEFTOVER_CHILDREN=[],scope_call=Mock(side_effect=[[birth],[birth]]),sample_retained_listeners=Mock(return_value=[]),write_json=lambda path,value,unused:path.write_text(json.dumps(value)))
            process=Mock(returncode=-15);process.pid=11;process.poll.return_value=None
            def helper(argv, **unused):
                if argv[1]=='connections':return subprocess.CompletedProcess(argv,3,'4 TCP 192.0.2.1 443\n','')
                return subprocess.CompletedProcess(argv,3,'gone','')
            with patch('focused_flow.subprocess.Popen',return_value=process),patch('focused_flow.subprocess.run',side_effect=helper),patch('focused_flow.os.write',return_value=1),patch('focused_flow.time.sleep'),patch('focused_flow.focused_seal.require_quiescent',return_value=[]):
                result,_=focused_flow.supervise(api,root,workspace,{'SCG_NODE_BIN':'/fixture/node'},['/fixture/node','test'],'partial-connection',sibling=True)
            self.assertEqual(result['reason'],'non-loopback own connection')
            self.assertFalse(result['connectionSamples'][0]['connections'][0]['loopback'])

    def test_manifest_partition_is_exact(self):
        data = json.loads((Path(__file__).parent / 'focused-manifest.json').read_text())
        self.assertEqual(sum(len(row['outer']) for row in data['files']), 46)
        self.assertEqual(sum(len(row['sibling']) for row in data['files']), 2)
        self.assertEqual(sum(len(row['excluded']) for row in data['files']), 21)
        for row in data['files']:
            names = row['outer'] + row['sibling'] + row['excluded']
            self.assertEqual(len(names), len(set(names)))
        self.assertTrue(all(not row['sibling'] for row in (data['files'][0], data['files'][2])))


if __name__ == '__main__':
    unittest.main()
