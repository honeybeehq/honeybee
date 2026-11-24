#!/usr/bin/env bash
. "$(dirname "$0")/lib.sh"
say "old (mtime > 10 d) top-level /tmp directories by name prefix: count, empty count"
find /tmp -mindepth 1 -maxdepth 1 -type d -mtime +10 -printf '%f %n\n' 2>/dev/null | awk '{p=$1; sub(/[-_.]?[A-Za-z0-9]{6,}$/,"",p); sub(/-[0-9a-f]{8,}.*$/,"",p); if(p=="")p="(random)"; n[p]++; if($2==2)e[p]++} END{for(k in n) printf "%6d %6d %s\n",n[k],e[k],k}' | sort -rn | head -14
say "minute of last read for those directories"
find /tmp -mindepth 1 -maxdepth 1 -type d -mtime +10 -printf '%A@\n' 2>/dev/null | while read -r a; do date -d "@${a%.*}" '+%m-%d %H:%M'; done | sort | uniq -c | sort -rn | head -4
say "total inodes in shared /tmp vs in old empty top-level directories"
df -i /tmp | tail -1
