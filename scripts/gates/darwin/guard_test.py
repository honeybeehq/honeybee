import ast
from enum import IntEnum
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
from pathlib import Path
import sys
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import node_bootstrap
import guard
import listener_static
import git_boundary

from guard import DIRS, PROTECTED, Refusal, absolute_compiler_jobs, close_socket_controls, compiler_metadata_literals, compiler_profile, compiler_tools, environment, launchagents, make_socket_controls, profile, receipt_hashes, run, seed_cache, select_node, validate, write_json


class GuardTests(unittest.TestCase):
    def test_git_sealed_target_deny_follows_root_allow(self):
        policy = profile(self.base, self.base / 'real-home', self.base / 'lane')
        allowed = '(allow file-write* (subpath ' + json.dumps(str(self.base)) + '))'
        denied = '(deny file-write* (subpath ' + json.dumps(str(self.base / 'sealed-target')) + '))'
        self.assertGreater(policy.index(denied), policy.index(allowed))

    def test_git_boundary_requires_permission_evidence_for_every_row(self):
        controls = {'git': git_boundary.GIT_CANDIDATES[0], 'target': str(self.base / 'sealed-target'), 'source': str(self.base / 'git-source')}
        (self.base / 'git-controls.json').write_text(json.dumps(controls))
        refused = subprocess.CompletedProcess([], 128, '', 'Operation not permitted')
        with patch('git_boundary.subprocess.run', side_effect=[subprocess.CompletedProcess([], 0, '', ''), refused, refused, refused]) as calls:
            git_boundary.workload(self.base)
        rows = json.loads((self.base / 'git-boundary-workload.json').read_text())
        self.assertTrue(rows['allDenied'])
        self.assertEqual(len(rows['rows']), 3)
        self.assertEqual(calls.call_args_list[2].args[0][-1], 'https://192.0.2.1/x.git')
        with patch('git_boundary.subprocess.run', side_effect=[subprocess.CompletedProcess([], 0, '', ''), subprocess.CompletedProcess([], 128, '', 'Could not resolve host')]), self.assertRaisesRegex(ValueError, 'lacks permission-denial evidence'):
            git_boundary.workload(self.base)
        self.assertFalse(json.loads((self.base / 'git-boundary-workload.json').read_text())['allDenied'])

    def test_git_target_snapshot_detects_ref_or_object_changes(self):
        target = self.base / 'sealed-target'
        (target / 'objects').mkdir(parents=True)
        (target / 'refs').mkdir()
        path = target / 'objects/object'
        path.write_bytes(b'original')
        before = git_boundary.snapshot(target)
        path.write_bytes(b'changed')
        self.assertNotEqual(before, git_boundary.snapshot(target))
        path.unlink()
        path.symlink_to(self.base / 'elsewhere')
        with self.assertRaisesRegex(ValueError, 'non-regular'):
            git_boundary.snapshot(target)

    def test_stamped_shell_entries_refuse_before_other_commands(self):
        directory = Path(__file__).parent
        for name in ('gate-run.sh', 'darwin-gate.sh'):
            for key in ('APIARY_TEST_STAMP', 'HIVE_TEST_STAMP'):
                env = {'PATH': '/usr/bin:/bin', 'HOME': str(self.base), key: 'must-never-be-printed'}
                result = subprocess.run(['/bin/sh', str(directory / name)], env=env, cwd=self.base, capture_output=True, text=True)
                self.assertEqual(result.returncode, 90)
                self.assertEqual(result.stdout.strip(), 'REFUSING: stamped controller environment: ' + key)
                self.assertNotIn('must-never-be-printed', result.stdout + result.stderr)
            env = {'PATH': '/usr/bin:/bin', 'HOME': str(self.base), 'HIVE_Z': 'secret-z', 'APIARY_A': 'secret-a'}
            result = subprocess.run(['/bin/sh', str(directory / name)], env=env, cwd=self.base, capture_output=True, text=True)
            self.assertEqual(result.returncode, 90)
            self.assertEqual(result.stdout.strip(), 'REFUSING: stamped controller environment: APIARY_A,HIVE_Z')
            self.assertNotIn('secret-', result.stdout + result.stderr)

    def test_stamped_python_controller_refuses_before_identity_or_write(self):
        with patch.dict(os.environ, {'APIARY_TEST_STAMP': 'not-printed'}, clear=True), patch('guard.pwd.getpwuid') as passwd, patch('guard.os.open') as opened, self.assertRaisesRegex(Refusal, 'stamped controller environment'):
            run(SimpleNamespace())
        passwd.assert_not_called()
        opened.assert_not_called()

    def test_tool_home_entry_key_is_ignored_and_unset(self):
        import guard
        for extras, refusal in (({}, 'passwd identity unavailable'), ({'APIARY_AGENT_TOKEN': 'never-print'}, 'stamped controller environment: APIARY_AGENT_TOKEN'), ({'HIVE_REAL_HOMEX': 'never-print'}, 'stamped controller environment: HIVE_REAL_HOMEX')):
            with patch.dict(os.environ, dict({'HIVE_REAL_HOME': 'never-use'}, **extras), clear=True), patch('guard.pwd.getpwuid', side_effect=KeyError()), self.assertRaisesRegex(Refusal, refusal):
                try:
                    run(SimpleNamespace())
                finally:
                    self.assertNotIn('HIVE_REAL_HOME', os.environ)
                    self.assertEqual(guard.ENTRY_NOTES, ['HIVE_REAL_HOME present at entry (tool-injected, ignored, unset)'])
        directory = Path(__file__).parent
        for name in ('gate-run.sh', 'darwin-gate.sh'):
            for key in ('APIARY_AGENT_TOKEN', 'HIVE_REAL_HOMEX'):
                result = subprocess.run(['/bin/sh', str(directory / name)], env={'PATH': '/usr/bin:/bin', 'HIVE_REAL_HOME': 'never-use', key: 'never-print'}, cwd=self.base, capture_output=True, text=True)
                self.assertEqual(result.returncode, 90)
                self.assertEqual(result.stdout.strip(), 'REFUSING: stamped controller environment: ' + key)

    def test_lock_refuses_symlink_wrong_mode_and_nonempty(self):
        path = self.base / 'lock'
        target = self.base / 'target'
        target.touch(mode=0o600)
        path.symlink_to(target)
        with self.assertRaises(Refusal):
            guard.acquire_lock(path)
        path.unlink()
        path.touch(mode=0o644)
        with self.assertRaises(Refusal):
            guard.acquire_lock(path)
        path.chmod(0o600)
        path.write_text('nonempty')
        with self.assertRaises(Refusal):
            guard.acquire_lock(path)

    def test_lock_metadata_and_wrong_owner(self):
        path = self.base / 'lock'
        fd, record = guard.acquire_lock(path)
        os.close(fd)
        self.assertEqual(record['mode'], 0o600)
        self.assertEqual(record['size'], 0)
        self.assertEqual(record['uid'], os.getuid())
        self.assertEqual(record['ino'], path.stat().st_ino)
        with patch('guard.os.getuid', return_value=os.getuid() + 1), self.assertRaises(Refusal):
            guard.acquire_lock(path)

    def test_retained_reparented_birth_still_sampled(self):
        birth = ['100', '99', '10', '20']
        key = ('100', '10', '20')
        retained = {key: birth}
        exited = set()
        sample = {'pid': 100, 'birth': birth, 'listeners': [{'loopback': False, 'proto': 'TCP', 'localAddress': '0.0.0.0'}]}
        with patch('guard.sample_listeners', return_value=sample) as observed:
            rows = guard.sample_retained_listeners(Path('/root/scope'), retained, exited)
        observed.assert_called_once_with(Path('/root/scope'), birth)
        self.assertFalse(rows[0]['listeners'][0]['loopback'])
        self.assertEqual(exited, set())
        gone = {'pid': 100, 'birth': birth, 'listeners': [], 'exitEvidence': {'exit': 3, 'result': 'gone'}}
        with patch('guard.sample_listeners', return_value=gone):
            guard.sample_retained_listeners(Path('/root/scope'), retained, exited)
        with patch('guard.sample_listeners') as observed:
            self.assertEqual(guard.sample_retained_listeners(Path('/root/scope'), retained, exited), [])
            observed.assert_not_called()
    def test_native_scan_uses_child_counts_and_fails_on_errno(self):
        if sys.platform == 'darwin':
            self.skipTest('portable stub regression runs on Linux; Darwin uses the physical tree preflight')
        compiler = shutil.which('cc')
        self.assertIsNotNone(compiler)
        source = (Path(__file__).parent / 'scope.c').read_text()
        scan = source[source.index('static int scan('):source.index('int main(')]
        harness = r'''
#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
struct proc_bsdinfo { int pbi_ppid; unsigned long long pbi_start_tvsec, pbi_start_tvusec; };
static int mode;
static int identity(int pid, struct proc_bsdinfo *b) { b->pbi_ppid=pid-1; b->pbi_start_tvsec=1; b->pbi_start_tvusec=2; return 1; }
static void print_identity(int pid, struct proc_bsdinfo *b) { printf("%d\n",pid); }
static int proc_listchildpids(int pid, void *buffer, int bytes) {
  if (mode==1 || (mode==2 && buffer)) { errno=EACCES; return 0; }
  if (!buffer) return pid<102 ? 1 : 0;
  if (mode==3) return bytes/sizeof(int);
  if (pid<102) { ((int *)buffer)[0]=pid+1; return 1; }
  return 0;
}
'''
        file = self.base / 'scan-count.c'
        file.write_text(harness + scan + '\nint main(int argc,char **argv) { mode=atoi(argv[1]); return scan(100,1,2,0); }\n')
        executable = self.base / 'scan-count'
        subprocess.run([compiler, str(file), '-o', str(executable)], check=True, capture_output=True)
        good = subprocess.run([str(executable), '0'], capture_output=True, text=True)
        self.assertEqual(good.returncode, 0)
        self.assertEqual(good.stdout.splitlines(), ['100', '101', '102'])
        for mode in ('1', '2', '3'):
            self.assertEqual(subprocess.run([str(executable), mode], capture_output=True).returncode, 4)

    def test_reparent_failure_records_and_fences_discovered_children(self):
        parent_birth = ['12345', str(os.getpid()), '10', '20']
        child_birth = ['12346', '12345', '10', '21']
        process = unittest.mock.MagicMock()
        process.pid = 12345
        process.poll.return_value = None
        process.args = ['fixture-parent']
        process.wait.return_value = -15
        replies = [[parent_birth], [parent_birth, child_birth], Refusal('forced acquisition failure'), [parent_birth]]
        helper_result = subprocess.CompletedProcess([], 3, 'gone', '')
        with patch('guard.subprocess.Popen', return_value=process), patch('guard.os.write'), patch('guard.scope_call', side_effect=replies), patch('guard.subprocess.run', return_value=helper_result) as invoked, patch('guard.time.sleep'), self.assertRaisesRegex(Refusal, 'forced acquisition failure'):
            guard.reparent_listener_self_test(self.base, self.base, [], self.base / 'scope', {'SCG_PYTHON_BIN': sys.executable})
        result = json.loads((self.base / 'listener-reparent-self-test.json').read_text())
        self.assertEqual(result['failure'], 'forced acquisition failure')
        self.assertTrue((self.base / 'reparent-abort').exists())
        signalled = [call.args[0][2:6] for call in invoked.call_args_list if call.args[0][1] == 'signal']
        self.assertIn(child_birth, signalled)
        self.assertIn(parent_birth, signalled)

    def test_tree_preflight_cleans_descendant_after_root_nonzero_exit(self):
        rows = [['12345', str(os.getpid()), '10', '20'], ['12346', '12345', '10', '21'], ['12347', '12346', '10', '22']]
        (self.base / 'tree-child-pid').write_text('12346')
        (self.base / 'tree-grandchild-pid').write_text('12347')
        process = unittest.mock.MagicMock()
        process.pid = 12345
        process.wait.return_value = 1
        gone = {'12345'}
        def helper(argv, **kwargs):
            if argv[1] == 'signal':
                gone.add(argv[2])
                return subprocess.CompletedProcess(argv, 0, '', '')
            return subprocess.CompletedProcess(argv, 3 if argv[2] in gone else 0, '', '')
        with patch('guard.subprocess.Popen', return_value=process), patch('guard.scope_call', side_effect=[[rows[0]], rows]), patch('guard.subprocess.run', side_effect=helper) as invoked, self.assertRaisesRegex(Refusal, 'root exited nonzero'):
            guard.tree_scan_self_test(self.base, self.base, [], self.base / 'scope', {'SCG_PYTHON_BIN': sys.executable})
        self.assertEqual(gone, {'12345', '12346', '12347'})
        self.assertTrue(any(call.args[0][1:3] == ['signal', '12346'] for call in invoked.call_args_list))

    def test_tree_preflight_is_unconditional(self):
        tree = ast.parse((Path(__file__).parent / 'guard.py').read_text())
        run_node = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'run')
        calls = [node for node in run_node.body if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Name) and node.value.func.id == 'tree_scan_self_test']
        self.assertEqual(len(calls), 1)

    def test_gate_shell_diagnostics_never_dump_environment_values(self):
        def unsafe(text):
            if 'HIVE_/APIARY_=[' in text or re.search(r'\b(?:printenv|export\s+-p|declare\s+-x)\b', text):
                return True
            return any(not re.match(r'\s*(?:/usr/bin/)?cut\s+-d=\s+-f1\s*\|', tail) for tail in re.findall(r'\benv\s*\|([^\n]*)', text))

        self.assertTrue(unsafe("env | grep -E '^(HIVE_|APIARY_)'"))
        self.assertFalse(unsafe("env | cut -d= -f1 | grep -E '^(HIVE_|APIARY_)'"))
        for directory in (Path(__file__).parent, Path(__file__).parent.parent / 'linux'):
            for path in directory.glob('*.sh'):
                with self.subTest(path=path.name):
                    self.assertFalse(unsafe(path.read_text()))

    def test_static_listener_negative_and_loopback_rows(self):
        for source in ('server.listen(0)', 'server["listen"](0)', 'server.listen(0, () => {})', 'server.listen({port: 0})', 'server.listen({port: 0, host: undefined})', "server.listen(0, '0.0.0.0')", "server.listen(0, '::')", "import dgram from 'node:dgram';socket.bind(0, '0.0.0.0')", "import 'node:dgram';socket.bind()", "require('dgram');socket.bind(port)", 'server.listen(path)', 'import socket\nsocket.bind((host, port))'):
            self.assertTrue(listener_static.violations(source), source)
        for source in ("server.listen(0, '127.0.0.1')", "server.listen(0, '::1')", "server.listen('/private/var/tmp/root/socket')", "import socket\nsocket.bind(('127.0.0.1', 0))", 'function.bind(this)', 'function.bind(null)', 'function.bind(undefined)'):
            self.assertFalse(listener_static.violations(source), source)
        rows = listener_static.scan(Path(__file__).resolve().parents[3])
        write_json(self.base / 'static-census.json', rows, self.base)
        print('STATIC_LISTENER_CENSUS=' + json.dumps(rows))
        self.assertEqual(rows, [])

    def test_importing_module_bind_and_options_overloads_fail_closed(self):
        importing = "import dgram from 'node:dgram';\n"
        for source in ('socket.bind(undefined)', 'socket.bind(null)', 'socket.bind(this)', 'socket.bind()', "server.listen({port: 0}, '127.0.0.1')", "server.listen({port: 0, ...options}, '127.0.0.1')", "server.listen(options, '127.0.0.1')", "server.listen({port:0,host:'127.0.0.1',...options})", "server.listen({port:0,host:'127.0.0.1',host:other})"):
            self.assertTrue(listener_static.violations(importing + source), source)
        for source in ("socket.bind(0, '127.0.0.1')", "server.listen(0, '127.0.0.1')", "server.listen({port:0,host:'127.0.0.1'})", "server.listen({host:'::1',port:0}, callback)"):
            self.assertFalse(listener_static.violations(importing + source), source)

    def test_bind_object_overloads_need_audit(self):
        importing = "import dgram from 'node:dgram';\n"
        for source in ("socket.bind({port:0,host:'127.0.0.1'})", "socket.bind({port:0,address:'127.0.0.1'})", "socket.bind({port:0,host:'127.0.0.1',address:target})"):
            self.assertTrue(listener_static.violations(importing + source), source)

    def test_static_allowlist_changed_fingerprint_fails(self):
        folder = self.base / 'tests'
        folder.mkdir()
        source = folder / 'unix.test.ts'
        source.write_text('const server = new RpcServer({socketPath});\n\n\n\n\n\nserver.listen();\n')
        row = listener_static.scan(self.base, allowlist=[])[0]
        digest = hashlib.sha256(source.read_text().splitlines()[0].encode()).hexdigest()
        approved = [{'file': row['file'], 'sha256': row['sha256'], 'receiverDeclaration': {'file': row['file'], 'startLine': 1, 'endLine': 1, 'sha256': digest}, 'fingerprintSha256': hashlib.sha256((row['sha256']+'\n'+digest).encode()).hexdigest(), 'reason': 'test RpcServer declaration line1'}]
        self.assertEqual(listener_static.scan(self.base, approved), [])
        source.write_text('const server = createServer();\n\n\n\n\n\nserver.listen();\n')
        changed = listener_static.scan(self.base, approved)
        self.assertEqual(len(changed), 2)
        self.assertTrue(any('fingerprint missing or changed' in item['reason'] for item in changed))

    def test_unknown_extension_and_python_bind_fail_closed(self):
        folder = self.base / 'tests'
        folder.mkdir()
        (folder / 'unknown.weird').write_text('custom listen target')
        (folder / 'socket.py').write_text('import socket\nsocket.bind((host, port))\n')
        rows = listener_static.scan(self.base, [])
        self.assertEqual(len(rows), 2)
        self.assertEqual({row['file'] for row in rows}, {'tests/unknown.weird', 'tests/socket.py'})

    def test_receipt_includes_listener_limit(self):
        target = self.base / 'receipt.json'
        write_json(target, {'exit': 0}, self.base)
        self.assertEqual(json.loads(target.read_text())['listenerLimit'], guard.LISTENER_LIMIT)
        self.assertEqual(json.loads(target.read_text())['staticBindLimit'], guard.STATIC_BIND_LIMIT)

    def test_listener_sampler_accepts_only_loopback(self):
        birth = ['100', '99', '10', '20']
        value = SimpleNamespace(returncode=0, stdout='3 TCP 127.2.3.4 1234\n4 UDP ::1 1235\n5 TCP 0.0.0.0 1236\n6 UDP :: 1237\n', stderr='')
        with patch('guard.subprocess.run', return_value=value) as called:
            result = guard.sample_listeners(Path('/root/scope'), birth)
        self.assertEqual(called.call_args.args[0], ['/root/scope', 'listeners', *birth])
        self.assertEqual([row['loopback'] for row in result['listeners']], [True, True, False, False])
        self.assertTrue(all(row['birth'] == birth and row['pid'] == 100 for row in result['listeners']))

    def test_listener_sampler_unresolved_is_failure(self):
        bad = SimpleNamespace(returncode=4, stdout='', stderr='denied')
        for status_code in (0, 4):
            with patch('guard.subprocess.run', side_effect=[bad, SimpleNamespace(returncode=status_code, stdout='same-birth-alive', stderr='')]):
                self.assertIn('error', guard.sample_listeners(Path('/root/scope'), ['100', '99', '10', '20']))

    def test_signal_arguments_are_numeric_on_python39(self):
        class LegacySignal(IntEnum):
            SIGTERM = 15
            SIGKILL = 9

            def __str__(self):
                return 'Signals.' + self.name

        count = 0
        for filename in ('guard.py', 'physical_test.py'):
            tree = ast.parse(Path(__file__).with_name(filename).read_text())
            for node in ast.walk(tree):
                if not isinstance(node, ast.List) or not any(isinstance(item, ast.Constant) and item.value == 'signal' for item in node.elts):
                    continue
                expression = ast.Expression(node.elts[-1])
                for sig in LegacySignal:
                    value = eval(compile(expression, filename, 'eval'), {'sig': sig, 'signal': SimpleNamespace(SIGTERM=sig)})
                    self.assertEqual(value, str(int(sig)))
                count += 1
        self.assertEqual(count, 7)

    def test_profile_parentheses_balance_outside_strings(self):
        text = profile(Path('/private/var/tmp/g.test'), Path('/Users/example'), Path('/lane'))
        depth = 0
        quoted = False
        escaped = False
        for char in text:
            if escaped:
                escaped = False
            elif quoted and char == '\\':
                escaped = True
            elif char == '"':
                quoted = not quoted
            elif not quoted:
                depth += (char == '(') - (char == ')')
                self.assertGreaterEqual(depth, 0)
        self.assertFalse(quoted)
        self.assertEqual(depth, 0)

    def test_python39_grammar(self):
        for path in Path(__file__).parent.glob('*.py'):
            with self.subTest(path=path.name):
                ast.parse(path.read_text(), feature_version=9)

    def test_legacy_bodies_refuse_before_work(self):
        directory = Path(__file__).parent.resolve()
        before = sorted(self.base.iterdir())
        for name in ('pinned-runtime-body.sh', 'pinned-full-body.sh'):
            for argv in (['/bin/sh', str(directory / name)], ['/bin/sh', str(directory / 'gate-run.sh'), '--execute', 'scripts/gates/darwin/' + name, '0' * 40]):
                env = {key: value for key, value in self.env.items() if not key.startswith(('HIVE_', 'APIARY_'))}
                result = subprocess.run(argv, cwd=self.base, env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 88)
                self.assertEqual(json.loads(result.stderr)['code'], 'darwin_gate_body_unsupported_until_audited')
        self.assertEqual(sorted(self.base.iterdir()), before)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ['LAB_ROOT'])
        self.base = Path(self.tmp.name)
        self.home = self.base / 'real-home'
        self.home.mkdir()
        self.root = self.base / 'g.run'
        self.env = environment(self.root, '/usr/local/bin/node')

    def tearDown(self):
        self.tmp.cleanup()

    def check(self, env=None, root=None):
        return validate(root or self.root, env or self.env, self.home, self.base)

    def test_valid_plan_before_any_write(self):
        self.assertTrue(self.check()['beforeFirstWrite'])
        self.assertFalse(self.root.exists())

    def test_actual_entry_refuses_before_lock_open_or_mkdir(self):
        args = SimpleNamespace(root=str(self.home), node='/usr/local/bin/node')
        with patch('guard.select_node', return_value='/usr/local/bin/node'), patch('os.open') as opened, patch.object(Path, 'mkdir') as mkdir, self.assertRaises(Refusal):
            run(args)
        opened.assert_not_called()
        mkdir.assert_not_called()

    def test_missing_passwd_identity_refuses_before_any_write(self):
        args = SimpleNamespace(root=str(self.root), node='/usr/local/bin/node')
        for error in (KeyError('uid unavailable'), OSError('lookup unavailable')):
            with patch.dict(os.environ, {}, clear=True), patch('guard.pwd.getpwuid', side_effect=error), patch('os.open') as opened, patch.object(Path, 'mkdir') as mkdir, self.assertRaisesRegex(Refusal, 'passwd identity unavailable'):
                run(args)
            opened.assert_not_called()
            mkdir.assert_not_called()

    def test_refusal_prints_one_line_stdout_reason(self):
        output = io.StringIO()
        errors = io.StringIO()
        argv = ['guard.py', '--root', str(self.root), '--source', '0' * 40, 'self-test-body']
        with patch.object(sys, 'argv', argv), patch.object(sys, 'stdout', output), patch.object(sys, 'stderr', errors), patch('guard.run', side_effect=Refusal('test refusal')):
            self.assertEqual(guard.main(), 90)
        self.assertEqual(output.getvalue().splitlines(), ['GATE_NONZERO_REASON="guard refusal: test refusal"'])
        self.assertFalse(self.root.exists())

    def waiting_child(self):
        target = self.base / 'effect.py'
        effect = self.base / 'effect'
        target.write_text('from pathlib import Path\nPath(' + repr(str(effect)) + ').write_text("effect")\n')
        read_fd, write_fd = os.pipe()
        child = subprocess.Popen([sys.executable, '-B', str(Path(__file__).with_name('start_wait.py')), str(read_fd), sys.executable, '-B', str(target)], pass_fds=(read_fd,))
        os.close(read_fd)
        return child, write_fd, effect

    def test_start_wait_eof_has_zero_effects(self):
        child, release, effect = self.waiting_child()
        os.close(release)
        self.assertEqual(child.wait(timeout=5), 70)
        self.assertFalse(effect.exists())

    def test_start_wait_requires_explicit_release(self):
        child, release, effect = self.waiting_child()
        self.assertFalse(effect.exists())
        os.write(release, b'1')
        os.close(release)
        self.assertEqual(child.wait(timeout=5), 0)
        self.assertEqual(effect.read_text(), 'effect')

    def test_node_from_real_home_refuses(self):
        with self.assertRaises(Refusal):
            select_node(str(self.home / '.local/bin/node'), self.home)

    def test_node_path_must_be_absolute(self):
        with self.assertRaises(Refusal):
            select_node('node', self.home)

    def test_missing_compiler_refuses_with_metadata(self):
        self.root.mkdir()
        missing = SimpleNamespace(returncode=1, stdout='', stderr='missing')
        with patch('subprocess.run', return_value=missing), patch.object(Path, 'is_file', return_value=False), self.assertRaises(Refusal):
            compiler_tools(self.root, self.env)
        receipt = json.loads((self.root / 'compiler-tools.json').read_text())
        self.assertIsNone(receipt['selected'])
        self.assertEqual(len(receipt['candidates']), 6)
        self.assertTrue(all(row['exit'] == 1 for row in receipt['candidates']))

    def test_compiler_dry_run_requires_absolute_jobs_and_resources(self):
        valid = 'InstalledDir: /tools/bin\n "/tools/bin/clang" "-cc1" "-resource-dir" "/tools/lib/clang/21"\n "/tools/bin/ld" "-lto_library" "/tools/lib/libLTO.dylib"\n'
        self.assertTrue(absolute_compiler_jobs(valid))
        for bad in (valid.replace('InstalledDir: /tools/bin', 'InstalledDir: '), valid.replace('"/tools/bin/clang"', '""'), valid.replace('"/tools/lib/clang/21"', '"lib/clang/21"'), valid.replace('"/tools/lib/libLTO.dylib"', '"lib/libLTO.dylib"')):
            self.assertFalse(absolute_compiler_jobs(bad))

    def test_compiler_has_exact_exec_and_read_scope(self):
        tools = {'clang': '/Applications/Xcode.app/toolchain/bin/clang', 'ld': '/Applications/Xcode.app/toolchain/bin/ld', 'toolchain': '/Applications/Xcode.app/toolchain', 'sdk': '/Applications/Xcode.app/SDK'}
        policy = compiler_profile(profile(self.root, self.home, self.base), tools)
        self.assertIn('(deny process-exec)(allow process-exec (literal ' + json.dumps(tools['clang']) + ') (literal ' + json.dumps(tools['ld']) + '))', policy)
        self.assertIn('(allow file-read* (subpath ' + json.dumps(tools['toolchain']) + ') (subpath ' + json.dumps(tools['sdk']) + '))', policy)
        self.assertIn('(allow file-write-data (literal "/dev/null"))', policy)
        self.assertNotIn('xcrun', policy)
        self.assertNotIn('xcodebuild', policy)

    def test_compiler_metadata_is_literal_ancestors_only(self):
        clang = '/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang'
        paths = compiler_metadata_literals(clang)
        self.assertEqual(paths, [str(Path(clang)), *map(str, Path(clang).parents)])
        for bad in ('clang', '/Users/example/clang', '/usr/local/bin/clang'):
            with self.assertRaises(Refusal):
                compiler_metadata_literals(bad)
        tools = {'clang': clang, 'ld': str(Path(clang).with_name('ld')), 'toolchain': str(Path(clang).parents[2]), 'sdk': '/Applications/Xcode.app/SDK'}
        clause = compiler_profile('', tools).split('(allow file-read-metadata ', 1)[1]
        self.assertNotIn('subpath', clause)
        self.assertNotIn('/Users', clause)
        self.assertEqual(clause.count('(literal '), len(paths))

    def test_node_archive_mismatch_extracts_nothing(self):
        archive = self.base / 'node.tar.gz'
        archive.write_bytes(b'corrupt archive')
        destination = self.base / 'node-distribution'
        with patch('tarfile.open') as opened, self.assertRaisesRegex(ValueError, 'sha256 mismatch'):
            node_bootstrap.extract_verified(archive, destination)
        opened.assert_not_called()
        self.assertFalse(destination.exists())

    def test_node_archive_verified_and_confined(self):
        archive = self.base / 'node.tar.gz'
        with tarfile.open(archive, 'w:gz') as source:
            member = tarfile.TarInfo(node_bootstrap.TOP + '/bin/node')
            member.size = 4
            member.mode = 0o755
            source.addfile(member, io.BytesIO(b'node'))
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        node = node_bootstrap.extract_verified(archive, self.base / 'node-distribution', digest)
        self.assertEqual(Path(node).read_bytes(), b'node')

    def test_node_archive_escape_refused(self):
        archive = self.base / 'node.tar.gz'
        with tarfile.open(archive, 'w:gz') as source:
            member = tarfile.TarInfo(node_bootstrap.TOP + '/../outside')
            source.addfile(member, io.BytesIO())
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        with self.assertRaises(ValueError):
            node_bootstrap.extract_verified(archive, self.base / 'node-distribution', digest)
        self.assertFalse((self.base / 'node-distribution').exists())

    def test_every_path_rejects_missing_relative_and_escape(self):
        for key in DIRS:
            for value in ('', '.', str(self.home), str(self.base / 'outside')):
                with self.subTest(key=key, value=value):
                    env = dict(self.env, **{key: value})
                    with patch.object(Path, 'mkdir') as mkdir, patch('os.open') as opened, self.assertRaises(Refusal):
                        self.check(env)
                    mkdir.assert_not_called()
                    opened.assert_not_called()

    def test_every_provider_and_library_refused(self):
        for directory in PROTECTED:
            with self.subTest(directory=directory), self.assertRaises(Refusal):
                self.check(dict(self.env, HOME=str(self.home / directory)))

    def test_unknown_xdg_refused(self):
        with self.assertRaises(Refusal):
            self.check(dict(self.env, XDG_OTHER_HOME=str(self.home / 'Library')))

    def test_symlink_escape_refused(self):
        self.root.mkdir()
        (self.root / 'h').symlink_to(self.home, target_is_directory=True)
        with self.assertRaises(Refusal):
            self.check()

    def test_dotdot_escape_refused(self):
        with self.assertRaises(Refusal):
            self.check(dict(self.env, TMPDIR=str(self.root / '..' / 'outside')))

    def test_real_home_root_and_wrong_parent_refused(self):
        for root in (self.home, self.home / 'Library/g.run', self.base / 'wrong/g.run', self.base):
            with self.subTest(root=root), self.assertRaises(Refusal):
                self.check(environment(root, '/usr/local/bin/node'), root)

    def test_stamped_environment_refused(self):
        for key in ('HIVE_CELL', 'APIARY_HOME'):
            with self.subTest(key=key), self.assertRaises(Refusal):
                self.check(dict(self.env, **{key: 'unused'}))

    def test_planted_outside_write_refused(self):
        self.root.mkdir()
        target = self.base / 'planted-outside'
        before = sorted(self.base.iterdir())
        with self.assertRaises(Refusal):
            write_json(target, {'planted': True}, self.root)
        self.assertFalse(target.exists())
        self.assertEqual(before, sorted(self.base.iterdir()))

    def test_earlier_run_logs_untouched(self):
        earlier = self.base / 'g.earlier'
        earlier.mkdir()
        log = earlier / 'workload.log'
        log.write_text('keep earlier evidence')
        before = log.stat()
        self.root.mkdir()
        write_json(self.root / 'receipt.json', {'exit': 0}, self.root)
        receipt_hashes(self.root)
        self.assertEqual(log.read_text(), 'keep earlier evidence')
        self.assertEqual(log.stat().st_mtime_ns, before.st_mtime_ns)

    def test_library_only_launchagents_names_and_hashes(self):
        agents = self.home / 'Library/LaunchAgents'
        agents.mkdir(parents=True)
        preferences = self.home / 'Library/Preferences'
        preferences.mkdir()
        (preferences / 'do-not-read.plist').write_text('private preferences')
        content = b'launch-agent-content'
        (agents / 'agent.plist').write_bytes(content)
        snap = launchagents(self.home)
        self.assertEqual(snap, {'exists': True, 'entries': {'agent.plist': hashlib.sha256(content).hexdigest()}})
        self.assertNotIn('launch-agent-content', json.dumps(snap))
        (preferences / 'do-not-read.plist').write_text('changed unrelated')
        self.assertEqual(launchagents(self.home), snap)
        (agents / 'agent.plist').write_text('changed')
        self.assertNotEqual(launchagents(self.home), snap)

    def test_library_symlink_refuses_without_following(self):
        agents = self.home / 'Library/LaunchAgents'
        agents.mkdir(parents=True)
        (agents / 'agent.plist').symlink_to(self.base / 'secret')
        with self.assertRaises(Refusal):
            launchagents(self.home)

    def test_library_parent_symlink_refuses(self):
        (self.home / 'Library').symlink_to(self.base / 'unread', target_is_directory=True)
        with self.assertRaises(Refusal):
            launchagents(self.home)

    def test_library_fifo_refuses_without_blocking(self):
        agents = self.home / 'Library/LaunchAgents'
        agents.mkdir(parents=True)
        os.mkfifo(agents / 'not-a-plist')
        with self.assertRaises(Refusal):
            launchagents(self.home)

    def test_absent_launchagents_is_explicit(self):
        self.assertEqual(launchagents(self.home), {'exists': False, 'entries': {}})

    def seed(self, name, kind=None):
        path = self.base / 'cache-seed.tar'
        with tarfile.open(path, 'w') as archive:
            member = tarfile.TarInfo(name)
            if kind:
                member.type = kind
                member.linkname = '/outside'
                archive.addfile(member)
            else:
                member.size = 4
                archive.addfile(member, io.BytesIO(b'seed'))
        return path, hashlib.sha256(path.read_bytes()).hexdigest()

    def test_cache_seed_goes_only_to_this_run(self):
        source, digest = self.seed('npm/example')
        self.root.mkdir()
        proof = seed_cache(source, digest, self.root, self.base)
        self.assertEqual(proof['sha256'], digest)
        self.assertEqual((self.root / 'cache/npm/example').read_bytes(), b'seed')

    def test_cache_seed_rejects_bad_hash_and_unsafe_members(self):
        for name, kind in [('../outside', None), ('/outside', None), ('npm/../../outside', None), ('other/x', None), ('npm/link', tarfile.SYMTYPE), ('npm/hard', tarfile.LNKTYPE), ('npm/device', tarfile.CHRTYPE)]:
            with self.subTest(name=name, kind=kind):
                source, digest = self.seed(name, kind)
                with self.assertRaises(Refusal):
                    seed_cache(source, digest, self.root, self.base)
                self.assertFalse(self.root.exists())
        source, _ = self.seed('npm/example')
        with self.assertRaises(Refusal):
            seed_cache(source, 'bad', self.root, self.base)

    def test_profile_limits_storage_security_and_network(self):
        policy = profile(self.root, self.home, self.base / 'lane')
        self.assertIn('(deny file-write*)', policy)
        self.assertIn('(deny process-exec (literal "/usr/bin/security"))', policy)
        self.assertIn('(deny network*)', policy)
        self.assertIn('(allow network-bind (local ip "localhost:*"))', policy)
        self.assertIn('(allow network-inbound (local ip "localhost:*"))', policy)
        for operation, endpoint in (('bind', 'local'), ('inbound', 'local'), ('outbound', 'remote')):
            self.assertIn('(allow network-' + operation + ' (' + endpoint + ' unix-socket (subpath ' + json.dumps(str(self.root / 't')) + ')))', policy)
        self.assertNotIn('Preferences', policy)

    def test_controller_socket_controls_are_real_and_cleaned(self):
        (self.root / 't').mkdir(parents=True)
        try:
            controls = make_socket_controls(self.root)
            self.assertEqual(Path(controls['SCG_ALLOWED_SOCKET']).parent, self.root / 't')
            self.assertEqual(Path(controls['SCG_DENIED_SOCKET']).parent, self.root)
            self.assertTrue(all(Path(path).is_socket() for path in controls.values()))
        finally:
            close_socket_controls(self.root)
        self.assertTrue(all(not Path(path).exists() for path in controls.values()))
        rows = json.loads((self.root / 'controller-sockets-cleanup.json').read_text())
        self.assertEqual(len(rows), 2)
        self.assertTrue(all(row['removed'] for row in rows))

    def test_controller_cleanup_refuses_replaced_socket(self):
        (self.root / 't').mkdir(parents=True)
        controls = make_socket_controls(self.root)
        path = Path(controls['SCG_DENIED_SOCKET'])
        path.unlink()
        path.write_text('replacement must remain')
        with self.assertRaises(Refusal):
            close_socket_controls(self.root)
        self.assertEqual(path.read_text(), 'replacement must remain')

    def test_receipt_hashes_every_regular_file(self):
        self.root.mkdir()
        write_json(self.root / 'receipt.json', {'exit': 0}, self.root)
        digest = receipt_hashes(self.root)
        data = (self.root / 'SHA256SUMS.json').read_bytes()
        self.assertEqual(digest, hashlib.sha256(data).hexdigest())
        self.assertEqual(json.loads(data)['receipt.json'], hashlib.sha256((self.root / 'receipt.json').read_bytes()).hexdigest())

    def test_receipt_logs_symlink_refuses(self):
        self.root.mkdir()
        (self.root / 'logs').symlink_to(self.home, target_is_directory=True)
        with self.assertRaises(Refusal):
            receipt_hashes(self.root)


if __name__ == '__main__':
    root = Path(os.environ['LAB_ROOT'])
    if sys.platform == 'darwin':
        validate(Path(os.environ['GATE_ROOT']), os.environ, Path(os.environ['SCG_REAL_HOME']))
    else:
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'linux'))
        from home_guard import home_guard
        import pwd
        home = Path(os.environ['LAB_PASSWD_HOME'])
        if not root.resolve().is_relative_to(home / '.cache/hbl'):
            raise SystemExit('refused unsafe LAB_ROOT')
        result = home_guard(os.environ, [str(home), pwd.getpwuid(os.getuid()).pw_dir], allowed_roots=[str(root)])
        if not result['allowed']:
            raise SystemExit('refused unsafe ' + result['offendingVariable'])
    root.mkdir(parents=True, exist_ok=True)
    unittest.main(verbosity=2)
