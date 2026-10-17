import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import focused_flow
import focused_readiness
import focused_seal
import focused_sentinel
import seed_npm


class RevisionTests(unittest.TestCase):
    def test_sealed_control_rewritten_between_rows_fails(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            workspace = root / 'src'
            for directory in (root / 'control', workspace / 'scripts/gates/darwin'):
                directory.mkdir(parents=True)
                (directory / 'trusted').write_text('original')
            expected = focused_flow.sealed_control_state(root, workspace)
            focused_flow.require_sealed_controls(root, workspace, expected)
            (root / 'control/trusted').write_text('forged')
            with self.assertRaisesRegex(ValueError, 'sealed control changed'):
                focused_flow.require_sealed_controls(root, workspace, expected)

    def test_scope_quiescence_complete_busy_and_unresolved(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            focused_seal.ROOT_CREATION[str(root)] = {'beforeMkdirNs': 200000000000}
            (root / 'src').mkdir(exist_ok=True)
            (root / 'src/package.json').write_text('{}')
            (root / 't').mkdir(exist_ok=True)
            with patch('focused_seal.subprocess.run', return_value=subprocess.CompletedProcess([], 0, 'COMPLETE\n', '')) as call:
                self.assertEqual(focused_seal.require_quiescent(root, root / 'scope'), [])
                self.assertEqual(call.call_args.args[0], [str(root / 'scope'), 'quiescence', str(os.getpid()), str(root), '200000000', str(root / 'sealed-target/quiescence-probe'), str(root / 'src/package.json'), str(root / 't/quiescence-must-not-exist')])
            output = '22\t' + str(root / 'open') + '\nCOMPLETE\n'
            with patch('focused_seal.subprocess.run', return_value=subprocess.CompletedProcess([], 0, output, '')):
                with self.assertRaises(focused_seal.BusyRoot):
                    focused_seal.require_quiescent(root, root / 'scope')
            for rc, text in ((4, ''), (0, '')):
                with patch('focused_seal.subprocess.run', return_value=subprocess.CompletedProcess([], rc, text, '')):
                    with self.assertRaises(ValueError):
                        focused_seal.require_quiescent(root, root / 'scope')

    def test_readiness_binary_version_and_optional_never_loaded(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            for name in ('esbuild', '@esbuild/darwin-arm64'):
                directory = root / 'node_modules' / name
                directory.mkdir(parents=True)
                (directory / 'package.json').write_text(json.dumps({'version': '0.27.7'}))
            binary = root / 'node_modules/@esbuild/darwin-arm64/bin/esbuild'
            binary.parent.mkdir()
            binary.write_text('fixture')
            binary.chmod(0o700)
            with patch('focused_readiness.subprocess.run', return_value=subprocess.CompletedProcess([], 0, '0.27.7\n', '')) as run:
                self.assertIn('absent', focused_readiness.check(root)['nodePty'])
                pty = root / 'node_modules/node-pty'
                pty.mkdir()
                (pty / 'package.json').write_text('{}')
                self.assertIn('not built or loaded', focused_readiness.check(root)['nodePty'])
                self.assertEqual(run.call_args.args[0], [str(binary), '--version'])
            with patch('focused_readiness.subprocess.run', return_value=subprocess.CompletedProcess([], 0, 'wrong', '')):
                with self.assertRaises(ValueError):
                    focused_readiness.check(root)
            binary.unlink()
            binary.symlink_to(root / 'node_modules/esbuild/package.json')
            with self.assertRaises(ValueError):
                focused_readiness.check(root)

    def test_sentinel_excludes_live_state_and_keychains_names_only(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            (root / '.ssh').mkdir()
            for name in ('known_hosts', 'config', 'authorized_keys', 'id_ed25519', 'id_ed25519.pub'):
                (root / '.ssh' / name).write_text('fixture')
            (root / '.claude.json').write_text('live')
            (root / 'Library/Keychains').mkdir(parents=True)
            keychain = root / 'Library/Keychains/login.keychain-db'
            keychain.write_text('old')
            before = focused_sentinel.snapshot(root)
            keychain.write_text('changed size')
            (root / '.ssh/known_hosts').write_text('changed')
            (root / '.claude.json').write_text('changed')
            after = focused_sentinel.snapshot(root)
            self.assertEqual(before, after)
            self.assertEqual(before['Library/Keychains'], {'names': ['login.keychain-db']})
            self.assertNotIn('.claude.json', before)
            self.assertNotIn('.ssh/known_hosts', before)
            self.assertIn('.ssh/id_ed25519', before)

    def test_seed_hash_missing_tarball_and_unexpected_lifecycle_fail(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'input'
            path.write_text('fixture')
            with self.assertRaisesRegex(ValueError, 'hash mismatch'):
                seed_npm.verify_input(path, '0' * 64)
            with self.assertRaises(FileNotFoundError):
                seed_npm.verify_cached(path.parent / 'missing.tgz', '0' * 64)
            def archive(scripts):
                output = io.BytesIO()
                with tarfile.open(fileobj=output, mode='w:gz') as target:
                    data = json.dumps({'name': 'unexpected', 'version': '1', 'scripts': scripts}).encode()
                    info = tarfile.TarInfo('package/package.json')
                    info.size = len(data)
                    target.addfile(info, io.BytesIO(data))
                return output.getvalue()
            with self.assertRaisesRegex(ValueError, 'unexpected dependency lifecycle'):
                seed_npm.scan_tarball(archive({'install': 'curl somewhere'}))
            self.assertEqual(seed_npm.scan_tarball(archive({'prepare': 'build'}))['lifecycle'], {'prepare': 'build'})

    def test_seed_cache_verifier_missing_integrity_fails_without_network(self):
        node = os.environ.get('SCG_NODE_BIN')
        npm = Path(node).parent.parent / 'lib/node_modules/npm/bin/npm-cli.js' if node else Path('/missing')
        if not node or not npm.exists():
            self.skipTest('pinned Node/npm required')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            (root / 'src').mkdir()
            package = {'version': '1', 'resolved': 'https://registry.npmjs.org/fixture/-/fixture-1.tgz', 'integrity': 'sha512-' + 'A' * 86 + '=='}
            (root / 'src/package-lock.json').write_text(json.dumps({'packages': {'node_modules/fixture': package}}))
            result = subprocess.run([node, str(Path(__file__).with_name('seed-cache-verify.mjs')), str(root), str(npm)], env={'PATH': str(Path(node).parent) + ':/usr/bin:/bin', 'HOME': str(root), 'TMPDIR': str(root)}, capture_output=True, text=True, timeout=5)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((root / 'integrity.json').exists())

    def test_seed_tar_is_normalized_and_contains_only_cache(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            cache = root / 'npm/_cacache/content-v2'
            cache.mkdir(parents=True)
            (cache / 'fixture').write_text('bytes')
            (root / 'npm/private-log').write_text('exclude')
            seed_npm.pack(root, root / 'first.tar')
            os.utime(cache / 'fixture', (123, 456))
            seed_npm.pack(root, root / 'second.tar')
            self.assertEqual((root / 'first.tar').read_bytes(), (root / 'second.tar').read_bytes())
            with tarfile.open(root / 'first.tar') as archive:
                self.assertFalse(any('private-log' in name for name in archive.getnames()))


if __name__ == '__main__':
    unittest.main()

