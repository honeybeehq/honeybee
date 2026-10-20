#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
lab_root=$(mktemp -d /var/tmp/hb-quota-C.XXXXXXXX)
chmod 700 "$lab_root"
mkdir -p "$lab_root/home" "$lab_root/tmp" "$lab_root/cache" "$lab_root/npm" "$lab_root/results"
exec env -i PATH="/usr/local/bin:/usr/bin:/bin" HOME="$lab_root/home" TMPDIR="$lab_root/tmp" XDG_CACHE_HOME="$lab_root/cache" npm_config_cache="$lab_root/npm" NODE_COMPILE_CACHE="$lab_root/cache/node" C_HOLD_MS="${C_HOLD_MS:-1600}" C_LAB_ROOT="$lab_root" C_LAB_RESULTS="$lab_root/results" NODE_OPTIONS="--import=$PWD/.proof/C/trash-cleanup.mjs" /usr/local/bin/node .proof/C/lab.ts "$@"
