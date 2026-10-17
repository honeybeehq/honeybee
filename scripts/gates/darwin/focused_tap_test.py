import unittest

from focused_tap import adjudicate


class TapTests(unittest.TestCase):
    def test_nested_names(self):
        result = adjudicate('TAP version 13\n    ok 1 - first\n    ok 2 - second\nok 1 - suite\n1..1\n', ['suite > first', 'suite > second'], 0)
        self.assertTrue(result['ok'], result)

    def test_nonpassing_rows(self):
        for row in ('ok 1 - required # SKIP unsupported', 'ok 1 - required # TODO later', 'not ok 1 - required'):
            self.assertFalse(adjudicate('TAP version 13\n' + row + '\n', ['required'], 0)['ok'])

    def test_missing_duplicate_and_process_failure(self):
        for text, code in (('ok 1 - other\n', 0), ('ok 1 - required\nok 2 - required\n', 0), ('ok 1 - required\n', 1)):
            self.assertFalse(adjudicate('TAP version 13\n' + text, ['required'], code)['ok'])

    def test_cancelled_unselected_row_fails(self):
        text = 'TAP version 13\nok 1 - required\nnot ok 2 - cancelled\n  ---\n  failureType: cancelledByParent\n  ...\n'
        self.assertFalse(adjudicate(text, ['required'], 0)['ok'])

    def test_unexpected_skip_fails(self):
        self.assertFalse(adjudicate('TAP version 13\nok 1 - required\nok 2 - extra # SKIP\n', ['required'], 0)['ok'])
        self.assertFalse(adjudicate('TAP version 13\nok 1 - required\nok 2 - extra\n1..2\n', ['required'], 0)['ok'])

    def test_plan_required_and_consistent(self):
        for plan in ('', '1..0\n', '1..2\n', '1..1\n1..1\n'):
            self.assertFalse(adjudicate('TAP version 13\nok 1 - required\n' + plan, ['required'], 0)['ok'])
        self.assertTrue(adjudicate('TAP version 13\nok 1 - required\n1..1\n', ['required'], 0)['ok'])


if __name__ == '__main__':
    unittest.main()
