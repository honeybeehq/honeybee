import errno
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from focused_sentinel import snapshot


class SentinelTests(unittest.TestCase):
    def test_fixed_scope_metadata_only_without_tcc_or_session_walk(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve()
            for directory in ('Library/Keychains', 'Library/Mail', 'Library/Messages', 'Library/Containers', '.ssh', '.codex/sessions'):
                (home / directory).mkdir(parents=True)
                (home / directory / 'secret').write_text('never read')
            (home / 'Library/Keychains/nested').mkdir()
            (home / 'Library/Keychains/nested/private').write_text('never inspect')
            (home / '.codex/config.toml').write_text('fixture config')
            (home / '.ssh/link').symlink_to(home / 'Library/Mail')
            rows = snapshot(home)
            self.assertIn('Library/Keychains/secret', rows)
            self.assertNotIn('Library/Keychains/nested/private', rows)
            self.assertIn('.ssh/link', rows)
            self.assertNotIn('.ssh/link/secret', rows)
            self.assertIn('.codex/config.toml', rows)
            self.assertFalse(any('sessions' in name or '/Mail' in name or '/Messages' in name or '/Containers' in name for name in rows))
            self.assertFalse(any('sha256' in row for row in rows.values()))
            self.assertEqual(rows['.gitconfig'], {'absent': True})

    def test_permission_is_recorded_unobservable(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve()
            with patch('focused_sentinel.os.stat', side_effect=PermissionError(errno.EPERM, 'fixture')):
                rows = snapshot(home)
            self.assertEqual(rows['.gitconfig'], {'unobservable': True, 'errno': errno.EPERM})

    def test_redirected_parent_refuses(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve()
            (home / 'Library').symlink_to(home)
            with self.assertRaises(OSError):
                snapshot(home)


if __name__ == '__main__':
    unittest.main()
