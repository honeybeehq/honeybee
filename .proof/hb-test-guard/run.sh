#!/usr/bin/env bash
set -u
REPO=$(cd "$(dirname "$0")/../.." && pwd)
SB=$(mktemp -d /tmp/hb-guard-XXXXXX)
mkdir -p "$SB/bin" "$SB/units" "$SB/.hive/v2" "$SB/scratch"
cat > "$SB/bin/systemctl" <<'EOF'
#!/bin/sh
echo "systemctl $*" >> "$FAKE_SYSTEMCTL_LOG"
case "$*" in *is-active*) echo active ;; esac
exit 0
EOF
chmod +x "$SB/bin/systemctl"
export FAKE_SYSTEMCTL_LOG="$SB/systemctl.log"
: > "$FAKE_SYSTEMCTL_LOG"
export HOME="$SB" PATH="$SB/bin:$PATH" HIVE_V2_SERVICE_DIR="$SB/units" HIVE_V2_SERVICE_LABEL=hb.guard.test
export HIVE_NODE_PATH=$(node -p 'require("fs").realpathSync(process.execPath)')
export HIVE_TEST_REAP_RUNTIMES_ON_SHUTDOWN=1
unset HIVE_CELL HIVE_V2_DATA_DIR HIVE_V2_SOCKET_PATH
NODE_DIR="$SB/.hive/v2"
DPID=
cleanup() { [ -n "$DPID" ] && kill -0 "$DPID" 2>/dev/null && kill -TERM "$DPID"; rm -rf "$SB"; }
trap cleanup EXIT
cat > "$SB/units/hb.guard.test.service" <<EOF
[Unit]
Description=Honeybee v2 hive daemon (hb.guard.test)

[Service]
Type=simple
ExecStart="$HIVE_NODE_PATH" "/nowhere/dist/cli.js" "v2" "daemon" "run" "--data-dir" "$NODE_DIR"
EOF
hive() { node "$REPO/v2/cli/src/bin.ts" "$@" 2>&1 | sed "s#$SB#\$SB#g"; echo "[exit ${PIPESTATUS[0]}]"; }
step() { echo; echo "### $*"; }
calls() { echo "--- fake systemctl calls so far: $(wc -l < "$FAKE_SYSTEMCTL_LOG")"; sed "s#$SB#\$SB#g" "$FAKE_SYSTEMCTL_LOG"; }

echo "sandbox: \$SB=$SB (HOME, PATH shim, unit dir, label hb.guard.test); unit bound to \$SB/.hive/v2"
echo "which systemctl: $(which systemctl | sed "s#$SB#\$SB#g")"

step "1. default path: data dir is the unit's own data dir -> the unit is targeted (stop, start, restart)"
hive daemon stop --json
hive daemon start --data-dir "$NODE_DIR" --json
HIVE_V2_DATA_DIR="$NODE_DIR" hive daemon restart --json
calls

step "2. the incident shape: a scratch data dir with no daemon -> nothing to stop, unit untouched"
hive daemon stop --data-dir "$SB/scratch" --json
HIVE_V2_DATA_DIR="$SB/scratch" hive daemon stop
calls

step "3. start/restart/install/uninstall with a scratch data dir -> typed refusal, unit untouched"
for verb in start restart install uninstall; do hive daemon $verb --data-dir "$SB/scratch" --json; done
hive daemon start --data-dir "$SB/scratch"
calls

step "4. inside a Cell (HIVE_CELL=1), even the unit's own data dir is refused"
HIVE_CELL=1 hive daemon stop --json
HIVE_CELL=1 HIVE_V2_DATA_DIR="$NODE_DIR" hive daemon restart
HIVE_CELL=1 hive daemon status --data-dir "$NODE_DIR" --json
calls

step "5. a foreign socket with the unit's data dir -> treated as a scratch target (nothing there), unit untouched"
hive daemon stop --socket "$SB/other.sock" --json
calls

step "6. a real scratch daemon: hive daemon stop --data-dir <scratch> stops that daemon by its own pid"
node "$REPO/v2/cli/src/bin.ts" daemon run --data-dir "$SB/scratch" > "$SB/scratch-daemon.log" 2>&1 &
DPID=$!
for i in $(seq 1 300); do [ -f "$SB/scratch/hived.endpoint.json" ] && break; sleep 0.1; done
echo "scratch daemon pid $DPID; endpoint record: $(sed "s#$SB#\$SB#g" "$SB/scratch/hived.endpoint.json" | sed -E 's/"instanceId":"[^"]*"/"instanceId":"…"/; s/"processBirth":"[^"]*"/"processBirth":"…"/; s/"bootId":"[^"]*"/"bootId":"…"/')"
hive daemon status --data-dir "$SB/scratch" --json | cut -c1-160
hive daemon stop --data-dir "$SB/scratch" --json
wait $DPID; echo "scratch daemon exit code: $?"
kill -0 $DPID 2>/dev/null && echo "STILL ALIVE" || echo "scratch daemon pid $DPID is gone"; DPID=
hive daemon stop --data-dir "$SB/scratch"
calls

step "7. the targeted unit path still works after all of the above"
hive daemon stop
calls
