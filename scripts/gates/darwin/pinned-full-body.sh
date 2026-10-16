export REAL_SERVICE_HOME="$SCG_REAL_HOME"
node .proof/honeybee-pinned-runtime/service-sentinel.mjs before "$GATE_ROOT/full-service-before.json" || { gate_fail sentinel-before; exit 97; }
. scripts/gates/darwin/daemon-suite-body.sh
node .proof/honeybee-pinned-runtime/service-sentinel.mjs after "$GATE_ROOT/full-service-before.json" || gate_fail sentinel-after
true
