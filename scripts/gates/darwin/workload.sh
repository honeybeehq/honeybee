#!/bin/bash
set -u
SCG_RC=0
gate_fail() { printf 'GATE FAIL: %s\n' "$*"; SCG_RC=1; }
gate_lockdown() { export GIT_ALLOW_PROTOCOL=file; }
sb() { "$@"; }
deps_check() { [ ! -L node_modules ] || { gate_fail 'symlink node_modules'; exit 91; }; }
mkdir -p "$GATE_ROOT/bin" "$GATE_ROOT/logs"
printf '#!/bin/sh\nprintf "refused\\n" >> "%s/security-calls"\nexit 1\n' "$GATE_ROOT" > "$GATE_ROOT/bin/security"
chmod 700 "$GATE_ROOT/bin/security"
export PATH="$GATE_ROOT/bin:$PATH"
export SCG_NET_VIOLATIONS="$GATE_ROOT/network-attempts.jsonl"
export NODE_OPTIONS="--import=$PWD/scripts/gates/darwin/network.mjs"
"$SCG_NODE_BIN" --version > "$GATE_ROOT/node-version.txt"
if [ "$("$SCG_NODE_BIN" -p 'Number(process.versions.node.split(".")[0]) >= 24')" != true ]; then
  gate_fail 'Node >=24 required'; exit 90
fi
gate_lockdown
. "$1"
rc=$?
[ "$rc" -ne 0 ] || rc=$SCG_RC
[ ! -s "$GATE_ROOT/security-calls" ] || rc=95
[ ! -s "$SCG_NET_VIOLATIONS" ] || rc=95
exit "$rc"
