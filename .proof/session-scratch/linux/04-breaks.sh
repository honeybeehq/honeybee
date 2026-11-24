#!/usr/bin/env bash
# What breaks when a session's /tmp is private and it has its own pid namespace? Run each thing inside the wrapper.
. "$(dirname "$0")/lib.sh"
RP="$PATH"; for d in "$REAL_HOME/.local/bin" "$REAL_HOME/.npm-global/bin" /usr/local/bin; do case ":$RP:" in *":$d:"*) ;; *) RP="$RP:$d";; esac; done
S="$LAB/scratch/bee"; mkdir -p "$S/.var-tmp" "$LAB/share/team" "$LAB/cell"
wrap() { bwrap --dev-bind / / --bind "$S" /tmp --bind "$S/.var-tmp" /var/tmp --size 268435456 --tmpfs /dev/shm --unshare-pid --proc /proc --die-with-parent --setenv TMPDIR /tmp --setenv HIVE_SCRATCH /tmp --setenv HIVE_SCRATCH_HOST "$S" --setenv PATH "$RP" "$@"; }
wrapc() { bwrap --ro-bind / / --dev /dev --bind "$LAB" "$LAB" --bind "$S" /tmp --bind "$S/.var-tmp" /var/tmp --size 268435456 --tmpfs /dev/shm --unshare-pid --proc /proc --die-with-parent --setenv TMPDIR /tmp --setenv PATH "$RP" "$@"; }
t() { local name="$1"; shift; local out; out=$("$@" 2>&1 | tail -2 | tr '\n' ' ' | cut -c1-170); printf '%-34s %s\n' "$name" "$out"; }

say "1. harness binaries start inside (no login: HOME is the lab folder)"
for h in claude codex cursor-agent agent grok opencode kimi gemini; do
  b=$(PATH="$RP" command -v $h 2>/dev/null) || { printf '%-34s %s\n' "$h" "not installed on this host"; continue; }
  t "$h open"     wrap  -- timeout 20 "$b" --version
  t "$h confined" wrapc -- timeout 20 "$b" --version
done
say "2. terminal and multiplexer"
t "pty (script) open"       wrap  -- script -qec 'echo pty-ok' /dev/null
t "pty (script) confined"   wrapc -- script -qec 'echo pty-ok' /dev/null
t "tmux server inside"      wrap  -- sh -c 'tmux new -d -s lab "sleep 300" && tmux ls && ls -d /tmp/tmux-*'
echo "tmux server after the session ended: $(pgrep -fc 'tmux new -d -s lab' || true) (it lived in the session's pid namespace)"
say "3. ssh"
t "ControlMaster path in /tmp"  wrap -- sh -c 'ssh -G -o ControlPath=/tmp/cm-%C localhost | grep -i controlpath'
if [ -n "${SSH_AUTH_SOCK:-}" ]; then echo "host agent socket: $SSH_AUTH_SOCK"; t "ssh-add -l inside" wrap -- ssh-add -l; else echo "no SSH_AUTH_SOCK in this lane; an agent socket under the shared /tmp needs a passthrough bind (tested in 6)"; fi
say "4. debuggers and profilers"
t "strace own child"         wrap -- sh -c 'command -v strace >/dev/null && strace -f -e trace=none -o /tmp/st.out true && echo strace-ok || echo "strace not installed"'
t "gdb own child"            wrap -- sh -c 'command -v gdb >/dev/null && gdb -q -batch -ex run -ex bt --args /bin/true 2>&1 | tail -1 || echo "gdb not installed"'
t "node --inspect port"      wrap -- sh -c 'node --inspect=127.0.0.1:0 -e "setTimeout(()=>{},300)" 2>&1 | head -1'
wrap -- sleep 5 & W=$!; sleep 0.7; inner=$(pgrep -P $(pgrep -P $W | head -1) 2>/dev/null | head -1)
echo "from outside: the session's process is visible to the person as host pid ${inner:-?}; its /tmp is /proc/<pid>/root/tmp -> $(ls -d /proc/${inner:-0}/root/tmp 2>&1 | head -1)"
wait $W
say "5. nested sandboxes (a harness that sandboxes its own tools) and browsers"
t "bwrap inside the session"     wrap -- bwrap --dev-bind / / --tmpfs /tmp --unshare-pid --proc /proc -- sh -c 'echo nested-ok'
t "unshare -Urm inside"          wrap -- unshare -Urm sh -c 'echo nested-userns-ok'
CH=$(ls -d "$REAL_HOME"/.cache/ms-playwright/chromium-*/chrome-linux*/chrome 2>/dev/null | tail -1); [ -z "$CH" ] && CH=$(command -v chromium || command -v google-chrome || true)
if [ -n "$CH" ]; then t "chromium headless (sandbox on)" wrap -- timeout 40 "$CH" --headless=new --disable-gpu --dump-dom 'data:text/html,<p id=x>chromium-ok</p>'; echo "chromium left in session /tmp: $(ls -A "$S" | grep -ci -E 'chrom|org\.|\.com\.' || true) entries"; else echo "no chromium on this host"; fi
say "6. things that live in the host's shared /tmp, simulated: an outer namespace plays the host, sessions nest inside"
mkdir -p "$LAB/hosttmp/.X11-unix" "$LAB/hosttmp/ssh-AAAA"
cat > "$LAB/inner.sh" <<IN
python3 -c "import socket,sys,time;s=socket.socket(socket.AF_UNIX);s.bind('/tmp/ssh-AAAA/agent.1');s.listen(1);c,_=s.accept();c.send(b'agent-reply');time.sleep(1)" &
sleep 0.5
echo "without passthrough: \$(bwrap --dev-bind / / --bind $S /tmp -- sh -c 'ls /tmp/ssh-AAAA/agent.1 2>&1 | tail -1')"
echo "with    passthrough: \$(bwrap --dev-bind / / --bind $S /tmp --bind /tmp/ssh-AAAA /tmp/ssh-AAAA --ro-bind /tmp/.X11-unix /tmp/.X11-unix -- python3 -c "import socket;s=socket.socket(socket.AF_UNIX);s.connect('/tmp/ssh-AAAA/agent.1');print(s.recv(20).decode()); import os;print('X11 dir visible:',os.path.isdir('/tmp/.X11-unix'))" 2>&1 | tr '\n' ' ')"
wait
IN
bwrap --dev-bind / / --bind "$LAB/hosttmp" /tmp -- sh "$LAB/inner.sh"
say "7. two sessions share a folder on purpose (explicit share), and a parent hands a file to a child"
SA="$LAB/scratch/A"; SB="$LAB/scratch/B"; mkdir -p "$SA" "$SB"
bwrap --dev-bind / / --bind "$SA" /tmp --setenv HIVE_SCRATCH_HOST "$SA" --setenv HIVE_SHARE "$LAB/share/team" -- sh -c 'echo report > /tmp/report.html; echo "A says: my file for you is $HIVE_SCRATCH_HOST/report.html"; echo joined > "$HIVE_SHARE/sock-or-file"'
bwrap --dev-bind / / --bind "$SB" /tmp --setenv HIVE_SHARE "$LAB/share/team" -- sh -c "echo \"B reads A's /tmp/report.html by the literal path: \$(cat /tmp/report.html 2>&1)\"; echo \"B reads it by the host path A gave: \$(cat $SA/report.html)\"; echo \"B sees the share: \$(cat \$HIVE_SHARE/sock-or-file)\""
say "8. add a share to a session that is already running (the daemon enters its namespaces)"
bwrap --dev-bind / / --bind "$SA" /tmp --unshare-pid --proc /proc -- sh -c 'sleep 3; echo "running session now sees: $(ls /tmp/shared 2>&1)"' & W=$!
sleep 1; inner=$(pgrep -P $W | head -1); mkdir -p "$SA/shared"
nsenter -U -m --preserve-credentials -t "$inner" mount --bind "$LAB/share/team" /tmp/shared 2>&1 | head -2 && echo "nsenter bind: done as the same user, no root"
wait $W
say "9. docker"
ls -l /var/run/docker.sock 2>&1 | awk '{print $1,$3,$4,$NF}'; echo "the docker socket is not under /tmp, so the CLI works; 'docker run -v /tmp/x:/x' resolves /tmp on the HOST daemon (not run here: it would write into the shared /tmp as root)"
