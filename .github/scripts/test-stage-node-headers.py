import contextlib
import io
import os
import pathlib
import runpy
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = pathlib.Path(__file__).with_name('stage-node-headers.py')

class HeaderStaging(unittest.TestCase):
    def invoke(self, source, destination):
        with patch.object(sys, 'argv', [str(SCRIPT), str(source), str(destination)]), patch('os.chown') as chown, patch('os.fchown') as fchown:
            runpy.run_path(str(SCRIPT), run_name='__main__')
            return chown, fchown

    def test_exact_regular_tree_and_modes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            source = root / 'source'
            source.mkdir()
            (source / 'nested').mkdir()
            (source / 'node_api.h').write_bytes(b'header')
            (source / 'nested' / 'v8.h').write_bytes(b'v8')
            target = root / 'include' / 'node'
            chown, fchown = self.invoke(source, target)
            self.assertEqual((target / 'node_api.h').read_bytes(), b'header')
            self.assertEqual((target / 'nested' / 'v8.h').read_bytes(), b'v8')
            self.assertEqual((target / 'node_api.h').stat().st_mode & 0o777, 0o644)
            self.assertEqual((target / 'nested').stat().st_mode & 0o777, 0o755)
            self.assertTrue(all(call.args[1:] == (0, 0) for call in chown.call_args_list))
            self.assertEqual(fchown.call_count, 2)

    def test_symlink_file_and_directory_refused(self):
        for is_directory in [False, True]:
            with self.subTest(directory=is_directory), tempfile.TemporaryDirectory() as directory:
                root = pathlib.Path(directory)
                source = root / 'source'
                source.mkdir()
                outside = root / 'outside'
                outside.mkdir() if is_directory else outside.write_bytes(b'outside')
                (source / 'link').symlink_to(outside)
                with self.assertRaises((ValueError, OSError)):
                    self.invoke(source, root / 'target')
                self.assertFalse((root / 'target' / 'link').exists())

if __name__ == '__main__':
    unittest.main()
