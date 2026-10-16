import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent
SOURCE = (ROOT / "darwin-gate.sh").read_text()
FUNCTION = SOURCE[SOURCE.index("lib_third_party_owner() {"):SOURCE.index("\nclaude_census() {")]
RULES = "\n".join(line for line in (ROOT / "third-party-warn.txt").read_text().splitlines() if line and not line.startswith("#"))
DIRECTORY = "Application Support/CrashReporter"
INTERVALS = DIRECTORY + "/Intervals_example.plist"


class CrashReporterRule(unittest.TestCase):
    def verdict(self, path, before):
        with tempfile.TemporaryDirectory(dir=os.environ["LAB_ROOT"]) as temporary:
            snapshot = Path(temporary) / "before.areas"
            snapshot.write_text("".join(inode + "|" + name + "\n" for inode, name in before))
            command = FUNCTION + '\nlib_third_party_owner "$1" "$2"'
            result = subprocess.run(["bash", "-c", command, "rule", path, str(snapshot)], env={**os.environ, "LIB_OUR_NAMES": "dev.apiary.|dev.honeybee.|Apiary|Honeybee", "LIB_THIRD_PARTY": RULES}, capture_output=True, text=True)
            return result.returncode == 0

    def test_existing_directory(self):
        self.assertTrue(self.verdict(DIRECTORY, [("1", DIRECTORY)]))

    def test_existing_intervals(self):
        self.assertTrue(self.verdict(INTERVALS, [("1", INTERVALS)]))

    def test_existing_path_new_inode(self):
        before = "150875973|" + INTERVALS
        after = "152787042|" + INTERVALS
        self.assertNotEqual(before.split("|", 1)[0], after.split("|", 1)[0])
        self.assertTrue(self.verdict(after.split("|", 1)[1], [tuple(before.split("|", 1))]))

    def test_new_intervals(self):
        self.assertFalse(self.verdict(INTERVALS, [("1", DIRECTORY)]))

    def test_new_diagnostic_report(self):
        self.assertFalse(self.verdict("Logs/DiagnosticReports/new.ips", [("1", DIRECTORY)]))

    def test_nested_intervals(self):
        path = DIRECTORY + "/nested/Intervals_example.plist"
        self.assertFalse(self.verdict(path, [("1", path)]))

    def test_new_directory(self):
        self.assertFalse(self.verdict(DIRECTORY, []))


if __name__ == "__main__":
    unittest.main(verbosity=2)
