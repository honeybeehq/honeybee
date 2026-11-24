#!/usr/bin/env bash
. "$(dirname "$0")/lib.sh"
HERE="$(cd "$(dirname "$0")" && pwd)"
say "F. hard limit: bytes AND inodes on a per-session tmpfs, no root (unshare, then nested bwrap restores the uid)"
unshare -Urm sh -c 'mount -t tmpfs -o size=32m,nr_inodes=1000,mode=1777 scratch /tmp && exec bwrap --dev-bind / / --unshare-user --uid '"$(id -u)"' --gid '"$(id -g)"' --unshare-pid --proc /proc --die-with-parent -- sh '"$HERE"'/03-inner-limits.sh' 2>&1
echo "host /tmp/big exists? $([ -e /tmp/big ] && echo YES-LEAK || echo no)"
say "G. bwrap --size alone (bytes only; bwrap has no nr_inodes flag)"
bwrap --dev-bind / / --size 33554432 --tmpfs /tmp -- sh -c 'df -h /tmp | tail -1; df -i /tmp | tail -1'
say "H. cost of the wrapper per spawn (50 runs each)"
t0=$(date +%s%N); for i in $(seq 50); do /bin/true; done; t1=$(date +%s%N)
mkdir -p "$LAB/s/tmp"
for i in $(seq 50); do bwrap --dev-bind / / --bind "$LAB/s/tmp" /tmp --tmpfs /dev/shm --unshare-pid --proc /proc --die-with-parent -- /bin/true; done; t2=$(date +%s%N)
echo "plain: $(( (t1-t0)/50000 )) us/spawn   wrapped: $(( (t2-t1)/50000 )) us/spawn"
say "I. cgroup scope as the second fence (systemd-run --user --scope), with the real runtime dir"
export XDG_RUNTIME_DIR=/run/user/$(id -u)
TAG=$$
if systemd-run --user --scope --quiet --unit "hb-lab-ss-$TAG" -p TasksMax=64 -p MemoryMax=512M -- sh -c "setsid nohup sleep 8${TAG}1 >/dev/null 2>&1 & (setsid sh -c 'sleep 8${TAG}2 &' &); sleep 0.5; cat /proc/self/cgroup" ; then
  cg=/sys/fs/cgroup$(systemctl --user show -p ControlGroup --value "hb-lab-ss-$TAG.scope")
  echo "scope cgroup: $cg"; echo "procs left in scope after the main process exited: $(cat "$cg/cgroup.procs" 2>/dev/null | wc -l)"
  echo "pids.max=$(cat "$cg/pids.max" 2>&1) memory.max=$(cat "$cg/memory.max" 2>&1)"
  echo 1 > "$cg/cgroup.kill" 2>&1 && echo "wrote cgroup.kill"; sleep 0.5
  echo "survivors: $(pgrep -fc "sleep 8${TAG}[0-9]" || true)"
  systemctl --user stop "hb-lab-ss-$TAG.scope" 2>/dev/null
else echo "systemd-run --user --scope not available here"; fi
pgrep -f "sleep 8${TAG}[0-9]" | xargs -r kill -KILL 2>/dev/null
