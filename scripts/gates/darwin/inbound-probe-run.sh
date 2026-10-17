#!/bin/sh
set -eu
[ "$#" = 2 ] && [ "$2" = --download-node ] || { echo 'REFUSING: expected source SHA and --download-node'; exit 88; }
SCG_DOWNLOAD_NODE=1
export SCG_DOWNLOAD_NODE
exec /bin/sh scripts/gates/darwin/gate-run.sh --execute scripts/gates/darwin/inbound-probe-body.sh "$1"
