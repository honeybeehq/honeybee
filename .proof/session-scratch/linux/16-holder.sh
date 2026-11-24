#!/usr/bin/env bash
# A holder per session keeps the namespaces (and a cgroup) across runtime generations.
# Runtimes enter with nsenter. What survives a runtime stop, what a person sees, what ends it all.
LAB_PARENT="$(dirname "$HOME")/L"; export LAB_PARENT
. "$(dirname "$0")/lib.sh"
export XDG_RUNTIME_DIR=/run/user/$(id -u)
T=$(( $$ % 9000 + 1000 )); S="$LAB/tmp/bee-1"; RUN="$LAB/run"; mkdir -p "$S/.var-tmp" "$RUN"; echo secret > "$RUN/other-bee.sock"
SLICE="hive-lab-ss-$T.slice"
alive() { pgrep -fc "sleep 5${T}[0-9]" || true; }
say "A. start the holder: detached, in its own cgroup slice, no --die-with-parent (it must outlive the daemon)"
( setsid systemd-run --user --scope --quiet --slice "$SLICE" --unit "hive-lab-ss-$T-holder" -p TasksMax=40 -- \
    bwrap --dev-bind / / --bind "$S" /tmp --bind "$S/.var-tmp" /var/tmp --size 67108864 --tmpfs /dev/shm --tmpfs "$RUN" \
          --unshare-pid --proc /proc --setenv TMPDIR /tmp --setenv HIVE_SCRATCH /tmp --setenv HIVE_SCRATCH_HOST "$S" -- sleep infinity </dev/null >/dev/null 2>&1 & )
sleep 1
outer=$(pgrep -f "bwrap --dev-bind / / --bind $S /tmp" | head -1); init=$(pgrep -P "$outer" | head -1); inner=$(pgrep -P "$init" | head -1)
echo "holder: bwrap $outer -> namespace init $init -> sleep $inner; parent of bwrap is now pid $(ps -o ppid= -p "$outer" | tr -d ' ') (the starter has exited)"
echo "idle cost: $(ps -o rss= -p "$outer","$init","$inner" | awk '{s+=$1} END{print s}') KiB resident over 3 processes; slice TasksMax via scope"
cg="/sys/fs/cgroup$(systemctl --user show -p ControlGroup --value "$SLICE")"; echo "slice cgroup exists: $([ -d "$cg" ] && echo yes || echo no)"
enter() { systemd-run --user --scope --quiet --slice "$SLICE" -- nsenter -U -m -p --preserve-credentials -t "$inner" -- "$@"; }
say "B. runtime generation 1 enters; it writes files, leaves one background process in its own session and one in its group"
setsid bash -c "$(declare -f enter); SLICE=$SLICE inner=$inner; enter sh -c 'echo \"uid=\$(id -u) pid=\$\$ TMPDIR=\$TMPDIR\"; echo g1 > /tmp/from-gen1; echo shm > /dev/shm/s; ls $RUN | wc -l | sed \"s/^/entries visible in the runner socket folder: /\"; (setsid nohup sleep 5${T}1 >/dev/null 2>&1 &); nohup sleep 5${T}2 >/dev/null 2>&1 & exec sleep 5${T}0'" &
rt=$!; sleep 1.5; echo "alive during generation 1: $(alive)"
echo "note: env set by --setenv belongs to the holder; a runtime that enters gets its env from the runner, as today: TMPDIR must be set by the daemon to /tmp"
kill -TERM -- -"$rt" 2>/dev/null; sleep 0.5; kill -KILL -- -"$rt" 2>/dev/null; sleep 0.5
echo "after the runtime's group is stopped (what driver.stop does): alive=$(alive)  <- the one that left the group, the 'dev server'"
say "C. generation 2 enters the same namespaces"
enter sh -c 'echo "sees gen 1 file: $(cat /tmp/from-gen1); /dev/shm kept: $(cat /dev/shm/s); processes it can see: $(ps -e -o comm= | tr "\n" " ")"'
say "D. what a person sees from outside, without entering"
ns=$(readlink /proc/$inner/ns/pid)
for p in /proc/[0-9]*; do [ "$(readlink $p/ns/pid 2>/dev/null)" = "$ns" ] && ps -o pid=,etimes=,rss=,args= -p ${p#/proc/}; done | awk '{printf "  host pid %s, %ss old, %s KiB: %s %s\n",$1,$2,$3,$4,$5}'
echo "slice: pids.current=$(cat "$cg/pids.current" 2>/dev/null) (limit is per scope here: $(cat "$cg"/*holder*/pids.max 2>/dev/null))"
say "E. the process cap: set it on the slice, then try 60 processes in one runtime"
systemctl --user set-property --runtime "$SLICE" TasksMax=30 2>&1 | head -1; echo "slice pids.max=$(cat "$cg/pids.max")"
timeout 30 systemd-run --user --scope --quiet --slice "$SLICE" -- nsenter -U -m -p --preserve-credentials -t "$inner" -- python3 -c '
import os, time
kids = []
try:
    for i in range(60):
        pid = os.fork()
        if pid == 0:
            time.sleep(5); os._exit(0)
        kids.append(pid)
    print("started all 60: the cap did not hold")
except OSError as e:
    print("started", len(kids), "more processes, then:", e.strerror)
for k in kids: os.kill(k, 9)
'
say "F. the session ends (archive, delete, a person's stop): kill the namespace init"
echo "alive before: $(alive)"; kill -KILL "$init"; sleep 0.7; echo "alive after: $(alive); holder processes left: $(ps -o pid= -p "$outer","$init","$inner" 2>/dev/null | wc -l)"
echo "scratch files are still there: $(ls "$S" | tr '\n' ' ')"
echo 1 > "$cg/cgroup.kill" 2>/dev/null; systemctl --user stop "$SLICE" 2>/dev/null; pgrep -f "sleep 5${T}[0-9]" | xargs -r kill -KILL 2>/dev/null
echo "slice gone: $([ -d "$cg" ] && echo no || echo yes)"
