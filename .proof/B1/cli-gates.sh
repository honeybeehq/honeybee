#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
if [[ "${1:-}" != isolated ]]; then
  mkdir -p .proof/B1/cli-state/home .proof/B1/cli-state/tmp
  exec env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$PWD/.proof/B1/cli-state/home" TMPDIR="$PWD/.proof/B1/cli-state/tmp" bash .proof/B1/cli-gates.sh isolated
fi
node --check .proof/B1/cli-collect.mjs
node --check .proof/B1/cli-fixture.mjs
node --check .proof/B1/cli-claude.mjs
node --check .proof/B1/cli-codex.mjs
bash -n .proof/B1/cli-run.sh
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.test.json --noEmit
node --test v2/daemon/tests/human-first.test.ts
npm --force run build
