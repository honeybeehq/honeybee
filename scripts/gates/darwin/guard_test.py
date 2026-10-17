import ast
from enum import IntEnum
import hashlib
import io
import json
import os
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
from physical_test import without_ip_bind

from guard import DIRS, PROTECTED, Refusal, absolute_compiler_jobs, close_socket_controls, compiler_metadata_literals, compiler_profile, compiler_tools, environment, launchagents, make_socket_controls, profile, receipt_hashes, run, seed_cache, select_node, validate, write_json


class GuardTests(unittest.TestCase):
    def test_no_ip_bind_variant_changes_only_one_rule(self):
        policy = profile(self.root, self.home, self.base)
        rule = '(allow network-bind (local ip "localhost:*"))'
        self.assertEqual(without_ip_bind(policy), policy.replace(rule, '', 1))
        self.assertEqual(len(policy) - len(without_ip_bind(policy)), len(rule))
        for invalid in ('', policy + rule):
            with self.assertRaises(AssertionError):
                without_ip_bind(invalid)

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
        self.assertEqual(count, 4)

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
                result = subprocess.run(argv, cwd=self.base, env=self.env, capture_output=True, text=True)
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
            with patch('guard.pwd.getpwuid', side_effect=error), patch('os.open') as opened, patch.object(Path, 'mkdir') as mkdir, self.assertRaisesRegex(Refusal, 'passwd identity unavailable'):
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
