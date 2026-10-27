#!/bin/sh
set -eu
unset HIVE_REAL_HOME
stamped_keys=$(/usr/bin/env | /usr/bin/cut -d= -f1 | /usr/bin/grep -E '^(HIVE_|APIARY_)' | LC_ALL=C /usr/bin/sort | /usr/bin/paste -sd, -)
[ -z "$stamped_keys" ] || { printf 'REFUSED: stamped controller keys: %s\n' "$stamped_keys" >&2; exit 90; }
[ "$(uname -s)" = Darwin ] || { echo 'REFUSED: Darwin required' >&2; exit 90; }
case "$(hostname -s)" in *mini07*|*fangorn*) ;; *) echo 'REFUSED: mini07 required' >&2; exit 90;; esac
[ "$#" = 2 ] || { echo 'usage: hardening-self-test.sh <absolute-node> <passwd-home>' >&2; exit 90; }
case "$1" in /opt/homebrew/bin/node|/usr/local/bin/node|/opt/homebrew/opt/node@24/bin/node) ;; *) echo 'REFUSED: unconfigured Node' >&2; exit 90;; esac
case "$2" in /Users/*) ;; *) echo 'REFUSED: absolute passwd home required' >&2; exit 90;; esac
root=$(/usr/bin/mktemp -d /private/var/tmp/hb-gate.XXXXXXXX)
/bin/chmod 700 "$root"
/bin/mkdir -m 700 "$root/home" "$root/tmp"
exec /usr/bin/env -i PATH=/usr/bin:/bin HOME="$root/home" TMPDIR="$root/tmp" "$1" scripts/gates/darwin/hardening.mjs --self-test "$root" "$2"
