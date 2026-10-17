import errno
import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import focused_sentinel
import seed_npm
import seed_policy


def lock_fixture():
    return {'lockfileVersion': 3, 'packages': {'': {}, 'node_modules/fixture': {'version': '1.0.0', 'resolved': 'https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz', 'integrity': 'sha512-' + 'A' * 86 + '=='}}}


def write_index(root, headers=None):
    cache = root / 'npm/_cacache'
    directory = cache / 'index-v5/fixture'
    directory.mkdir(parents=True, exist_ok=True)
    url = 'https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz'
    value = json.dumps({'key': 'make-fetch-happen:request-cache:' + url, 'metadata': {'url': url, 'reqHeaders': headers or {}, 'resHeaders': {'content-type': 'application/octet-stream'}}}).encode()
    (directory / 'entry').write_bytes(b'\n' + hashlib.sha1(value).hexdigest().encode() + b'\t' + value + b'\n')
    return cache


class SeedBoundaryTests(unittest.TestCase):
    def test_all_lock_entries_prevalidated_before_npm(self):
        for bad in ('https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz?token=private', 'https://elsewhere.invalid/fixture.tgz', 'git+https://github.com/a/b', 'file:../fixture', 'https://registry.npmjs.org:443/fixture/-/fixture-1.0.0.tgz', 'https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz#secret', 'https://registry.npmjs.org/%66ixture/-/fixture-1.0.0.tgz', 'https://user:secret@registry.npmjs.org/fixture/-/fixture-1.0.0.tgz'):
            with tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary).resolve()
                lock = lock_fixture()
                lock['packages']['node_modules/fixture']['resolved'] = bad
                lock['packages']['node_modules/fixture']['os'] = ['win32']
                package = root / 'package.json'
                package.write_text('{}')
                locked = root / 'package-lock.json'
                locked.write_text(json.dumps(lock))
                node = root / 'node'
                node.write_text('fixture')
                args = SimpleNamespace(node=node, npm=node, node_sha256=seed_npm.digest(node), npm_sha256=seed_npm.digest(node), package=package, package_sha256=seed_npm.digest(package), lock=locked, lock_sha256=seed_npm.digest(locked), root=root / 'seed')
                with patch('seed_npm.subprocess.run') as run, self.assertRaises(ValueError):
                    seed_npm.run(args)
                run.assert_not_called()
                self.assertFalse(args.root.exists())
        seed_policy.validate_lock(lock_fixture())
        root_resolved = lock_fixture()
        root_resolved['packages']['']['resolved'] = 'file:../outside'
        with self.assertRaises(ValueError):
            seed_policy.validate_lock(root_resolved)
        for mutation in ({'link': True}, {'integrity': None}, {'resolved': 'https://registry.npmjs.org/fixture/-/different-1.tgz'}):
            lock = lock_fixture()
            lock['packages']['node_modules/fixture'].update(mutation)
            with self.assertRaises(ValueError):
                seed_policy.validate_lock(lock)

    def test_authorization_in_cache_index_fails_before_packing(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            package = base / 'package.json'
            package.write_text('{}')
            lock = base / 'package-lock.json'
            lock.write_text(json.dumps(lock_fixture()))
            node = base / 'node'
            node.write_text('fixture')
            args = SimpleNamespace(node=node, npm=node, node_sha256=seed_npm.digest(node), npm_sha256=seed_npm.digest(node), package=package, package_sha256=seed_npm.digest(package), lock=lock, lock_sha256=seed_npm.digest(lock), root=base / 'seed')
            def install(*unused, **kwargs):
                write_index(args.root, {'Authorization': 'Bearer never-record'})
                (args.root / 'integrity.json').write_text('[]')
            with patch('seed_npm.subprocess.run', side_effect=install), patch('seed_npm.pack') as pack:
                with self.assertRaisesRegex(ValueError, 'credential-bearing'):
                    seed_npm.run(args)
                pack.assert_not_called()
                self.assertFalse((args.root / 'darwin-npm-seed.tar').exists())

    def test_clean_index_and_registry_urls(self):
        with tempfile.TemporaryDirectory() as temporary:
            cache = write_index(Path(temporary).resolve())
            self.assertEqual(seed_policy.audit_index(cache), 1)
        for url in ('https://registry.npmjs.org/fixture?token=x', 'https://registry.npmjs.org/fixture#x', 'https://registry.npmjs.org/../fixture', 'https://registry.npmjs.org:444/fixture'):
            with self.assertRaises(ValueError):
                seed_policy.canonical_url(url)

    def test_only_prepare_is_exempt_and_postprepare_is_examined(self):
        for event in ('prepublish', 'preprepare', 'postprepare'):
            output = io.BytesIO()
            with tarfile.open(fileobj=output, mode='w:gz') as archive:
                data = json.dumps({'name': 'fixture', 'version': '1', 'scripts': {event: 'unexpected'}}).encode()
                info = tarfile.TarInfo('package/package.json')
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
            with self.assertRaisesRegex(ValueError, 'unexpected dependency lifecycle'):
                seed_npm.scan_tarball(output.getvalue())

    def test_keychain_list_denial_preserves_unobservable(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            (root / 'Library/Keychains').mkdir(parents=True)
            with patch('focused_sentinel.os.listdir', side_effect=PermissionError(errno.EACCES, 'fixture')):
                rows = focused_sentinel.snapshot(root)
            self.assertEqual(rows['Library/Keychains'], {'names': [], 'unobservable': True, 'errno': errno.EACCES})


if __name__ == '__main__':
    unittest.main()

