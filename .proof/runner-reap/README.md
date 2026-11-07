# Runner cleanup liveness proof

The cleanup helper used `kill(pid, 0)` to decide whether a runner host remained
live. That succeeds for an exited zombie. A successor daemon cannot wait on an
adopted host because it is not the host's parent. A delayed wait parent can thus
make cleanup time out despite the runner having exited. Retained status files
can also refer to a reused PID.

The helper now uses native process inspection to exclude zombies, gone processes,
and mismatched valid recorded host births. It still reports an actually running
host even if status says `exited`. Unavailable native inspection falls back to
the previous conservative PID-existence check. Legacy statuses without host birth
cannot disambiguate PID reuse. No runtime behavior or timeout changed.

## Reproduce and check

`regression-red.log` shows the old helper failing the retained-zombie test with
`waitFor timeout: test daemon runner hosts reaped`, and the stale-birth test.
`regression-green.log` shows all three teardown tests passing after the fix.
The zombie test uses an owned Node parent blocked on stdin so that its exited
child remains a zombie until the test releases the parent in `finally`.

Run the regression:

```sh
HIVE_NODE_VERSION= HIVE_NODE_SHA256= node --test v2/daemon/tests/helpers-teardown.test.ts
```

`runner-zombie-proof.log` records the same classification error with an actual
stub runner host. The probe pauses only its own disposable daemon, SIGKILLs its
owned runner group, checks the zombie's native identity, then resumes and stops
the daemon. Run it from the repository root:

```sh
HIVE_NODE_VERSION= HIVE_NODE_SHA256= node .proof/runner-reap/runner-zombie-probe.mjs
```

The tests and probe create fresh fixture directories and isolated daemon homes.
Do not substitute a live daemon or an existing data directory.

## Limits

This reproduces a concrete false positive capable of causing the reported
cleanup timeout. It does not establish the process state of historical CI or
Studio PIDs. A live matching runner still fails the same four-second postcondition;
timeout diagnostics now include native state, parent, birth and exit status.

The full daemon suite stress harness pins itself, one owned CPU worker and all
test descendants to four CPUs. Each invocation creates its own short temporary root, HOME and explicit
HIVE paths. Two simultaneous invocations also exercise cross-suite load. On Linux:

```sh
python3 .proof/runner-reap/run-stressed-suite.py repeat-1 'v2/daemon/tests/*.test.ts'
python3 .proof/runner-reap/run-stressed-suite.py repeat-2 'v2/daemon/tests/*.test.ts'
```

Logs and exit codes are saved under `.audit/runner-reap/<run-name>/`; use new run
names. With no file argument the harness runs the standard daemon/CLI gate.

## Exact restart-test reproduction (Linux)

An owned child subreaper retains orphan exit statuses while its test child runs.
This models delayed external reaping, without changing any daemon or runner code.
With the original helper, the unchanged quiet-RPC test fails at line 79 through
helpers.ts lines 38/389 with the reported timeout. The error's exact host PID is
then collected by the subreaper with wait status 9, proving it had already exited.
With the fixed helper, the same three tests pass. See `quiet-subreaper-red.log`
and `quiet-subreaper-green.log`.

```sh
# Expected failure, using the starting commit's helper through a local load hook:
HIVE_NODE_VERSION= HIVE_NODE_SHA256= TMPDIR=/tmp \
  NODE_OPTIONS="--import=$PWD/.proof/runner-reap/original-helper-loader.mjs" \
  python3 .proof/runner-reap/subreaper.py node scripts/with-fixture-warden.mjs \
  node --test v2/daemon/tests/turn-quiet-rpc.test.ts

# Expected success:
HIVE_NODE_VERSION= HIVE_NODE_SHA256= TMPDIR=/tmp \
  python3 .proof/runner-reap/subreaper.py node scripts/with-fixture-warden.mjs \
  node --test v2/daemon/tests/turn-quiet-rpc.test.ts
```

The reaper changes only its own descendant ownership. It collects zombie statuses
after the test finishes; it does not signal or inspect unrelated processes.

## Completed verification

`full-suite-results.txt` records two complete parallel full-daemon runs under CPU
stress. Both reported zero runner-reap timeouts, and both reported files passed.
The full suite is **not green**: ENOSPC, other untriaged timing/assertion failures and fixture
preconditions prevented a deploy-gate claim. One already-failed lease-enrolment
worker had to be terminated after retaining open handles for over four minutes.
The supplemental serial diagnostic also encountered ENOSPC and was stopped.

After stopping load, the cleanup regressions and both reported files passed
8/8 together (`targeted-final.log`). Typecheck and build results are included.
No live daemon was touched and nothing was deployed.
