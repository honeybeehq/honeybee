#!/bin/bash
# macOS: census by environment marker, corrected ps form.
set -u; T=$(( $$ % 9000 + 1000 ))
ESC='import os,sys
if os.fork()==0:
    os.setsid()
    if os.fork()==0: os.execvp("sleep",["sleep",sys.argv[1]])
    os._exit(0)'
HIVE_BEE_ID="lab-ss-$T" /usr/bin/python3 -c "$ESC" 7${T}2; sleep 0.3
for form in "ps -axEww" "ps axeww -o pid=,command="; do
  t0=$(python3 -c 'import time;print(time.time())'); found=$($form | grep "HIVE_BEE_ID=lab-ss-$T" | grep -v grep | awk '{print $1}'); t1=$(python3 -c 'import time;print(time.time())')
  echo "$form -> found $(echo $found | wc -w | tr -d ' ') pid(s) in $(python3 -c "print('%.0f ms' % (($t1-$t0)*1000))") over $(ps -ax | wc -l | tr -d ' ') processes"
done
p=$(echo $found | awk '{print $1}'); [ -n "$p" ] && { echo "its ppid=$(ps -o ppid= -p "$p" | tr -d ' ') pgid=$(ps -o pgid= -p "$p" | tr -d ' ')"; kill -KILL $found; }
sleep 0.2; echo "survivors: $(pgrep -f "sleep 7${T}[0-9]" | wc -l | tr -d ' ')"; pgrep -f "sleep 7${T}[0-9]" | xargs kill -KILL 2>/dev/null
