#!/bin/sh
set -eu
[ "$#" = 1 ] || { echo 'REFUSING: expected source SHA required'; exit 88; }
exec /bin/sh scripts/gates/darwin/gate-run.sh --execute scripts/gates/darwin/self-test-body.sh "$1"
