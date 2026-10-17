#!/bin/sh
set -eu
execute=0
if [ "${1:-}" = --execute ]; then execute=1; shift; fi
body=${1:-scripts/gates/darwin/daemon-suite-body.sh}
case "$body" in scripts/gates/darwin/daemon-suite-body.sh|scripts/gates/darwin/pinned-runtime-body.sh|scripts/gates/darwin/pinned-full-body.sh|scripts/gates/darwin/self-test-body.sh) ;; *) echo "REFUSING: body must be a pinned gate body" >&2; exit 88;; esac
[ -z "$(git --no-optional-locks status --porcelain -- scripts/gates/darwin)" ] || { echo "REFUSING: uncommitted gate source" >&2; exit 88; }
source=${2:-$(git rev-parse HEAD)}
case "$source" in ''|*[!0-9a-f]*) echo 'REFUSING: invalid source SHA' >&2; exit 88;; esac
[ "${#source}" = 40 ] || { echo 'REFUSING: full source SHA required' >&2; exit 88; }
hashes=""
for file in scripts/gates/darwin/*.sh scripts/gates/darwin/*.py scripts/gates/darwin/*.c scripts/gates/darwin/*.mjs scripts/gates/darwin/*.txt; do
  case "$file" in *[!a-zA-Z0-9_./-]*) echo 'REFUSING: invalid gate filename' >&2; exit 88;; esac
  [ -f "$file" ] && [ ! -L "$file" ] || { echo 'REFUSING: gate file missing or redirected' >&2; exit 88; }
  row=$(shasum -a 256 "$file")
  hashes="${hashes}${row}
"
done
if [ "$execute" = 1 ]; then
  SCG_SOURCE_SHA=$source
  SCG_SCRIPT_HASHES=$hashes
  export SCG_SOURCE_SHA SCG_SCRIPT_HASHES
  exec /bin/bash scripts/gates/darwin/darwin-gate.sh "$body"
fi
printf "SCG_SOURCE_SHA='%s'; export SCG_SOURCE_SHA\n" "$source"
printf "SCG_SCRIPT_HASHES='%s'; export SCG_SCRIPT_HASHES\n" "$hashes"
printf "exec /bin/bash scripts/gates/darwin/darwin-gate.sh '%s'\n" "$body"
