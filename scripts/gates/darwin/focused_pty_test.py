import ast
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import pty_controls


class PtyTests(unittest.TestCase):
    def test_candidate_requires_self_test_and_keeps_production_unchanged(self):
        import guard
        base = guard.profile(Path('/private/var/tmp/g.12345678'), Path('/Users/fixture'), Path('/lane'))
        for value in (False, None, 1, '1'):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'self-test only'):
                pty_controls.candidate_profile(base, self_test=value)
        candidate = pty_controls.candidate_profile(base, self_test=True)
        self.assertTrue(candidate.startswith(base))
        self.assertNotIn('com.apple.sandbox.pty', base)
        self.assertIn('(require-all (regex #"^/dev/ttys[0-9]+$") (extension "com.apple.sandbox.pty"))', candidate)
        self.assertNotIn('(subpath "/dev")', candidate)
        tree = ast.parse((Path(__file__).parent / 'guard.py').read_text())
        calls = []
        for node in ast.walk(tree):
            if isinstance(node, ast.If) and ast.unparse(node.test) == 'args.self_test':
                calls.extend(inner for inner in ast.walk(node) if isinstance(inner, ast.Call) and isinstance(inner.func, ast.Attribute) and ast.unparse(inner.func) == 'pty_controls.run')
        self.assertEqual(len(calls), 1)
        self.assertNotIn('pty_controls', (Path(__file__).parent / 'focused_flow.py').read_text())
        self.assertEqual(base, guard.profile(Path('/private/var/tmp/g.12345678'), Path('/Users/fixture'), Path('/lane')))

    def test_negative_controls_fail_independently_and_no_raw_fields(self):
        value = {key: 'NONE' for key in pty_controls.FIELDS - {'trueExit'}}
        value.update(foreignBefore='EPERM', foreignAfter='EACCES', nonTty='EPERM', trueExit=0)
        self.assertTrue(pty_controls.adjudicate(value, True)['ok'])
        for field in ('foreignBefore', 'foreignAfter', 'nonTty'):
            with self.subTest(field=field):
                self.assertFalse(pty_controls.adjudicate(dict(value, **{field: 'NONE'}), True)['ok'])
        for field in pty_controls.CHAIN:
            self.assertFalse(pty_controls.adjudicate(dict(value, **{field: 'EPERM'}), True)['ok'])
        self.assertFalse(pty_controls.adjudicate(dict(value, forkExec='EPERM'), True)['ok'])
        self.assertFalse(pty_controls.adjudicate(dict(value, trueExit=1), True)['ok'])
        baseline = dict(value, posixOpenpt='EPERM', grantpt='NOT_RUN', unlockpt='NOT_RUN', slaveOpen='NOT_RUN', ttyIoctl='NOT_RUN')
        self.assertTrue(pty_controls.adjudicate(baseline, False)['ok'])
        self.assertFalse(pty_controls.adjudicate(value, False)['ok'])
        for bad in (dict(value, text='SECRET'), dict(value, foreignBefore='SECRET'), dict(value, trueExit='0')):
            with self.assertRaises(ValueError):
                pty_controls.adjudicate(bad, True)

    def test_tmux_foreground_control_has_private_socket_and_fenced_cleanup(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            fixture = root / 't/control'
            fixture.mkdir(parents=True)
            connection = socket.socket(socket.AF_UNIX)
            connection.bind(str(fixture / 'tmux.sock'))
            server = Mock()
            birth = ['12', '1', '100', '1']
            pin = {'path': '/pinned/tmux', 'sha256': '0' * 64, 'dev': 1, 'ino': 2}
            api = SimpleNamespace(write_json=Mock())
            completed = ({'exit': 0, 'cleanup': {'gone': True}}, b'SCG_PTY_TMUX_READY\n')
            try:
                with patch('pty_controls.select_tmux', return_value=pin), patch('pty_controls.check_tmux'), patch('pty_controls.start', return_value=(server, birth)) as start, patch('pty_controls.execute', return_value=completed) as execute, patch('pty_controls.fenced_cleanup', return_value={'gone': True}) as cleanup:
                    report = pty_controls.tmux_control(api, root, root / 'src', root / 'scope', {}, root / 'candidate.sb', fixture)
                self.assertTrue(report['ok'])
                self.assertIn('-D', start.call_args.args[-1])
                for call in execute.call_args_list:
                    argv = call.args[-1]
                    self.assertIn('-N', argv)
                    self.assertEqual(argv[argv.index('-S') + 1], str(fixture / 'tmux.sock'))
                    self.assertNotIn('-L', argv)
                cleanup.assert_called_once_with(api, root / 'scope', server, birth)
                self.assertNotIn('SCG_PTY_TMUX_READY', json.dumps(report))
            finally:
                connection.close()

    @unittest.skipUnless(sys.platform.startswith('linux'), 'public C control syntax compiled on Linux only')
    def test_native_control_compiles_with_werror(self):
        with tempfile.TemporaryDirectory() as temporary:
            result = subprocess.run(['/usr/bin/cc', '-std=c11', '-Wall', '-Wextra', '-Werror', str(Path(__file__).parent / 'pty_control.c'), '-o', str(Path(temporary) / 'control')], capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
