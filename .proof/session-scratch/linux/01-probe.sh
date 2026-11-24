#!/usr/bin/env bash
. "$(dirname "$0")/lib.sh"
say host; hostname; uname -r; . /etc/os-release; echo "$PRETTY_NAME"; id -un; uptime
say tools; for t in bwrap unshare nsenter systemd-run systemctl docker podman setfacl quota xfs_quota node git pnpm tmux fuse-overlayfs; do printf '%s: ' $t; command -v $t || echo MISSING; done; bwrap --version 2>&1
say userns; cat /proc/sys/kernel/unprivileged_userns_clone 2>&1; cat /proc/sys/user/max_user_namespaces 2>&1; cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>&1; unshare -Urm true && echo "unshare -Urm OK"
say "/tmp mount"; findmnt -no SOURCE,FSTYPE,OPTIONS /tmp; df -h /tmp | tail -1; df -i /tmp | tail -1
say "home fs"; findmnt -no SOURCE,FSTYPE,OPTIONS -T "$REAL_HOME"; df -h "$REAL_HOME" | tail -1; df -i "$REAL_HOME" | tail -1
say "dev/shm, run/user"; findmnt -no SOURCE,FSTYPE,OPTIONS /dev/shm; findmnt -no SOURCE,FSTYPE,OPTIONS /run/user/$(id -u) 2>&1
say cgroup; stat -fc %T /sys/fs/cgroup; cat /proc/self/cgroup; systemctl --user is-system-running 2>&1; echo "XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-unset}"; loginctl show-user "$(id -un)" -p Linger 2>&1
say "delegated controllers for user slice"; cat /sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/cgroup.controllers 2>&1
say mem; free -g | head -2
say tmpfiles; systemd-tmpfiles --cat-config 2>/dev/null | grep -nE '^[a-zA-Z!+-]+ +/(var/)?tmp' ; systemctl status systemd-tmpfiles-clean.timer 2>&1 | head -5
