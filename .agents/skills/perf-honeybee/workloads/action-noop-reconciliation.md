# Unchanged action lane reconciliation

The action scheduler repeatedly asks whether an archive command has settled, or
holds a capture while its executor is unavailable. Measure full-lane audit view
builds, not elapsed time, on a shared host. Read the JSON record for the exact
recipe; create `.proof/` first and use Node 24.18.0.

Before changing production code, acceptance is zero `listActionViews` calls for
each ten-poll sample, unchanged durable state/audit/return values, and passing
settlement, failure, changed-detail, claim, downstream-hold and reopen controls.
A real mutation must retain both before/after audit views. Fixture construction
and parity assertions are outside the counted interval. The returned ActionView
still reads its lane; this workload does not claim constant total cost.

The test emits a compact count receipt only when HIVE_ACTION_NOOP_RECEIPT is set.
Failed assertions still make the command fail; always retain its exit status.
The receipt covers the count samples, not all functional tests. Do not infer a
full test pass from a passing map verdict alone. Run `node scripts/perf-map.mjs
check .proof/action-noop-counts.json` after the tests. The JSON report records
source hashes and host/runtime identity. No CPU, latency or memory gain is claimed.
