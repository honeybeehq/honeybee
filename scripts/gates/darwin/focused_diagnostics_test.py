import unittest

from focused_diagnostics import TABLE, check
from focused_tap import adjudicate


class DiagnosticTests(unittest.TestCase):
    def test_diagnostics_are_bound_to_each_row(self):
        rows = []
        for kind in ('hsr', 'cell-sandbox', 'satellite-default'):
            denial = TABLE['hsrWrite'] if kind == 'hsr' else 'write denied: ' + kind + '; errno=EPERM; scratchPaths:[] fixture narrowing; all other SBPL rules byte-for-byte production'
            rows.append({'fullName': 'Darwin OS-level file read outside cwd: ' + kind + '; tool-policy read UNVERIFIED (OS-level only)', 'diagnostics': [*TABLE['harnessLabels'], denial]})
        self.assertTrue(check(rows)['ok'])
        rows[0]['diagnostics'].remove(TABLE['harnessLabels'][0])
        rows[1]['diagnostics'].append(TABLE['harnessLabels'][0])
        self.assertFalse(check(rows)['ok'])

    def test_strip_exactly_one_tap_prefix(self):
        text = 'TAP version 13\nok 1 - required\n  # Claude: tool-policy read UNVERIFIED (OS-level only)\n  # # Codex: tool-policy read UNVERIFIED (OS-level only)\n1..1\n'
        rows = adjudicate(text, ['required'], 0)['expectedRows']
        self.assertIn(TABLE['harnessLabels'][0], rows[0]['diagnostics'])
        self.assertNotIn(TABLE['harnessLabels'][1], rows[0]['diagnostics'])


if __name__ == '__main__':
    unittest.main()
