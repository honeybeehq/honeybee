#!/bin/bash
set -eu
[ "$(uname -s)" = Darwin ] || { echo "REFUSING: Darwin required"; exit 90; }
[ "$(hostname -s)" = trmd-erebor-mini02 ] || { echo "REFUSING: pinned erebor host required"; exit 90; }
[ -n "${FORAGE_JOB:-}" ] || { echo "REFUSING: forage job required"; exit 90; }
case "$PWD" in /Users/*/.cache/fj/*|/Users/*/.forage/work/*) ;; *) echo "REFUSING: forage lane required"; exit 90;; esac
[ -n "${SCG_SOURCE_SHA:-}" ] || { echo "REFUSING: pinned source required"; exit 88; }
case "$SCG_SOURCE_SHA" in *[!0-9a-f]*) echo 'REFUSING: invalid source SHA'; exit 88;; esac
[ "${#SCG_SOURCE_SHA}" = 40 ] || { echo 'REFUSING: full source SHA required'; exit 88; }
head=$(git rev-parse HEAD)
if [ "$head" != "$SCG_SOURCE_SHA" ]; then
  [ "$(git log -1 --format=%s)" = "forage snapshot" ] && [ "$(git rev-parse HEAD^)" = "$SCG_SOURCE_SHA" ] || { echo "REFUSING: lane source mismatch"; exit 88; }
fi
printf '%s' "$SCG_SCRIPT_HASHES" | /usr/bin/shasum -a 256 -c - >/dev/null || { echo "REFUSING: gate hash mismatch"; exit 88; }
body=${1:-scripts/gates/darwin/daemon-suite-body.sh}
case "$body" in scripts/gates/darwin/daemon-suite-body.sh|scripts/gates/darwin/pinned-runtime-body.sh|scripts/gates/darwin/pinned-full-body.sh|scripts/gates/darwin/self-test-body.sh) ;; *) echo "REFUSING: unpinned body"; exit 88;; esac
python=${SCG_PYTHON_BIN:-/usr/bin/python3}
case "$python" in /usr/bin/python3|/opt/homebrew/bin/python3) ;; *) echo "REFUSING: unconfigured Python"; exit 90;; esac
root=/private/var/tmp/g.$(uuidgen | tr -d - | cut -c1-8)
set -- --root "$root" --source "$SCG_SOURCE_SHA" --node "${SCG_NODE_BIN:-}"
[ "$body" != scripts/gates/darwin/self-test-body.sh ] || set -- "$@" --self-test
[ -z "${SCG_CACHE_SEED:-}" ] || set -- "$@" --seed "$SCG_CACHE_SEED" --seed-sha "${SCG_CACHE_SEED_SHA256:-}"
exec /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME="$root/h" TMPDIR="$root/t" LANG=C PYTHONDONTWRITEBYTECODE=1 "$python" -B scripts/gates/darwin/guard.py "$@" "$body"
