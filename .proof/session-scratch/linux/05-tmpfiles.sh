#!/usr/bin/env bash
# Why did a 10-day systemd-tmpfiles rule spare old trees? (1) read-only look at this host; (2) reproduction in a lab folder with a 3 s age.
. "$(dirname "$0")/lib.sh"
say "1a. the cleaner's last runs (read-only)"
systemctl show systemd-tmpfiles-clean.service -p ExecMainStartTimestamp -p ExecMainExitTimestamp -p ExecMainStatus -p Result 2>&1
journalctl -u systemd-tmpfiles-clean.service -n 6 --no-pager 2>&1 | tail -6
systemctl cat systemd-tmpfiles-clean.service 2>/dev/null | grep -E '^(ExecStart|IOSchedulingClass|Type)'
systemd-tmpfiles --version | head -1
say "1b. shared /tmp: top-level entries by age of mtime (counts only; names not printed)"
now=$(date +%s)
find /tmp -mindepth 1 -maxdepth 1 -printf '%T@ %A@ %C@ %u %y\n' 2>/dev/null | awk -v now="$now" '{m=(now-$1)/86400;a=(now-$2)/86400;c=(now-$3)/86400; n++; if(m>10)mo++; if(m>10&&a>10&&c>10)allold++; if(m>10&&a<=10)afresh++; if($4!="trmd")other++; t[$5]++} END{printf "entries=%d  mtime>10d=%d  all three times>10d=%d  mtime>10d but atime fresh=%d  owned by another user=%d\n",n,mo,allold,afresh,other; for(k in t)printf "  type %s: %d\n",k,t[k]}'
say "1c. ten oldest directories: their own a/m/c age in days, and whether any process has its cwd or an open file below"
find /tmp -mindepth 1 -maxdepth 1 -type d -user "$(id -un)" -printf '%T@ %p\n' 2>/dev/null | sort -n | head -10 | while read -r _ p; do
  a=$(( (now-$(stat -c %X "$p"))/86400 )); m=$(( (now-$(stat -c %Y "$p"))/86400 )); c=$(( (now-$(stat -c %Z "$p"))/86400 ))
  inuse=$(ls -l /proc/[0-9]*/cwd 2>/dev/null | grep -c -- "-> $p" || true)
  echo "dir#$(echo "$p" | md5sum | cut -c1-6) age days: atime=$a mtime=$m ctime=$c  procs with cwd below=$inuse  entries inside=$(ls -A "$p" 2>/dev/null | head -1000 | wc -l)"
done
say "2. reproduction: rule 'q <lab>/t 1777 - - 3s' (the same line type as /tmp's, age 3 s instead of 10 d)"
T="$LAB/t"; mkdir -p "$T"; conf="$LAB/lab.conf"; echo "q $T 1777 - - 3s" > "$conf"
mkdir -p "$T/plain-tree/sub" "$T/cwd-tree/sub" "$T/read-tree" "$T/written-tree/sub" "$T/locked-tree" "$T/open-file-tree" "$T/sock-tree" "$T/ro-tree/sub"
for d in plain-tree/sub cwd-tree/sub read-tree written-tree/sub locked-tree open-file-tree ro-tree/sub; do for i in 1 2 3; do echo x > "$T/$d/f$i"; done; done
python3 -c "import socket,sys;s=socket.socket(socket.AF_UNIX);s.bind(sys.argv[1])" "$T/sock-tree/dead.sock"
python3 -c "import socket,sys,time;s=socket.socket(socket.AF_UNIX);s.bind(sys.argv[1]);s.listen(1);time.sleep(30)" "$T/sock-tree/live.sock" & P1=$!
( cd "$T/cwd-tree/sub" && exec sleep 30 ) & P2=$!
( exec 9<"$T/open-file-tree/f1"; sleep 30 ) & P3=$!
flock "$T/locked-tree" sleep 30 & P4=$!
chmod a-w "$T/ro-tree/sub" "$T/ro-tree"
( for i in 1 2 3 4 5 6 7 8; do cat "$T/read-tree/f1" >/dev/null; echo y >> "$T/written-tree/sub/f1"; sleep 1; done ) & P5=$!
sleep 5
echo "before: $(find "$T" -mindepth 1 | wc -l) entries"
systemd-tmpfiles --clean "$conf" 2>&1 | head -5
for d in plain-tree cwd-tree read-tree written-tree locked-tree open-file-tree sock-tree ro-tree; do
  printf '%-16s left: %s\n' "$d" "$( [ -e "$T/$d" ] && (cd "$T/$d" && find . -mindepth 1 | sort | tr '\n' ' ') || echo '(whole tree removed)')"
done
kill $P1 $P2 $P3 $P4 $P5 2>/dev/null; wait 2>/dev/null
sleep 4; systemd-tmpfiles --clean "$conf" 2>&1 | head -3
echo "second pass, 4 s after the holders exited: $(find "$T" -mindepth 1 2>/dev/null | wc -l) entries left: $(cd "$T" && find . -mindepth 1 | sort | tr '\n' ' ')"
