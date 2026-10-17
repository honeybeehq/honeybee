import hashlib
import io
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import guard
import seed_npm


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class SeedPaxTests(unittest.TestCase):
    def test_real_length_paths_pack_extract_and_deterministic_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            lane = Path(temporary).resolve()
            source = lane / 'source'
            paths = [
                'npm/_cacache/content-v2/sha512/aa/bb/' + 'a' * 180,
                'npm/_cacache/index-v5/cc/dd/' + 'c' * 60]
            self.assertGreater(len(paths[0]), 200)
            for number, name in enumerate(paths):
                path = source / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b'fixture-' + str(number).encode())
            first, second = lane / 'first.tar', lane / 'second.tar'
            seed_npm.pack(source, first)
            for name in paths:
                os.utime(source / name, (123, 456))
            seed_npm.pack(source, second)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            with tarfile.open(first, 'r:') as archive:
                members = archive.getmembers()
                self.assertTrue(any('path' in row.pax_headers for row in members))
                for member in members:
                    self.assertLessEqual(set(member.pax_headers), {'path'})
                    self.assertEqual((member.uid, member.gid, member.uname, member.gname, member.mtime), (0, 0, '', '', 0))
                    self.assertEqual(member.mode, 0o755 if member.isdir() else 0o644)
            root = lane / 'run'
            root.mkdir()
            guard.seed_cache(first, sha(first), root, lane)
            for name in paths:
                self.assertEqual((root / 'cache' / name).read_bytes(), (source / name).read_bytes())

    def test_malicious_pax_paths_and_metadata_refuse_before_extraction(self):
        cases = [
            {'path': '../escape'}, {'path': '/absolute/escape'},
            {'path': 'npm/../../escape'}, {'linkpath': 'outside'},
            {'uid': '999'}, {'gid': '999'}, {'mtime': '123'},
            {'uname': 'other'}, {'gname': 'other'}, {'size': '100'},
            {'GNU.sparse.map': '0,1'}]
        with tempfile.TemporaryDirectory() as temporary:
            lane = Path(temporary).resolve()
            for number, headers in enumerate(cases):
                archive = lane / ('bad-' + str(number) + '.tar')
                with tarfile.open(archive, 'w', format=tarfile.PAX_FORMAT) as target:
                    member = tarfile.TarInfo('npm/safe')
                    member.size = 1
                    member.pax_headers = headers
                    target.addfile(member, io.BytesIO(b'x'))
                root = lane / ('run-' + str(number))
                root.mkdir()
                with self.subTest(headers=headers), self.assertRaises(guard.Refusal):
                    guard.seed_cache(archive, sha(archive), root, lane)
                self.assertFalse((root / 'cache').exists())

    def test_global_extensions_links_and_duplicates_refuse(self):
        with tempfile.TemporaryDirectory() as temporary:
            lane = Path(temporary).resolve()
            for number, kind in enumerate(('global', 'symlink', 'hardlink', 'duplicate', 'gnu')):
                archive = lane / (kind + '.tar')
                options = {'format': tarfile.PAX_FORMAT}
                if kind == 'global':
                    options['pax_headers'] = {'path': 'npm/global'}
                if kind == 'gnu':
                    options['format'] = tarfile.GNU_FORMAT
                with tarfile.open(archive, 'w', **options) as target:
                    member = tarfile.TarInfo('npm/' + ('x' * 180 if kind == 'gnu' else 'safe'))
                    if kind in ('symlink', 'hardlink'):
                        member.type = tarfile.SYMTYPE if kind == 'symlink' else tarfile.LNKTYPE
                        member.linkname = 'npm/other'
                    target.addfile(member)
                    if kind == 'duplicate':
                        target.addfile(member)
                root = lane / ('run-' + str(number))
                root.mkdir()
                with self.subTest(kind=kind), self.assertRaises(guard.Refusal):
                    guard.seed_cache(archive, sha(archive), root, lane)
                self.assertFalse((root / 'cache').exists())

    def test_nonzero_directory_cannot_hide_global_or_gnu_headers(self):
        with tempfile.TemporaryDirectory() as temporary:
            lane = Path(temporary).resolve()
            directory = tarfile.TarInfo('npm')
            directory.type = tarfile.DIRTYPE
            directory.size = 1024
            regular = tarfile.TarInfo('npm/visible')
            global_header = tarfile.TarInfo.create_pax_global_header({'path': 'npm/hidden'})
            gnu = tarfile.TarInfo('npm/' + 'x' * 150).tobuf(format=tarfile.GNU_FORMAT)
            cases = {
                'global': directory.tobuf(format=tarfile.USTAR_FORMAT) + global_header + regular.tobuf(format=tarfile.USTAR_FORMAT),
                'gnu': directory.tobuf(format=tarfile.USTAR_FORMAT) + gnu}
            for kind, contents in cases.items():
                archive = lane / (kind + '.tar')
                archive.write_bytes(contents + bytes(1024))
                with tarfile.open(archive, 'r:') as target:
                    names = [row.name for row in target.getmembers()]
                self.assertTrue('npm/hidden' in names if kind == 'global' else any(len(name) > 100 for name in names))
                root = lane / ('run-' + kind)
                root.mkdir()
                with self.subTest(kind=kind), self.assertRaisesRegex(guard.Refusal, 'directory payload'):
                    guard.seed_cache(archive, sha(archive), root, lane)
                self.assertFalse((root / 'cache').exists())

    def test_raw_and_tarfile_sequence_disagreement_refuses(self):
        with tempfile.TemporaryDirectory() as temporary:
            lane = Path(temporary).resolve()
            archive = lane / 'seed.tar'
            with tarfile.open(archive, 'w', format=tarfile.PAX_FORMAT) as target:
                target.addfile(tarfile.TarInfo('npm/valid'))
            expected = guard.validate_seed_headers(archive)
            root = lane / 'run'
            root.mkdir()
            for index, value in ((0, 512), (1, tarfile.DIRTYPE), (2, 'npm/different'), (3, 1)):
                changed = list(expected[0])
                changed[index] = value
                with patch('guard.validate_seed_headers', return_value=[tuple(changed)]), self.subTest(field=index), self.assertRaisesRegex(guard.Refusal, 'parser disagree'):
                    guard.seed_cache(archive, sha(archive), root, lane)
                self.assertFalse((root / 'cache').exists())


if __name__ == '__main__':
    unittest.main()

