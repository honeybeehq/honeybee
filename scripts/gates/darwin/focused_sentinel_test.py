from pathlib import Path
import tempfile
import unittest

from focused_sentinel import snapshot


class SentinelTests(unittest.TestCase):
    def test_metadata_only_and_symlink_not_followed(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve()
            library = home / 'Library'
            library.mkdir()
            (library / 'private.plist').write_text('never read this content')
            (home / 'outside').mkdir()
            (home / 'outside/secret').write_text('unrelated')
            (library / 'link').symlink_to(home / 'outside')
            rows = snapshot(home, ['Library', '.codex'])
            self.assertEqual(rows['.codex'], {'absent': True})
            self.assertIn('Library/link', rows)
            self.assertNotIn('Library/link/secret', rows)
            self.assertFalse(any('sha256' in row for row in rows.values()))
            (library / 'private.plist').write_text('changed')
            self.assertNotEqual(snapshot(home, ['Library', '.codex']), rows)

    def test_redirected_root_refuses(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve()
            (home / 'redirect').symlink_to(home)
            with self.assertRaises(OSError):
                snapshot(home, ['redirect/Library'])


if __name__ == '__main__':
    unittest.main()
