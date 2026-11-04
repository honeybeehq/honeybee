# P2-freeze-cmds evidence

- `byte-compare-vs-4531a680.md`: the same 36 deploy/rollback/completion scenarios replayed against this build and compared with the capture of the pre-freeze build (4531a680). Every deploy, rollback, list, init and usage-error row is identical; only completion output and the dev version suffix differ, exactly as for the freeze.
- `byte-compare-vs-freeze.md`: compared with the freeze build's capture: only the completion candidate lists (freeze and import gone) and the dev version suffix differ.
- `after/`: raw stdout, stderr and exit codes per scenario.
- `terminal-removed-verbs.txt`: `script` recording in a scratch store that holds an old FROZEN marker: `hive freeze` and `hive import --from-frozen` are unknown, help and completion no longer list them, the marker file stays on disk untouched, `deploy --list` still answers.
- `change.diff`: the code diff of the task (cutover deletion and the test-runner fix).
- `batteries-summary.txt`, `battery-*.log`: typecheck, core battery and the targeted CLI/daemon files run through the fixed runner under the fixture warden (TMPDIR=/tmp, HIVE_* unset).
