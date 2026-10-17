#!/bin/bash
set -u
SCG_RC=0
SCG_PHASE=startup
trap 'rc=$?; if [ "$rc" -ne 0 ]; then printf "WORKLOAD_NONZERO_REASON=phase:%s exit:%s\n" "$SCG_PHASE" "$rc"; fi' EXIT
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
SCG_PHASE=node-validation
"$SCG_NODE_BIN" --version > "$GATE_ROOT/node-version.txt"
if [ "$("$SCG_NODE_BIN" -p 'Number(process.versions.node.split(".")[0]) >= 24')" != true ]; then
  gate_fail 'Node >=24 required'; exit 90
fi
gate_lockdown
SCG_PHASE=body
. "$1"
rc=$?
[ "$rc" -ne 0 ] || rc=$SCG_RC
[ ! -s "$GATE_ROOT/security-calls" ] || rc=95
[ ! -s "$SCG_NET_VIOLATIONS" ] || rc=95
SCG_PHASE=final-guards
exit "$rc"
