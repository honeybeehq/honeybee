#!/bin/sh
# usage: run.sh <mode: leak|clean> <test files...>
mode=$1; shift
REPO=/Users/trmd/.hive/v2/cells/rebuild-hb-deploy-gate-green-9f244dd9f6f2/honeybee-space-9f244dd9f6f2
MISE=/Users/trmd/.local/share/mise/installs/node/25.8.0/bin
cd "$REPO" || exit 2
if [ "$mode" = leak ]; then
  exec env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" SHELL=/bin/zsh LANG=en_US.UTF-8 TMPDIR="$TMPDIR" \
    PATH="/tmp/hb-gate/bin:$MISE:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    HIVE_NO_KEYCHAIN=1 HIVE_NODE_PATH=/opt/homebrew/Cellar/node/25.8.0/bin/node HIVE_NODE_VERSION=25.8.0 HIVE_NODE_SHA256=9bd9754f5300bd7910f280d8e413f13bb1460b30457243aa366d253677e893f3 \
    HIVE_V2_DATA_DIR=/Users/trmd/.hive/v2 HIVE_V2_SOCKET_PATH=/Users/trmd/.hive/v2/hived.sock HIVE_BEE=x HIVE_BEE_ID=x HIVE_CELL=1 CLAUDE_CONFIG_DIR="$CLAUDE_CONFIG_DIR" \
    node scripts/with-fixture-warden.mjs node scripts/run-v2-daemon-tests.mjs "$@"
else
  exec env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" SHELL=/bin/zsh LANG=en_US.UTF-8 TMPDIR="$TMPDIR" \
    PATH="/tmp/hb-gate/bin:$MISE:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    HIVE_NO_KEYCHAIN=1 \
    node scripts/with-fixture-warden.mjs node scripts/run-v2-daemon-tests.mjs "$@"
fi
