#!/usr/bin/env bash
. "$(dirname "$0")/lib.sh"
S="$LAB/scratch/bee"; mkdir -p "$S/.var-tmp" "$LAB/share/team" "$LAB/cell"; echo hello > "$LAB/share/team/f"
say "1. where harness binaries are on this host (names only)"
found=""
for h in claude codex cursor-agent grok opencode kimi agy muse; do
  b=$(ls -d "$REAL_HOME"/.local/bin/$h "$REAL_HOME"/.npm-global/bin/$h "$REAL_HOME"/.claude/local/$h "$REAL_HOME"/.bun/bin/$h "$REAL_HOME"/.local/share/pnpm/$h "$REAL_HOME"/.local/share/mise/shims/$h "$REAL_HOME"/.nvm/versions/node/*/bin/$h "$REAL_HOME"/.cursor/bin/$h "$REAL_HOME"/.hive/bin/$h /usr/local/bin/$h /usr/bin/$h 2>/dev/null | head -1)
  echo "$h: ${b:-not found}"; [ -n "$b" ] && found="$found $h=$b"
done
wrap()  { bwrap --dev-bind / / --bind "$S" /tmp --bind "$S/.var-tmp" /var/tmp --size 268435456 --tmpfs /dev/shm --unshare-pid --proc /proc --die-with-parent --setenv TMPDIR /tmp "$@"; }
wrapc() { bwrap --ro-bind / / --dev /dev --bind "$LAB" "$LAB" --bind "$S" /tmp --bind "$S/.var-tmp" /var/tmp --size 268435456 --tmpfs /dev/shm --unshare-pid --proc /proc --die-with-parent --setenv TMPDIR /tmp "$@"; }
say "2. each found harness starts inside both shapes (lab HOME, no login; --version only)"
for kv in $found; do h=${kv%%=*}; b=${kv#*=}
  echo "$h open:     $(wrap  -- timeout 30 "$b" --version 2>&1 | tail -1 | cut -c1-80)"
  echo "$h confined: $(wrapc -- timeout 30 "$b" --version 2>&1 | tail -1 | cut -c1-80)"
done
echo "entries the harness left in the session's /tmp: $(ls -A "$S" | grep -v '^.var-tmp$' | tr '\n' ' ')"
say "3. privilege inside a user namespace"
echo "sudo inside:   $(wrap -- sudo -n true 2>&1 | head -1 | cut -c1-140)"
echo "docker inside: $(wrap -- timeout 10 docker version --format 'server {{.Server.Version}}' 2>&1 | tail -1 | cut -c1-120)"
echo "root-owned files look like: $(wrap -- stat -c '%U:%G' /etc/passwd)"
echo "ssh client config: $(wrap -- ssh -G localhost 2>&1 | head -1 | cut -c1-120)"
say "4. add a share to a running session: enter its user+mount namespaces and bind (python, no root)"
bwrap --dev-bind / / --bind "$S" /tmp --unshare-pid --proc /proc -- sh -c 'sleep 4; echo "running session now sees in /tmp/shared: $(ls /tmp/shared 2>&1 | tr "\n" " ")"' & W=$!
sleep 1; inner=$(pgrep -P $W | head -1); mkdir -p "$S/shared"
python3 - "$inner" "$LAB/share/team" /tmp/shared <<'PY' 2>&1 | head -3
import ctypes, os, sys
libc = ctypes.CDLL(None, use_errno=True); pid, src, dst = sys.argv[1:]
for ns, flag in (("user", 0x10000000), ("mnt", 0x00020000)):
    fd = os.open(f"/proc/{pid}/ns/{ns}", os.O_RDONLY)
    if libc.setns(fd, flag) != 0: print("setns", ns, os.strerror(ctypes.get_errno())); sys.exit(1)
if libc.mount(src.encode(), dst.encode(), None, 4096, None) != 0: print("mount:", os.strerror(ctypes.get_errno())); sys.exit(1)
print("bind added from outside by the session's owner")
PY
wait $W
