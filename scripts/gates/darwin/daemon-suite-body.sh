L=$GATE_ROOT/logs; mkdir -p "$L"
npm ci --no-audit --no-fund > "$L/ci.log" 2>&1; echo "npm ci exit=$?"; deps_check
npm run build > "$L/build.log" 2>&1; echo "build exit=$?"
gate_lockdown
sum() { cat "$@" | awk '/^ℹ tests/{t+=$3} /^ℹ pass/{p+=$3} /^ℹ fail/{f+=$3} /^ℹ skipped/{k+=$3} END{print "tests="t+0" pass="p+0" fail="f+0" skipped="k+0}'; }
sb node_modules/.bin/tsc -p tsconfig.json --noEmit > "$L/check.log" 2>&1 && sb node_modules/.bin/tsc -p tsconfig.test.json --noEmit >> "$L/check.log" 2>&1; rc=$?; echo "STEP check (seatbelt) exit=$rc"; [ $rc -ne 0 ] && { tail -20 "$L/check.log"; gate_fail check; }
ok=0; for c in core harness adapters driver-hsr daemon cli driver-cell driver-tmux; do sb node_modules/.bin/tsc -p v2/$c/tsconfig.json > "$L/v2check-$c.log" 2>&1 || { ok=1; tail -10 "$L/v2check-$c.log"; }; done; echo "STEP v2:check (seatbelt) exit=$ok"; [ $ok -ne 0 ] && gate_fail v2:check
ALL=$(ls v2/daemon/tests/*.test.ts v2/cli/tests/*.test.ts)
NESTED=$(grep -lE "cell: \{[^}]*sandbox: true" $ALL)
EXCEPTIONS_FILE=scripts/gates/darwin/seatbelt-exceptions.txt
SEATBELT_EXCEPTIONS_FIX=$(sed -n 's/^# fix \([0-9a-f]\{7,40\}\).*/\1/p' "$EXCEPTIONS_FILE" 2>/dev/null | head -1)
EXCEPTED=$(grep -v '^#' "$EXCEPTIONS_FILE" 2>/dev/null | grep . | sort -u)
for f in $EXCEPTED; do printf '%s\n' $ALL | grep -qxF "$f" || { echo "REFUSING: excepted file $f is not in the suite"; exit 98; }; done
TRAPONLY=$(printf '%s\n' $NESTED $EXCEPTED | grep . | sort -u)
OUTER=$(printf '%s\n' $ALL | grep -vxF -f <(printf '%s\n' $TRAPONLY))
echo "daemon suite: $(echo $ALL | wc -w | tr -d ' ') files; $(echo $OUTER | wc -w | tr -d ' ') under Seatbelt+trap; trap-only: nested-Seatbelt [$(echo $NESTED)] + Seatbelt exceptions from $EXCEPTIONS_FILE (fix ${SEATBELT_EXCEPTIONS_FIX:-none}) [$(echo $EXCEPTED)]"
run_each() {
  local mode=$1 tag=$2 f log failed=""; shift 2
  for f in "$@"; do log="$L/$tag-$(echo "$f" | tr '/' '_').log"
    if [ "$mode" = sb ]; then sb node scripts/run-v2-daemon-tests.mjs "$f" > "$log" 2>&1; else node scripts/run-v2-daemon-tests.mjs "$f" > "$log" 2>&1; fi
    [ $? -eq 0 ] || { failed="$failed $f"; echo "  FAIL $f :: $(grep -m1 -E '^✖ ' "$log" | grep -v 'failing tests' | cut -c1-160) $(grep -m1 -oE 'spawn EPERM|Operation not permitted|sandbox_apply[^,]*' "$log")"; }
  done
  echo "STEP v2:daemon $tag exit=$([ -z "$failed" ] && echo 0 || echo 1) files=$# failed=$(echo $failed | wc -w | tr -d ' ') $(sum "$L"/$tag-*.log)"
  [ -z "$failed" ] || gate_fail "v2:daemon $tag:$failed"
}
run_each sb seatbelt $OUTER
run_each plain trap-only $TRAPONLY
true
