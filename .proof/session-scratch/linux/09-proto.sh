#!/usr/bin/env bash
LAB_PARENT="$(dirname "$HOME")/L"; export LAB_PARENT
. "$(dirname "$0")/lib.sh"
export LAB
cd "$(dirname "$0")/../../.."
node scripts/build-peercred.mjs --optional 2>&1 | tail -1; node scripts/build-delivery-file.mjs --optional 2>&1 | tail -1
node --experimental-strip-types .proof/session-scratch/proto/run.ts 2>&1 | grep -v ExperimentalWarning
