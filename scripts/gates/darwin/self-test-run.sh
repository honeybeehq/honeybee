#!/bin/sh
set -eu
[ "$#" = 1 ] || [ "$#" = 2 ] || { echo 'REFUSING: expected source SHA required'; exit 88; }
case "${2:-}" in '') ;; --download-node) SCG_DOWNLOAD_NODE=1; export SCG_DOWNLOAD_NODE;; *) echo 'REFUSING: unknown self-test switch'; exit 88;; esac
exec /bin/sh scripts/gates/darwin/gate-run.sh --execute scripts/gates/darwin/self-test-body.sh "$1"
