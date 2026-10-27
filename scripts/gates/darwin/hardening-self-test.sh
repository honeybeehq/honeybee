#!/bin/sh
set -eu
unset HIVE_REAL_HOME
stamped_keys=$(/usr/bin/env | /usr/bin/cut -d= -f1 | /usr/bin/grep -E '^(HIVE_|APIARY_)' | LC_ALL=C /usr/bin/sort | /usr/bin/paste -sd, -)
[ -z "$stamped_keys" ] || { printf 'REFUSED: stamped controller keys: %s\n' "$stamped_keys" >&2; exit 90; }
[ "$(/usr/bin/uname -s)" = Darwin ] || { echo 'REFUSED: Darwin required' >&2; exit 90; }
case "$(/bin/hostname -s)" in
  trmd-fangorn-mini07) ;;
  trmd-hobbiton-mini04)
    utc=$(/bin/date -u +%H%M) || { echo 'REFUSED: UTC clock failed' >&2; exit 90; }
    case "$utc" in 0[0-9][0-5][0-9]|1[0-9][0-5][0-9]|2[0-3][0-5][0-9]) ;; *) echo 'REFUSED: invalid UTC time' >&2; exit 90;; esac
    case "$utc" in 03??|040?|041?|042?|043?|0440) echo 'REFUSED: mini04 quiet window' >&2; exit 90;; esac ;;
  *) echo 'REFUSED: approved Mac lab required' >&2; exit 90;;
esac
[ "$#" = 2 ] || { echo 'usage: hardening-self-test.sh <absolute-node> <passwd-home>' >&2; exit 90; }
case "$1" in /opt/homebrew/bin/node|/usr/local/bin/node|/opt/homebrew/opt/node@24/bin/node) ;; *) echo 'REFUSED: unconfigured Node' >&2; exit 90;; esac
case "$2" in /Users/*) ;; *) echo 'REFUSED: absolute passwd home required' >&2; exit 90;; esac
script_dir=$(/usr/bin/dirname "$0")
/usr/bin/env -i PATH=/usr/bin:/bin HOME=/private/var/tmp "$1" -e 'const p=require("node:path"),o=require("node:os");const h=o.userInfo().homedir.toLowerCase();for(const x of [process.cwd(),p.resolve(process.argv[1]),p.resolve(process.argv[2])]){const q=x.toLowerCase();if(q===h||q.startsWith(h+"/"))throw Error("REFUSED: checkout or script under real home")}if(process.argv[3]!==o.userInfo().homedir)throw Error("REFUSED: passwd home mismatch")' "$script_dir" "$PWD" "$2"
root=$(/usr/bin/mktemp -d /private/var/tmp/hb-gate.XXXXXXXX)
/bin/chmod 700 "$root"
/bin/mkdir -m 700 "$root/home" "$root/tmp"
exec /usr/bin/env -i PATH=/usr/bin:/bin HOME="$root/home" TMPDIR="$root/tmp" "$1" "$script_dir/hardening.mjs" --self-test "$root" "$2"
