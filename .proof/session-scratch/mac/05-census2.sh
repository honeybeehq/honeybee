#!/bin/bash
# macOS: is a process's environment readable by the same user? platform binary (/bin/sleep) vs ordinary binary (node).
T=$(( $$ % 9000 + 1000 )); NODE=$(command -v node)
HIVE_BEE_ID="lab-ss-$T" /bin/sleep 7${T}1 & a=$!
HIVE_BEE_ID="lab-ss-$T" "$NODE" -e "setTimeout(()=>{},7${T}2)" & b=$!
HIVE_BEE_ID="lab-ss-$T" /usr/bin/python3 -c "import time;time.sleep(7${T}3)" & c=$!
sleep 0.5
for p in $a $b $c; do echo "pid $p ($(ps -o comm= -p $p | xargs basename)): marker visible via ps=$(ps eww -o command= -p $p | grep -c "HIVE_BEE_ID=lab-ss-$T")"; done
kill -KILL $a $b $c
