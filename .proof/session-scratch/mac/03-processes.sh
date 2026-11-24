#!/bin/bash
# macOS: what ends a session's processes? process group vs lab launchd job vs census by environment marker.
set -u; : "${HIVE_SCRATCH:?}"; L="$HIVE_SCRATCH/ss-macp.$$"; mkdir -p "$L/home"; trap 'rm -rf "$L"' EXIT
say() { printf '\n== %s\n' "$*"; }
T=$(( $$ % 9000 + 1000 ))
ESC='import os,sys
if os.fork()==0:
    os.setsid()
    if os.fork()==0: os.execvp("sleep",["sleep",sys.argv[1]])
    os._exit(0)'
tree="sleep 7${T}1 & /usr/bin/python3 -c '$ESC' 7${T}2; exec sleep 7${T}0"
alive() { pgrep -f "sleep 7${T}[0-9]" | wc -l | tr -d ' '; }
mine() { pgrep -f "sleep 7${T}[0-9]"; }
say "A. today's rule: kill the process group"
HIVE_BEE_ID="lab-ss-$T" /usr/bin/python3 -c 'import os,sys; os.setsid(); os.execvp("/bin/sh",["/bin/sh","-c",sys.argv[1]])' "$tree" & host=$!
sleep 1; echo "alive: $(alive)"; kill -KILL -- -"$host" 2>/dev/null; sleep 0.5; echo "after kill(-pgid): survivors=$(alive)"
say "B. census by the bee's environment marker finds the escaped one (same user, no root)"
t0=$(python3 -c 'import time;print(time.time())')
found=$(ps -axEww -o pid=,command= | grep "HIVE_BEE_ID=lab-ss-$T" | grep -v grep | awk '{print $1}')
t1=$(python3 -c 'import time;print(time.time())')
echo "found pids: $(echo $found | wc -w | tr -d ' ') (ppid of first: $(ps -o ppid= -p $(echo $found | awk '{print $1}') | tr -d ' ')) in $(python3 -c "print('%.0f ms' % (($t1-$t0)*1000))") over $(ps -ax | wc -l | tr -d ' ') processes"
for p in $found; do kill -KILL "$p"; done; sleep 0.3; echo "after killing the census: survivors=$(alive)"
say "C. the marker is gone if the process cleans its environment"
env -i /usr/bin/python3 -c "$ESC" 7${T}3; sleep 0.3
echo "alive: $(alive); census finds: $(ps -axEww -o pid=,command= | grep "HIVE_BEE_ID=lab-ss-$T" | grep -vc grep)"
for p in $(mine); do kill -KILL "$p"; done
say "D. a lab launchd job per session: does bootout end the escaped process?"
label="lab.hb.session-scratch.$T"; plist="$L/$label.plist"
cat > "$plist" <<P
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$label</string>
<key>EnvironmentVariables</key><dict><key>HOME</key><string>$L/home</string><key>HIVE_BEE_ID</key><string>lab-ss-$T</string></dict>
<key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string><string>$(printf '%s' "$tree" | sed 's/&/\&amp;/g')</string></array>
<key>RunAtLoad</key><true/>
</dict></plist>
P
if launchctl bootstrap "gui/$(id -u)" "$plist" 2>&1; then
  sleep 1.5; echo "alive under the job: $(alive)"
  launchctl bootout "gui/$(id -u)/$label" 2>&1; sleep 1.5
  echo "after bootout: survivors=$(alive)"
fi
for p in $(mine); do kill -KILL "$p"; done; sleep 0.2; echo "cleaned: $(alive)"
launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1 && echo "JOB STILL LOADED" || echo "lab job gone"
