import json
import unittest

from focused_diagnostics import TABLE, check, compare_pair, read_result
from focused_tap import adjudicate


class DiagnosticTests(unittest.TestCase):
    def rows(self, kinds=('hsr', 'cell-sandbox', 'satellite-default'), digest='a'):
        rows = []
        for kind in kinds:
            denial = TABLE['hsrWrite'] if kind == 'hsr' else 'write denied: ' + kind + '; errno=EPERM; scratchPaths:[] fixture narrowing; all other SBPL rules byte-for-byte production'
            proof = {'substrate': kind, 'expectedDigest': digest * 64, 'observedDigest': digest * 64, 'expectedHeaderSha256': 'b' * 64, 'observedHeaderSha256': 'b' * 64, 'readClass': 'read', 'writeDenied': None if kind == 'hsr' else True}
            rows.append({'fullName': 'Darwin OS-level file read outside cwd: ' + kind + '; tool-policy read UNVERIFIED (OS-level only)', 'diagnostics': [*TABLE['harnessLabels'], denial, 'SCG_READ_RESULT=' + json.dumps(proof)]})
        return rows

    def test_diagnostics_are_bound_to_each_row(self):
        rows = self.rows()
        self.assertTrue(check(rows)['ok'])
        rows[0]['diagnostics'].remove(TABLE['harnessLabels'][0])
        rows[1]['diagnostics'].append(TABLE['harnessLabels'][0])
        self.assertFalse(check(rows)['ok'])

    def test_pair_uses_each_runs_own_digests_and_compares_outcomes(self):
        kinds = ('cell-sandbox', 'satellite-default')
        left = {'ok': True, 'diagnostics': check(self.rows(kinds, 'a'), kinds)}
        right = {'ok': True, 'diagnostics': check(self.rows(kinds, 'c'), kinds)}
        result = compare_pair(left, right)
        self.assertTrue(result['ok'])
        self.assertNotEqual(result['rows'][0]['instrumented']['observedDigest'], result['rows'][0]['production']['observedDigest'])
        right['ok'] = False
        self.assertFalse(compare_pair(left, right)['ok'])

    def test_read_result_missing_malformed_mismatched_or_duplicate_fails(self):
        row = self.rows(('cell-sandbox',))[0]
        for value in ('SCG_READ_RESULT={}', 'SCG_READ_RESULT=invalid'):
            self.assertFalse(read_result(dict(row, diagnostics=[value]), 'cell-sandbox')['ok'])
        self.assertFalse(read_result(dict(row, diagnostics=[]), 'cell-sandbox')['ok'])
        line = row['diagnostics'][-1]
        self.assertFalse(read_result(dict(row, diagnostics=[line, line]), 'cell-sandbox')['ok'])
        data = json.loads(line.split('=', 1)[1])
        for key, value in [('observedDigest', 'c' * 64), ('observedHeaderSha256', 'c' * 64), ('writeDenied', False), ('readClass', 'unknown')]:
            bad = dict(data, **{key: value})
            self.assertFalse(read_result(dict(row, diagnostics=['SCG_READ_RESULT=' + json.dumps(bad)]), 'cell-sandbox')['ok'])

    def test_strip_exactly_one_tap_prefix(self):
        text = 'TAP version 13\nok 1 - required\n  # Claude: tool-policy read UNVERIFIED (OS-level only)\n  # # Codex: tool-policy read UNVERIFIED (OS-level only)\n1..1\n'
        rows = adjudicate(text, ['required'], 0)['expectedRows']
        self.assertIn(TABLE['harnessLabels'][0], rows[0]['diagnostics'])
        self.assertNotIn(TABLE['harnessLabels'][1], rows[0]['diagnostics'])


if __name__ == '__main__':
    unittest.main()
