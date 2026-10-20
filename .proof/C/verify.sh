#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
lab_root=$(mktemp -d /var/tmp/hb-quota-C.XXXXXXXX)
chmod 700 "$lab_root"
mkdir -p "$lab_root/home" "$lab_root/tmp" "$lab_root/cache" "$lab_root/npm" "$lab_root/results"
exec env -i PATH="/usr/local/bin:/usr/bin:/bin" HOME="$lab_root/home" TMPDIR="$lab_root/tmp" XDG_CACHE_HOME="$lab_root/cache" npm_config_cache="$lab_root/npm" NODE_COMPILE_CACHE="$lab_root/cache/node" C_LAB_ROOT="$lab_root" /bin/bash --noprofile --norc -euo pipefail -c '
  printf "%s\n" "$C_LAB_ROOT"
  npm run check > "$C_LAB_ROOT/results/typecheck.log" 2>&1
  npm run v2:check > "$C_LAB_ROOT/results/v2-typecheck.log" 2>&1
  npm run build > "$C_LAB_ROOT/results/build.log" 2>&1
  NODE_OPTIONS="--import=$PWD/.proof/C/trash-cleanup.mjs" node --test v2/daemon/tests/accounts-rpc.test.ts v2/daemon/tests/loops.test.ts v2/driver-hsr/tests/runner-host.test.ts > "$C_LAB_ROOT/results/existing-tests.log" 2>&1
'
