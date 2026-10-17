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
        base = guard.profile(Path('/private/var/tmp/g.12345678'), Path('/Users/fixture'), Path('/lane'), pty=False)
        for value in (False, None, 1, '1'):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'self-test only'):
                pty_controls.candidate_profile(base, self_test=value)
        candidate = pty_controls.candidate_profile(base, self_test=True)
        self.assertEqual(candidate, base.replace('(deny file-write*)', '(deny file-write*)' + pty_controls.PTY_RULES, 1))
        self.assertEqual(candidate, guard.profile(Path('/private/var/tmp/g.12345678'), Path('/Users/fixture'), Path('/lane')))
        self.assertNotIn('com.apple.sandbox.pty', base)
        self.assertIn('(require-all (regex #"^/dev/ttys[0-9]+$") (extension "com.apple.sandbox.pty"))', candidate)
        self.assertNotIn('(subpath "/dev")', candidate)
        tree = ast.parse((Path(__file__).parent / 'guard.py').read_text())
        calls = []
        for node in ast.walk(tree):
            if isinstance(node, ast.If) and ast.unparse(node.test) == "args.self_test or args.body == 'scripts/gates/darwin/focused-manifest-body.sh'":
                calls.extend(inner for inner in ast.walk(node) if isinstance(inner, ast.Call) and isinstance(inner.func, ast.Attribute) and ast.unparse(inner.func) == 'pty_controls.run')
        self.assertEqual(len(calls), 1)
        compiler = [node.value for node in ast.walk(tree) if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'build_policy' for target in node.targets)]
        self.assertEqual(len(compiler), 1)
        self.assertEqual(ast.unparse(compiler[0]), 'compiler_profile(profile(root, real_home, lane, pty=False), tools)')
        manifest = json.loads((Path(__file__).parent / 'focused-manifest.json').read_text())
        self.assertEqual(sum(len(row['outer']) for row in manifest['files']), 46)
        self.assertEqual(sum(len(row['sibling']) for row in manifest['files']), 2)
        self.assertEqual(len(manifest['files'][2]['outer']), 8)
        self.assertIn('pty_controls.require_precondition(root, pty_controls.os_build(env))', (Path(__file__).parent / 'focused_flow.py').read_text())
        self.assertEqual(base, guard.profile(Path('/private/var/tmp/g.12345678'), Path('/Users/fixture'), Path('/lane'), pty=False))

    def test_permanent_precondition_requires_build_and_same_invocation_proofs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            build = {'ProductVersion': '26.6.2', 'BuildVersion': '25G83'}
            with patch.dict(pty_controls.REPORTS, {}, clear=True):
                with self.assertRaisesRegex(ValueError, 'missing'):
                    pty_controls.require_precondition(root, build)
                import focused_flow
                with patch('pty_controls.os_build', return_value=build), self.assertRaisesRegex(ValueError, 'missing'):
                    focused_flow.run(None, root, root, {}, None, None)
                value = {key: 'NONE' for key in pty_controls.FIELDS - {'trueExit'}}
                value.update(foreignBefore={'open': 'DENIED_EPERM', 'write': 'NOT_RUN'}, foreignAfter={'open': 'DENIED_EPERM', 'write': 'NOT_RUN'}, nonTty='EPERM', trueExit=0)
                baseline = dict(value, posixOpenpt='EPERM', grantpt='NOT_RUN', unlockpt='NOT_RUN', slaveOpen='NOT_RUN', ttyIoctl='NOT_RUN')
                row = {'ok': True, 'runRoot': str(root), 'osBuild': build, 'productionProfileUnchanged': True, 'tmux': {'ok': True}, 'rows': [{'candidate': False, 'observations': baseline}, {'candidate': True, 'observations': value}]}
                pty_controls.REPORTS[str(root)] = row
                self.assertIs(pty_controls.require_precondition(root, build), row)
                with self.assertRaisesRegex(ValueError, 'os_build_changed: fresh self-test required'):
                    pty_controls.require_precondition(root, dict(build, BuildVersion='25G84'))
                for phase in ('foreignBefore', 'foreignAfter'):
                    changed = dict(value, **{phase: {'open': 'OPENED', 'write': 'EPERM'}})
                    row['rows'][1]['observations'] = changed
                    with self.assertRaisesRegex(ValueError, 'controls_failed'):
                        pty_controls.require_precondition(root, build)
                row['rows'][1]['observations'] = value
                row['runRoot'] = str(root / 'other')
                with self.assertRaisesRegex(ValueError, 'missing'):
                    pty_controls.require_precondition(root, build)

    def test_negative_controls_fail_independently_and_no_raw_fields(self):
        value = {key: 'NONE' for key in pty_controls.FIELDS - {'trueExit'}}
        value.update(foreignBefore={'open': 'DENIED_EPERM', 'write': 'NOT_RUN'}, foreignAfter={'open': 'DENIED_EACCES', 'write': 'NOT_RUN'}, nonTty='EPERM', trueExit=0)
        self.assertTrue(pty_controls.adjudicate(value, True)['ok'])
        for field in ('foreignBefore', 'foreignAfter', 'nonTty'):
            with self.subTest(field=field):
                self.assertFalse(pty_controls.adjudicate(dict(value, **{field: {'open': 'OPENED', 'write': 'EPERM'} if field != 'nonTty' else 'NONE'}), True)['ok'])
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

    @unittest.skipUnless(sys.platform.startswith('linux'), 'C syscall mock compiles on Linux only')
    def test_foreign_open_success_write_denied_is_forbidden(self):
        source = (Path(__file__).parent / 'pty_control.c').read_text()
        function = source[source.index('static const char *error_name'):source.index('static const char *zero_probe')]
        prefix = '#define _GNU_SOURCE\n#include <errno.h>\n#include <fcntl.h>\n#include <stdio.h>\n#include <string.h>\n#include <stdlib.h>\n#include <unistd.h>\nstatic int mode;\nstatic int mock_open(const char *p,int f){(void)p;(void)f;if(mode==0){errno=EACCES;return -1;}return 12;}\nstatic ssize_t mock_write(int f,const void *p,size_t n){(void)f;if(n!=1||*(const char*)p!=0x47)return -1;if(mode==1){errno=EPERM;return -1;}return 1;}\nstatic int mock_close(int f){(void)f;return 0;}\n#define open mock_open\n#define write mock_write\n#define close mock_close\n'
        suffix = 'int main(int argc,char **argv){(void)argc;mode=atoi(argv[1]);struct foreign_outcome r=foreign_probe("/controller-dummy");printf("%s %s",r.open,r.write);return 0;}\n'
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            code, binary = root / 'probe.c', root / 'probe'
            code.write_text(prefix + function + suffix)
            built = subprocess.run(['/usr/bin/cc', '-std=c11', '-Wall', '-Wextra', '-Werror', str(code), '-o', str(binary)], capture_output=True, text=True, timeout=10)
            self.assertEqual(built.returncode, 0, built.stderr)
            for mode, expected in ((0, {'open': 'DENIED_EACCES', 'write': 'NOT_RUN'}), (1, {'open': 'OPENED', 'write': 'EPERM'}), (2, {'open': 'OPENED', 'write': 'WROTE'})):
                actual = dict(zip(('open', 'write'), subprocess.check_output([str(binary), str(mode)], text=True, timeout=2).split()))
                self.assertEqual(actual, expected)
                for phase in ('foreignBefore', 'foreignAfter'):
                    value = {key: 'NONE' for key in pty_controls.FIELDS - {'trueExit'}}
                    value.update(foreignBefore={'open': 'DENIED_EPERM', 'write': 'NOT_RUN'}, foreignAfter={'open': 'DENIED_EACCES', 'write': 'NOT_RUN'}, nonTty='EPERM', trueExit=0)
                    value[phase] = actual
                    verdict = pty_controls.adjudicate(value, True)
                    self.assertEqual(verdict['ok'], mode == 0)
                    self.assertEqual(verdict['foreignOpenedForbidden'], mode != 0)

    def test_tmux_foreground_control_has_private_socket_and_fenced_cleanup(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            (root / 'pty-control').write_bytes(b'fixed-marker-binary')
            fixture = root / 't/control'
            fixture.mkdir(parents=True)
            connection = socket.socket(socket.AF_UNIX)
            connection.bind(str(fixture / 'tmux.sock'))
            server = Mock()
            birth = ['12', '1', '100', '1']
            pin = {'path': '/pinned/tmux', 'sha256': '0' * 64, 'dev': 1, 'ino': 2}
            api = SimpleNamespace(write_json=Mock(), scope_call=Mock(return_value=[['13', '12', '101', '1']]))
            def completed(*args):
                return ({'exit': 0, 'cleanup': {'gone': True}}, b'0 13\n' if 'display-message' in args[-1] else b'SCG_PTY_TMUX_READY\n')
            try:
                with patch('pty_controls.select_tmux', return_value=pin), patch('pty_controls.check_tmux'), patch('pty_controls.start', return_value=(server, birth)) as start, patch('pty_controls.execute', side_effect=completed) as execute, patch('pty_controls.fenced_cleanup', return_value={'gone': True}) as cleanup, patch('pty_controls.marker_gone', return_value=True), patch('pty_controls.scope_controls.call', return_value=str(root / 'pty-control')), patch('pty_controls.subprocess.run', return_value=SimpleNamespace(returncode=0)):
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

    def test_live_marker_is_required(self):
        self.assertFalse(pty_controls.capture_verdict(b'SCG_PTY_TMUX_READY\n', False)['ok'])
        self.assertFalse(pty_controls.capture_verdict(b'no marker\n', True)['ok'])
        self.assertTrue(pty_controls.capture_verdict(b'SCG_PTY_TMUX_READY\n', True)['ok'])
        self.assertFalse(pty_controls.capture_verdict(b'Pane is dead (status 0)\n', False)['ok'])

    @unittest.skipUnless(sys.platform.startswith('linux'), 'public C control syntax compiled on Linux only')
    def test_native_control_compiles_with_werror(self):
        with tempfile.TemporaryDirectory() as temporary:
            result = subprocess.run(['/usr/bin/cc', '-std=c11', '-Wall', '-Wextra', '-Werror', str(Path(__file__).parent / 'pty_control.c'), '-o', str(Path(temporary) / 'control')], capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
