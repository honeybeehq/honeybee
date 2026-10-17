#!/bin/sh
set -eu
[ "$#" = 1 ] || { echo 'REFUSING: expected source SHA'; exit 88; }
case "$1" in *[!0-9a-f]*|'') exit 88;; esac
[ "${#1}" = 40 ] || exit 88
[ "$(uname -s)" = Darwin ] && [ "$(hostname -s)" = trmd-erebor-mini02 ] && [ -n "${FORAGE_JOB:-}" ] || exit 90
case "$PWD" in /Users/*/.cache/fj/*|/Users/*/.forage/work/*) ;; *) exit 90;; esac
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
head=$(git -c http.extraHeader= rev-parse HEAD)
if [ "$head" != "$1" ]; then
  [ "$(git -c http.extraHeader= log -1 --format=%s)" = 'forage snapshot' ] && [ "$(git -c http.extraHeader= rev-parse HEAD^)" = "$1" ] || exit 88
fi
exec /usr/bin/env -i PATH=/usr/bin:/bin HOME=/private/var/tmp/hbfacts TMPDIR=/private/var/tmp/hbfacts LANG=C PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 -B scripts/gates/darwin/syntax_matrix.py "$1"
