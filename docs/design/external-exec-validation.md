# External execution dev validation

Base: 77d877c0c9cb19c4e93451635ae27d9f713a8765. Satellite Cell only.
No merge, deploy, live owner config change, guest start, provider request or guest
credential delivery. This is review code, not a claim of end-to-end usability.

## Passing checks

- `git diff --check`.
- `npm run check` and `npm run v2:check`.
- `npm run build`, including the separate external-runner artifact.
- `npm run v2:test`: 608 passing tests across core and fleet projection checks.
- `npm run v2:driver`: 166 passing adapter/HSR tests.
- Final external-only tests: 13 passing. Covers exact retry/attempt exclusion,
  close/reopen fencing, receipt binding, default-off capability, LocalRpcTrust and
  workspace context, immutable/atomic admission without accounts, raw path safety,
  fd exec after pathname replacement, and stop via the host control lane.
- Targeted config/local RPC regressions: 46 passing tests.
- CLI routing and harness registry: 7 passing tests.
- FINAL installed pin check: all three hashes match; each independently altered
  hash refuses. This checker opens/hashes files and never executes the bridge.

The final external tests were rerun after the final protocol/storage changes.
The broader existing regression suites supplement them; counts overlap and must
not be summed into a unique-test claim.

## Failures and limits

`npm run v2:daemon` stopped in delivery-file-read.test.ts with two fixture setup
errors, before sandboxed delivery was exercised: cell-sandbox and satellite-default
could not find a base outside Linux private mounts with socket paths <=103 bytes.
The reported candidate lengths were 44 and 168; the short candidate was a private
mount. The run recorded 773 tests: 770 pass, 2 fail and 1 skipped. Later serial
integration files were not reached. No unrelated fixture code was changed.

Earlier iterations caught and fixed a receipt JSON type, nullable child stdio,
schema-47 stamp assertions, a reversed enqueueCommand argument, and the new test's
overlong socket path. An initial synthetic host test also used the wrong config
filename. Relevant final checks now pass; these are not hidden as clean first runs.

Full logs, FINAL pins.json, the private owner config and the generated review patch
are under this Cell's `.local/external-exec-dev/`. The config grants only `ur` the
registered `urbench-v2` bridge and does not point at the live Honeybee data directory.

Before any guest proof: Queen reviews the source, particularly fd/pin checks, exact
environment, management gate and raw capture path safety. The real FINAL bridge's
start/wait/stop/reconcile round trip remains unexercised by this work. No production
Apiary tool has been extended to grant an agent this management authority.

Phase 3 is a separate design proposal. Queen approved her revised protocol and
policy portions; Tormod decision 7a0b4e6b remains pending. There is no phase-3 code.
