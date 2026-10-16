python3 .proof/honeybee-pinned-runtime/interim-config-watch.py watch "$GATE_ROOT" "$SCG_REAL_HOME" "$$" > "$GATE_ROOT/interim-watch.log" 2>&1 &
SCG_INTERIM_PID=$!
for i in $(seq 1 100); do [ -f "$GATE_ROOT/interim-ready" ] && break; sleep .1; done
[ -f "$GATE_ROOT/interim-ready" ] || { gate_fail interim-watch-start; exit 1; }
. scripts/gates/darwin/pinned-full-body.sh
touch "$GATE_ROOT/interim-stop"
wait "$SCG_INTERIM_PID" || true
cat "$GATE_ROOT/interim-watch.log"
python3 .proof/honeybee-pinned-runtime/interim-config-watch.py coverage "$GATE_ROOT" "$SCG_REAL_HOME" || gate_fail interim-config-attribution
true
