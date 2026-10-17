import unittest

from focused_roles import Roles


class RoleTests(unittest.TestCase):
    def test_plain_requires_exactly_one_internal_worker_at_depth_one(self):
        entries = {'/test': 'test-runner', '/host': 'runner-host-main', '/reader': 'reader'}
        zero = Roles(10, entries, False)
        zero.observe(['10', '1', '100', '1'], '/test')
        with self.assertRaisesRegex(ValueError, 'missing or duplicate'):
            zero.finish()
        one = Roles(10, entries, False)
        for birth, entry in ((['10', '1', '100', '1'], '/test'), (['11', '10', '101', '1'], '/test'), (['12', '11', '102', '1'], '/host'), (['13', '12', '103', '1'], '/reader')):
            one.observe(birth, entry)
        self.assertTrue(one.finish()['ok'])
        with self.assertRaisesRegex(ValueError, 'internal test-runner'):
            one.observe(['14', '10', '104', '1'], '/test')
        with self.assertRaises(ValueError):
            one.observe(['15', '11', '105', '1'], '/test')

    def test_instrumented_refuses_internal_worker_and_wrong_parent_roles(self):
        entries = {'/test': 'test-runner', '/host': 'runner-host-main', '/reader': 'reader'}
        roles = Roles(10, entries, True)
        roles.observe(['10', '1', '100', '1'], '/test')
        with self.assertRaises(ValueError):
            roles.observe(['11', '10', '101', '1'], '/test')
        with self.assertRaises(ValueError):
            roles.observe(['11', '10', '101', '1'], '/reader')
        roles.observe(['11', '10', '101', '1'], '/host')
        roles.observe(['12', '11', '102', '1'], '/reader')
        self.assertTrue(roles.finish()['ok'])
        with self.assertRaises(ValueError):
            roles.observe(['13', '12', '103', '1'], '/host')


if __name__ == '__main__':
    unittest.main()
