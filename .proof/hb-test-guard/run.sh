#!/usr/bin/env bash
set -u
REPO=$(cd "$(dirname "$0")/../.." && pwd)
SB=$(mktemp -d /tmp/hb-guard-XXXXXX)
mkdir -p "$SB/bin" "$SB/units" "$SB/empty-units" "$SB/node/v2" "$SB/scratch" "$SB/empty-home"
cat > "$SB/bin/systemctl" <<'EOF'
#!/bin/sh
echo "systemctl $*" >> "$FAKE_SYSTEMCTL_LOG"
case "$*" in *is-active*) echo active ;; esac
exit 0
EOF
chmod +x "$SB/bin/systemctl"
export FAKE_SYSTEMCTL_LOG="$SB/systemctl.log"
: > "$FAKE_SYSTEMCTL_LOG"
export PATH="$SB/bin:$PATH" HIVE_V2_SERVICE_DIR="$SB/units" HIVE_V2_SERVICE_LABEL=hb.guard.test
export HIVE_NODE_PATH=$(node -p 'require("fs").realpathSync(process.execPath)')
export HIVE_TEST_REAP_RUNTIMES_ON_SHUTDOWN=1
unset HIVE_CELL HIVE_V2_DATA_DIR HIVE_V2_SOCKET_PATH
NODE_DIR="$SB/node/v2"
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
redact() { sed -e "s#$SB#\$SB#g" -e "s#$HOME#\$HOME#g"; }
hive() { node "$REPO/v2/cli/src/bin.ts" "$@" 2>&1 | redact; echo "[exit ${PIPESTATUS[0]}]"; }
step() { echo; echo "### $*"; }
calls() { echo "--- fake systemctl calls so far: $(wc -l < "$FAKE_SYSTEMCTL_LOG")"; redact < "$FAKE_SYSTEMCTL_LOG"; }

echo "sandbox: \$SB=$SB; HOME stays the account home (\$HOME); unit dir \$SB/units, label hb.guard.test, fake unit bound to \$SB/node/v2; PATH shim: $(which systemctl | redact)"
echo "no command in this run names the account's own data dir; every target is under \$SB"

step "1. owned path: the data dir is the unit's own -> the unit is targeted (stop, start, restart; flag and env forms)"
hive daemon stop --data-dir "$NODE_DIR" --json
hive daemon start --data-dir "$NODE_DIR" --json
HIVE_V2_DATA_DIR="$NODE_DIR" hive daemon restart --json
calls

step "2. the incident shape: a scratch data dir with no daemon -> nothing to stop, unit untouched"
hive daemon stop --data-dir "$SB/scratch" --json
HIVE_V2_DATA_DIR="$SB/scratch" hive daemon stop
calls

step "3. start/restart/install/uninstall with a scratch data dir -> typed refusal, unit untouched"
for verb in start restart install uninstall; do hive daemon $verb --data-dir "$SB/scratch" --json | cut -c1-200; done
hive daemon start --data-dir "$SB/scratch"
calls

step "4. inside a Cell (HIVE_CELL=1), even the unit's own data dir is refused; status does not consult the service"
HIVE_CELL=1 hive daemon stop --data-dir "$NODE_DIR" --json | cut -c1-200
HIVE_CELL=1 HIVE_V2_DATA_DIR="$NODE_DIR" hive daemon restart
HIVE_CELL=1 hive daemon status --data-dir "$NODE_DIR"
calls

step "5. a foreign socket with the unit's data dir -> treated as a scratch target (nothing there), unit untouched"
hive daemon stop --data-dir "$NODE_DIR" --socket "$SB/other.sock" --json | cut -c1-200
hive daemon start --data-dir "$NODE_DIR" --socket "$SB/other.sock"
calls

step "6. a real scratch daemon: hive daemon stop --data-dir <scratch> stops that daemon by its own pid"
HOME="$SB" node "$REPO/v2/cli/src/bin.ts" daemon run --data-dir "$SB/scratch" > "$SB/scratch-daemon.log" 2>&1 &
DPID=$!
for i in $(seq 1 300); do [ -f "$SB/scratch/hived.endpoint.json" ] && break; sleep 0.1; done
echo "scratch daemon pid $DPID; endpoint record: $(redact < "$SB/scratch/hived.endpoint.json" | sed -E 's/"instanceId":"[^"]*"/"instanceId":"…"/; s/"processBirth":"[^"]*"/"processBirth":"…"/; s/"bootId":"[^"]*"/"bootId":"…"/')"
hive daemon status --data-dir "$SB/scratch" --json | cut -c1-120
hive daemon stop --data-dir "$SB/scratch" --json
wait $DPID; echo "scratch daemon exit code: $?"
kill -0 $DPID 2>/dev/null && echo "STILL ALIVE" || echo "scratch daemon pid $DPID is gone"; DPID=
hive daemon stop --data-dir "$SB/scratch"
calls

step "7. a redirected HOME with no unit anywhere (HOME=\$SB/empty-home, service dir from that HOME): every service verb refuses"
(unset HIVE_V2_SERVICE_DIR; HOME="$SB/empty-home" hive daemon stop)
(unset HIVE_V2_SERVICE_DIR; HOME="$SB/empty-home" hive daemon start --json | cut -c1-200)
(unset HIVE_V2_SERVICE_DIR; HOME="$SB/empty-home" hive daemon install --data-dir "$SB/empty-home/custom")
(unset HIVE_V2_SERVICE_DIR; HOME="$SB/empty-home" hive daemon status)
calls

step "8. no unit installed, account HOME: stop/start/restart/uninstall refuse (service_not_installed); only install may create the first unit"
HIVE_V2_SERVICE_DIR="$SB/empty-units" hive daemon stop --data-dir "$NODE_DIR" --json | cut -c1-200
HIVE_V2_SERVICE_DIR="$SB/empty-units" hive daemon restart --data-dir "$NODE_DIR"
HIVE_V2_SERVICE_DIR="$SB/empty-units" hive daemon uninstall --data-dir "$NODE_DIR"
HIVE_V2_SERVICE_DIR="$SB/empty-units" hive daemon install --data-dir "$NODE_DIR"
echo "unit written: $(ls "$SB/empty-units")"
calls

step "9. a sandbox unit dir without a label override (HIVE_V2_SERVICE_LABEL unset) would drive the node's own label -> refused, unit untouched"
mkdir -p "$SB/unlabelled-units"
sed 's/hb.guard.test/dev.honeybee.hive.v2/' "$SB/units/hb.guard.test.service" > "$SB/unlabelled-units/dev.honeybee.hive.v2.service"
(unset HIVE_V2_SERVICE_LABEL; HIVE_V2_SERVICE_DIR="$SB/unlabelled-units" hive daemon stop --data-dir "$NODE_DIR" --json | cut -c1-200)
(unset HIVE_V2_SERVICE_LABEL; HIVE_V2_SERVICE_DIR="$SB/unlabelled-units" hive daemon restart --data-dir "$NODE_DIR")
(unset HIVE_V2_SERVICE_LABEL; HIVE_V2_SERVICE_DIR="$SB/unlabelled-units" hive daemon status --data-dir "$NODE_DIR")
calls

step "10. the owned path still works after all of the above"
hive daemon stop --data-dir "$NODE_DIR"
calls
