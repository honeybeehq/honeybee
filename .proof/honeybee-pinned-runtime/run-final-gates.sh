#!/bin/bash
set -eu
[ -n "${LAB_ROOT:-}" ] && [ -n "${REAL_SERVICE_HOME:-}" ] && [ "$HOME" != "$REAL_SERVICE_HOME" ]
case "$HOME" in "$LAB_ROOT"/home) ;; *) exit 97;; esac
exec > >(tee "$LAB_ROOT/logs/exact-gates.log") 2>&1
printf 'SOURCE SHA '; git rev-parse HEAD
[ -z "$(git diff --name-only HEAD)" ] || { echo 'refusing dirty tracked source'; exit 97; }
run() { name=$1; shift; printf 'COMMAND'; printf ' %q' "$@"; printf '\n'; if "$@" > "$LAB_ROOT/logs/exact-$name.log" 2>&1; then printf 'EXIT 0\n'; else result=$?; printf 'EXIT %s\n' "$result"; return "$result"; fi; }
run check npm run check
run v2-check npm run v2:check
run build npm run build
run basic-lab node .proof/honeybee-pinned-runtime/linux-lab.mjs
run lab node .proof/honeybee-pinned-runtime/review-lab.mjs
run legacy npm test -- '--test-skip-pattern=^run --rm cleans up when known driver readiness fails$'
run core npm run v2:test
run driver npm run v2:driver
run driver2 npm run v2:driver2
run harness npm run v2:harness
run daemon npm run v2:daemon
