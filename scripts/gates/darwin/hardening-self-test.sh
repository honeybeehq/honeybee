#!/bin/sh
set -eu
[ "$(uname -s)" = Darwin ] || { echo 'REFUSED: Darwin required' >&2; exit 90; }
case "$(hostname -s)" in *mini07*|*fangorn*) ;; *) echo 'REFUSED: mini07 required' >&2; exit 90;; esac
[ "$#" = 2 ] || { echo 'usage: hardening-self-test.sh <absolute-node> <passwd-home>' >&2; exit 90; }
case "$1" in /opt/homebrew/bin/node|/usr/local/bin/node|/opt/homebrew/opt/node@24/bin/node) ;; *) echo 'REFUSED: unconfigured Node' >&2; exit 90;; esac
case "$2" in /Users/*) ;; *) echo 'REFUSED: absolute passwd home required' >&2; exit 90;; esac
root=$(/usr/bin/mktemp -d /private/var/tmp/hb-gate.XXXXXXXX)
/bin/chmod 700 "$root"
/bin/mkdir -m 700 "$root/home" "$root/tmp"
exec /usr/bin/env -i PATH=/usr/bin:/bin HOME="$root/home" TMPDIR="$root/tmp" "$1" scripts/gates/darwin/hardening.mjs --self-test "$root" "$2"
