#!/bin/bash
set -eu
if [ "${TASK_ENV_CLEAN:-}" != 1 ]; then exec env -i PATH="$PATH" TASK_ENV_CLEAN=1 bash "$0"; fi
mkdir -p .h .t
export HOME="$PWD/.h"
export TMPDIR="$PWD/.t"
export GIT_CEILING_DIRECTORIES="$PWD/.t"
if [ ! -f node_modules/typescript/bin/tsc ]; then npm --force ci --ignore-scripts; fi
npm --force run check
npm --force run v2:check
npm --force run build
node scripts/with-fixture-warden.mjs node --test v2/daemon/tests/human-first.test.ts v2/daemon/tests/human-chat-rpc.test.ts v2/daemon/tests/limits-observation-rpc.test.ts v2/daemon/tests/loops.test.ts v2/core/tests/pending-covering-index.test.ts v2/core/tests/list-messages-union.test.ts
