import unittest

from focused_signal import authorize


class SignalTests(unittest.TestCase):
    def test_foreign_and_special_targets_refuse_own_group_requires_every_member(self):
        root = ['10', '1', '100', '1']
        child = ['11', '10', '101', '2']
        grandchild = ['12', '11', '102', '3']
        retained = [root, child, grandchild]
        current = {10: root, 11: child, 12: grandchild}
        approved = {11: child, 12: grandchild}
        for target in (0, -1, -99, 99):
            with self.subTest(target=target), self.assertRaises(ValueError):
                authorize(10, target, retained, approved, current, [99])
        self.assertTrue(authorize(10, 11, retained, approved, current))
        self.assertTrue(authorize(10, -11, retained, approved, current, [11, 12]))
        with self.assertRaisesRegex(ValueError, 'foreign'):
            authorize(10, -11, retained, approved, current, [11, 12, 99])
        with self.assertRaises(ValueError):
            authorize(10, 11, retained, approved, {10: root, 11: ['11', '10', '999', '9']} )
        with self.assertRaises(ValueError):
            authorize(12, 11, retained, approved, current)
        reused = ['11', '10', '999', '9']
        with self.assertRaises(ValueError):
            authorize(10, 11, [root, reused], approved, {10: root, 11: reused})


if __name__ == '__main__':
    unittest.main()
