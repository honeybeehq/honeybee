#!/usr/bin/env bash
# Remove what an interrupted 16-holder run left: only lab units named hive-lab-ss-* and processes carrying this run's marker.
export XDG_RUNTIME_DIR=/run/user/$(id -u)
echo "lab units before:"; systemctl --user list-units --all --no-legend 'hive-lab-ss-*' 2>/dev/null | awk '{print "  "$1,$3,$4}'
for s in $(systemctl --user list-units --all --no-legend 'hive-lab-ss-*.slice' 2>/dev/null | awk '{print $1}'); do
  cg="/sys/fs/cgroup$(systemctl --user show -p ControlGroup --value "$s")"; [ -d "$cg" ] && echo 1 > "$cg/cgroup.kill"; systemctl --user stop "$s" 2>/dev/null
done
sleep 1
echo "preview of leftover marker processes:"; pgrep -fl 'sleep 55907[0-9]' || echo "  none"
pgrep -f 'sleep 55907[0-9]' | xargs -r kill -KILL
echo "lab units after: $(systemctl --user list-units --all --no-legend 'hive-lab-ss-*' 2>/dev/null | wc -l)"
echo "lab folders left: $(ls -d /home/trmd/.cache/fj/tySLaA/L/run.* 2>/dev/null | wc -l)"
