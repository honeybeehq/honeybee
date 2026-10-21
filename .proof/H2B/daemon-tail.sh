#!/bin/bash
set -eu
if [ "${TASK_ENV_CLEAN:-}" != 1 ]; then exec env -i PATH="$PATH" TASK_ENV_CLEAN=1 bash "$0"; fi
mkdir -p .h .t
export HOME="$PWD/.h"
export TMPDIR="$PWD/.t"
export GIT_CEILING_DIRECTORIES="$PWD/.t"
node --input-type=module -e 'import {readdirSync} from "node:fs";import {spawnSync} from "node:child_process";const files=[...readdirSync("v2/daemon/tests").filter(x=>x.endsWith(".test.ts")&&x>"socket-path.test.ts").map(x=>"v2/daemon/tests/"+x),...readdirSync("v2/cli/tests").filter(x=>x.endsWith(".test.ts")).map(x=>"v2/cli/tests/"+x)].sort();console.log(JSON.stringify({remainingFiles:files}));process.exit(spawnSync(process.execPath,["scripts/with-fixture-warden.mjs",process.execPath,"scripts/run-v2-daemon-tests.mjs",...files],{stdio:"inherit"}).status??1)'
