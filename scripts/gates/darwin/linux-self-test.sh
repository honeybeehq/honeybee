#!/bin/sh
set -eu
if [ "${1:-}" != in-namespace ]; then
  LAB_PASSWD_HOME=$(getent passwd "$(id -u)" | cut -d: -f6)
  export LAB_PASSWD_HOME
  exec unshare -rn /bin/sh "$0" in-namespace
fi
ip link set lo up
python3 -B scripts/gates/darwin/guard_test.py
for file in scripts/gates/darwin/*.sh; do bash -n "$file"; done
node --check scripts/gates/darwin/network.mjs
cc -fsyntax-only scripts/gates/darwin/scope.c
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck scripts/gates/darwin/darwin-gate.sh scripts/gates/darwin/gate-run.sh scripts/gates/darwin/workload.sh scripts/gates/darwin/self-test-run.sh
else
  echo 'SKIP shellcheck: executable unavailable'
fi
