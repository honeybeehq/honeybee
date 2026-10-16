L=$GATE_ROOT/logs; mkdir -p "$L"
npm ci --no-audit --no-fund > "$L/ci.log" 2>&1; rc=$?; echo "STEP npm ci exit=$rc"; [ $rc -ne 0 ] && { gate_fail ci; exit 1; }; deps_check
npm run build > "$L/build.log" 2>&1; rc=$?; echo "STEP build exit=$rc"; [ $rc -ne 0 ] && { tail -20 "$L/build.log"; gate_fail build; exit 1; }
gate_lockdown
sb node --import tsx --test tests/node-runtime.test.ts tests/deploy-cli-exposure.test.ts tests/deploy-restart.test.ts > "$L/pinned-tests.log" 2>&1; rc=$?; cat "$L/pinned-tests.log"; [ $rc -ne 0 ] && gate_fail pinned-tests
node .proof/honeybee-pinned-runtime/darwin-lab.mjs > "$L/pinned-lab.log" 2>&1; rc=$?; cat "$L/pinned-lab.log"; [ $rc -ne 0 ] && gate_fail pinned-lab
true
