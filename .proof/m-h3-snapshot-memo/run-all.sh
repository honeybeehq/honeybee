#!/bin/sh
set -u
cd "$(dirname "$0")/../.."
W=.proof/m-h3-snapshot-memo/no-hive-env.sh





$W node scripts/with-fixture-warden.mjs node --test --test-isolation=none v2/core/tests/mirror.test.ts > .proof/m-h3-snapshot-memo/tests-core.log 2>&1
echo "core tests exit $?"
$W node scripts/with-fixture-warden.mjs node scripts/run-v2-daemon-tests.mjs \
  v2/daemon/tests/integration.test.ts v2/daemon/tests/env-egress.test.ts v2/daemon/tests/mirror-env-redaction.test.ts \
  v2/daemon/tests/preflip-verbs.test.ts v2/daemon/tests/performance.test.ts v2/daemon/tests/question-dismiss-projection.test.ts \
  v2/daemon/tests/question-dismiss-egress.test.ts v2/daemon/tests/answer-trigger-census.test.ts v2/daemon/tests/answer-trigger-negotiation.test.ts \
  v2/daemon/tests/registry.test.ts v2/daemon/tests/human-ref.test.ts v2/daemon/tests/champions.test.ts v2/daemon/tests/mail-wake.test.ts \
  v2/daemon/tests/accounts-rpc.test.ts v2/daemon/tests/actions-rpc.test.ts v2/daemon/tests/cell-pressure.test.ts v2/daemon/tests/cell-park.test.ts \
  v2/daemon/tests/external-parent.test.ts v2/daemon/tests/handoff-rpc.test.ts v2/daemon/tests/human-output-daemon.test.ts v2/daemon/tests/login-flows-rpc.test.ts \
  v2/daemon/tests/mail-batching-rpc.test.ts v2/daemon/tests/muse-authority-rpc.test.ts v2/daemon/tests/thread-operation-rpc.test.ts v2/daemon/tests/auth-resume-rpc.test.ts \
  > .proof/m-h3-snapshot-memo/tests-daemon.log 2>&1
echo "daemon tests exit $?"
