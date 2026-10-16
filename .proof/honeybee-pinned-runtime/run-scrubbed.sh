#!/bin/bash
set -eu
root=$1
shift
case "$root" in "$HOME/.cache/honeybee-pin."*) ;; *) echo 'refusing a non-owned scratch root' >&2; exit 97;; esac
[ -d "$root" ] && [ ! -L "$root" ] || exit 97
mkdir -p "$root/logs" "$root/home/tmp" "$root/home/.config" "$root/home/.cache" "$root/home/.local/share" "$root/home/.local/state"
exec env -i HOME="$root/home" XDG_CONFIG_HOME="$root/home/.config" XDG_CACHE_HOME="$root/home/.cache" XDG_DATA_HOME="$root/home/.local/share" XDG_STATE_HOME="$root/home/.local/state" TMPDIR="$root/home/tmp" PATH="$PATH" LANG=C.UTF-8 XDG_RUNTIME_DIR="/run/user/$(id -u)" LAB_ROOT="$root" REAL_SERVICE_HOME="$HOME" bash -c 'node .proof/honeybee-pinned-runtime/service-sentinel.mjs before "$LAB_ROOT/sentinel.json" || exit 97; "$@"; result=$?; node .proof/honeybee-pinned-runtime/service-sentinel.mjs after "$LAB_ROOT/sentinel.json" || exit 98; exit "$result"' guarded "$@"
