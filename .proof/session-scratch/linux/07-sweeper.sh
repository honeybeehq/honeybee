#!/usr/bin/env bash
# Read-only: what is apiary-tmp-sweep on this host; then reproduce "a reader keeps the cleaner away".
. "$(dirname "$0")/lib.sh"
export XDG_RUNTIME_DIR=/run/user/$(id -u)
say "the unit (ExecStart and schedule only)"
systemctl --user cat apiary-tmp-sweep.timer apiary-tmp-sweep.service 2>/dev/null | grep -E '^(# /|ExecStart|OnCalendar|OnUnitActiveSec|OnBootSec|Description)'
exe=$(systemctl --user show apiary-tmp-sweep.service -p ExecStart --value 2>/dev/null | sed -n 's/.*path=\([^ ;]*\).*/\1/p')
echo "program: $exe"; [ -f "$exe" ] && { wc -l "$exe"; grep -nE 'find |rm |rmdir|mtime|mmin|atime|/tmp|hb-rh|maxdepth|-delete|du ' "$exe" | cut -c1-220 | head -40; }
script=$(systemctl --user show apiary-tmp-sweep.service -p ExecStart --value 2>/dev/null | sed -n 's/.*argv\[\]=\([^;]*\);.*/\1/p'); echo "argv: $script"
for f in $script; do [ -f "$f" ] && [ "$f" != "$exe" ] && { echo "--- $f"; wc -l "$f"; grep -nE 'find |rm |rmdir|mtime|mmin|atime|/tmp|hb-rh|maxdepth|-delete|du |readdir|stat' "$f" | cut -c1-220 | head -40; }; done
say "reproduction: an empty old directory that something lists once before the cleaner runs (rule age 3 s)"
T="$LAB/t"; mkdir -p "$T/listed-empty" "$T/unlisted-empty" "$T/listed-tree" ; echo x > "$T/listed-tree/f"; echo "q $T 1777 - - 3s" > "$LAB/lab.conf"
sleep 4
ls "$T/listed-empty" "$T/listed-tree" >/dev/null       # what an hourly sweeper's scan does
systemd-tmpfiles --clean "$LAB/lab.conf"
echo "left after the cleaner: $(cd "$T" && find . -mindepth 1 | sort | tr '\n' ' ')"
