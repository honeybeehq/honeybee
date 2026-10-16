L=$GATE_ROOT/logs; mkdir -p "$L"
export REAL_SERVICE_HOME="$SCG_REAL_HOME"
node .proof/honeybee-pinned-runtime/service-sentinel.mjs before "$GATE_ROOT/service-before.json" || { gate_fail sentinel-before; exit 97; }
npm ci --no-audit --no-fund > "$L/ci.log" 2>&1; rc=$?; echo "STEP npm ci exit=$rc"; [ $rc -ne 0 ] && { gate_fail ci; exit 1; }; deps_check
npm run check > "$L/check.log" 2>&1; rc=$?; echo "STEP check exit=$rc"; [ $rc -ne 0 ] && { cat "$L/check.log"; gate_fail check; exit 1; }
npm run v2:check > "$L/v2-check.log" 2>&1; rc=$?; echo "STEP v2:check exit=$rc"; [ $rc -ne 0 ] && { cat "$L/v2-check.log"; gate_fail v2-check; exit 1; }
npm run build > "$L/build.log" 2>&1; rc=$?; echo "STEP build exit=$rc"; [ $rc -ne 0 ] && { tail -20 "$L/build.log"; gate_fail build; exit 1; }
gate_lockdown
sb node --import tsx --test tests/node-runtime.test.ts tests/service-paths.test.ts tests/deploy-cli-exposure.test.ts tests/deploy-restart.test.ts v2/daemon/tests/node-pin-entry.test.ts v2/daemon/tests/service.test.ts > "$L/pinned-tests.log" 2>&1; rc=$?; cat "$L/pinned-tests.log"; [ $rc -ne 0 ] && { gate_fail pinned-tests; exit 1; }
node .proof/honeybee-pinned-runtime/darwin-lab.mjs > "$L/pinned-lab.log" 2>&1; rc=$?; cat "$L/pinned-lab.log"; [ $rc -ne 0 ] && gate_fail pinned-lab
node .proof/honeybee-pinned-runtime/review-lab.mjs > "$L/review-lab.log" 2>&1; rc=$?; cat "$L/review-lab.log"; [ $rc -ne 0 ] && gate_fail review-lab
node .proof/honeybee-pinned-runtime/service-sentinel.mjs after "$GATE_ROOT/service-before.json" || gate_fail sentinel-after
true
