#!/usr/bin/env bash
# Read-only: when were the old top-level /tmp directories last read, and are the files inside them old on all three clocks?
. "$(dirname "$0")/lib.sh"
now=$(date +%s)
say "atime of top-level dirs whose mtime is older than 10 days, by clock hour of last read"
find /tmp -mindepth 1 -maxdepth 1 -type d -mtime +10 -printf '%A@\n' 2>/dev/null | while read -r a; do date -d "@${a%.*}" '+%m-%d %H:00'; done | sort | uniq -c | sort -k2,3 | tail -12
say "the same for regular files directly in /tmp with mtime older than 10 days"
find /tmp -mindepth 1 -maxdepth 1 -type f -mtime +10 -printf '%A@\n' 2>/dev/null | while read -r a; do date -d "@${a%.*}" '+%m-%d %H:00'; done | sort | uniq -c | tail -5
say "one level down (stat only): in 300 old dirs, children by kind and whether all three clocks are older than 10 d"
find /tmp -mindepth 1 -maxdepth 1 -type d -mtime +10 -user "$(id -un)" 2>/dev/null | head -300 | while read -r d; do find "$d" -mindepth 1 -maxdepth 1 -printf '%y %T@ %A@ %C@\n' 2>/dev/null; done | awk -v now="$now" '{k=$1; n[k]++; if((now-$2)>864000&&(now-$3)>864000&&(now-$4)>864000) old[k]++; if((now-$3)<=864000) af[k]++; if((now-$4)<=864000&&(now-$2)>864000) cf[k]++} END{for(k in n) printf "kind %s: %d children; all three clocks old=%d; atime fresh=%d; ctime fresh but mtime old=%d\n",k,n[k],old[k],af[k],cf[k]}'
say "empty old directories at top level (nothing inside for the cleaner to judge but the directory itself)"
find /tmp -mindepth 1 -maxdepth 1 -type d -mtime +10 -empty 2>/dev/null | wc -l
say "who else walks /tmp: mount options, and timers of this user and the system"
findmnt -no OPTIONS /tmp
systemctl list-timers --all --no-pager 2>/dev/null | awk 'NR==1 || /daily|hourly|tmp|locate|backup|restic|borg|hive|apiary|du/' | cut -c1-150 | head -12
XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user list-timers --all --no-pager 2>/dev/null | cut -c1-150 | head -8
crontab -l 2>/dev/null | grep -vc '^#' | sed 's/^/user crontab lines: /'
