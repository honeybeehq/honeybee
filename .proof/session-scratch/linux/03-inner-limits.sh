#!/bin/sh
# Runs INSIDE a session whose /tmp is a capped tmpfs. Shows what the session sees at the limit.
echo "uid inside: $(id -u)"; df -h /tmp | tail -1; df -i /tmp | tail -1
i=0; while touch /tmp/f$i 2>/tmp-err.$$; do i=$((i+1)); done 2>/dev/null
echo "created $i files, then touch says: $(touch /tmp/zz 2>&1)"
node -e 'try{require("fs").writeFileSync("/tmp/n","x")}catch(e){console.log("node sees:",e.code,e.message)}'
rm -f /tmp/f*
dd if=/dev/zero of=/tmp/big bs=1M count=64 2>&1 | grep -iE "space|copied"
rm -f /tmp/big
cd /tmp && git init -q repo 2>&1 | tail -1; cd repo 2>/dev/null && { i=0; while [ $i -lt 1200 ]; do echo $i > g$i 2>/dev/null || break; i=$((i+1)); done; echo "git work tree stopped at $i files"; git add -A 2>&1 | tail -1; }
