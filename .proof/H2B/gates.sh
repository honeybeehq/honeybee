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
node --test --test-isolation=none v2/core/tests/*.test.ts
node --test v2/daemon/tests/human-first.test.ts v2/daemon/tests/human-chat-rpc.test.ts v2/daemon/tests/loops.test.ts v2/daemon/tests/local-rpc-trust.test.ts v2/daemon/tests/question-withdraw-rpc.test.ts v2/driver-hsr/tests/fresh-turn.test.ts v2/driver-hsr/tests/runner-host.test.ts v2/adapters/tests/*.test.ts v2/driver-cell/tests/fresh-turn.test.ts
node --input-type=module -e 'import {readdirSync} from "node:fs";import {spawnSync} from "node:child_process";const files=[...readdirSync("v2/daemon/tests").filter(x=>x.endsWith(".test.ts")&&x!=="socket-path.test.ts").map(x=>"v2/daemon/tests/"+x),...readdirSync("v2/cli/tests").filter(x=>x.endsWith(".test.ts")).map(x=>"v2/cli/tests/"+x)];process.exit(spawnSync(process.execPath,["scripts/with-fixture-warden.mjs",process.execPath,"scripts/run-v2-daemon-tests.mjs",...files],{stdio:"inherit"}).status??1)'
bash .proof/H2B/socket-fixture.sh
