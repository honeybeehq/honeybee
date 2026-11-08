#!/bin/bash
set -eu
# Use after pinned offline install and native build in an isolated checkout.
root=$(mktemp -d /tmp/hb-ci-check-XXXXXX)
mkdir -p "$root"/{home,config,data,cache,run,hive,store}
export HOME="$root/home" XDG_CONFIG_HOME="$root/config" XDG_DATA_HOME="$root/data" XDG_CACHE_HOME="$root/cache" XDG_RUNTIME_DIR="$root/run"
export HIVE_HOME="$root/hive" HIVE_STORE_ROOT="$root/store" HIVE_SOCKET="$root/root.sock" HIVE_NO_KEYCHAIN=1 TMPDIR=/tmp
export npm_config_offline=true npm_config_update_notifier=false
unset HIVE_NODE_VERSION HIVE_NODE_SHA256 HIVE_GATEWAYS_DISABLE HIVE_NODE_PATH HIVE_V2_DATA_DIR HIVE_V2_SOCKET_PATH
node scripts/with-fixture-warden.mjs node scripts/run-v2-daemon-tests.mjs v2/daemon/tests/confined-peer-rpc.test.ts v2/daemon/tests/helpers-teardown.test.ts v2/daemon/tests/turn-quiet-rpc.test.ts
# Deliberately leave the isolated root for inspection; remove with trash when done.
