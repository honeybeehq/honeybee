from pathlib import Path
import os
import tempfile
import unittest

from focused_profile import TEMPLATE, materialize, parse_node_observation, parse_write_policy, profile_state


class ProfileTests(unittest.TestCase):
    def fixture(self, directory):
        temporary = Path(directory).resolve()
        temporary.chmod(0o700)
        root = temporary / 'fr-ABC123'
        root.mkdir(mode=0o700)
        (root / 'work').mkdir(mode=0o700)
        (root / 'data').mkdir(mode=0o700)
        profile = root / 'work/sandbox.sb'
        profile.write_bytes(b'production bytes')
        profile.chmod(0o600)
        return temporary, root, profile

    def test_exact_template_rejects_extra_allow_wrong_root_and_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            temporary, root, profile = self.fixture(directory)
            row = materialize(TEMPLATE, temporary, root, profile)
            self.assertEqual(row['policy'], {'cellDir': str(root / 'work'), 'writablePaths': [], 'scratchPaths': []})
            with self.assertRaisesRegex(ValueError, 'extra or different'):
                materialize(TEMPLATE, temporary, root, profile, dict(row['policy'], writablePaths=['/extra']))
            with self.assertRaisesRegex(ValueError, 'direct mkdtemp'):
                materialize(TEMPLATE, temporary.parent, root, profile)
            link = temporary / 'fr-link'
            link.symlink_to(root)
            with self.assertRaisesRegex(ValueError, 'canonical direct'):
                materialize(TEMPLATE, temporary, link, link / 'work/sandbox.sb')

    def test_profile_hash_inode_link_count_and_byte_equality(self):
        with tempfile.TemporaryDirectory() as directory:
            temporary, root, profile = self.fixture(directory)
            before = profile_state(profile, b'production bytes')
            self.assertEqual(before['nlink'], 1)
            self.assertEqual(before, profile_state(profile, b'production bytes'))
            fifo = root / 'profile-fifo'
            os.mkfifo(fifo)
            with self.assertRaisesRegex(ValueError, 'regular file'):
                profile_state(fifo, b'')
            with self.assertRaisesRegex(ValueError, 'production template'):
                profile_state(profile, b'permissive bytes')
            os.link(profile, root / 'alias')
            with self.assertRaisesRegex(ValueError, 'singly linked'):
                profile_state(profile, b'production bytes')

    def test_live_node_and_policy_queries_reject_unsandboxed_ambiguous_and_wrong_policy(self):
        row = parse_node_observation('NODE /node\nENTRY /reader\nCWD /fixture/work\nSANDBOX 1\n', '/node')
        self.assertTrue(row['sandboxed'])
        self.assertEqual(parse_write_policy('CELL 0\nCONTENT 1\nSEALED 1\n')['sealedRoot'], 'denied')
        for output in ('NODE /node\n', 'NODE /node\nENTRY /reader\nCWD /fixture/work\nSANDBOX -1\n'):
            with self.assertRaises(ValueError):
                parse_node_observation(output, '/node')
        for output in ('CELL 0\nCONTENT 0\nSEALED 0\n', 'CELL 1\nCONTENT 1\nSEALED 1\n', 'CELL 0\nCONTENT -1\nSEALED 1\n'):
            with self.assertRaises(ValueError):
                parse_write_policy(output)


if __name__ == '__main__':
    unittest.main()
