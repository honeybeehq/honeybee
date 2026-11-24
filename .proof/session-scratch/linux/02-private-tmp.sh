#!/usr/bin/env bash
# Prototype: a session's literal /tmp is its own scratch folder (private bind mount in its own mount+pid namespace).
. "$(dirname "$0")/lib.sh"
POOL="$LAB/scratch"; mkdir -p "$POOL"
TAG="ssx$$"                       # unique marker for our own processes
session() { # session <beeId> <mode: open|confined> -- cmd...
  local bee="$1" mode="$2"; shift 3
  local s="$POOL/$bee"; mkdir -p "$s/tmp" "$s/vartmp"
  local root=(--dev-bind / /); [ "$mode" = confined ] && root=(--ro-bind / / --dev /dev --bind "$LAB/cell-$bee" "$LAB/cell-$bee")
  [ "$mode" = confined ] && mkdir -p "$LAB/cell-$bee"
  bwrap "${root[@]}" --bind "$s/tmp" /tmp --bind "$s/vartmp" /var/tmp --tmpfs /dev/shm \
    --unshare-pid --proc /proc --die-with-parent \
    --setenv TMPDIR /tmp --setenv HIVE_SCRATCH /tmp --setenv HIVE_BEE_ID "$bee" -- "$@"
}
survivors() { pgrep -fc "sleep 9${TAG#ssx}[0-9]" || true; }

say "A. literal /tmp is captured (open root, like a workstation Cell today)"
session beeA open -- sh -c 'echo hello > /tmp/literal-A.txt; mkdir -p /tmp/clone/node_modules; for i in $(seq 200); do : > /tmp/clone/node_modules/f$i; done; echo x > /var/tmp/v.txt; echo s > /dev/shm/shm.txt; mktemp; node -e "console.log(\"os.tmpdir()=\"+require(\"os\").tmpdir())"; python3 -c "import tempfile;print(\"py gettempdir=\"+tempfile.gettempdir())"; echo "inside sees: $(ls /tmp | tr "\n" " ")"; echo "pid inside: $$"; ps -e --no-headers | wc -l | sed "s/^/processes visible inside: /"'
echo "host /tmp/literal-A.txt exists? $([ -e /tmp/literal-A.txt ] && echo YES-LEAK || echo no)"
echo "host /dev/shm/shm.txt exists? $([ -e /dev/shm/shm.txt ] && echo YES-LEAK || echo no)"
echo "owner-side view: $(cd "$POOL/beeA" && find . -maxdepth 2 | sort | tr '\n' ' ')"
echo "owner-side cost: $(du -sh --inodes "$POOL/beeA" | cut -f1) inodes, $(du -sh "$POOL/beeA" | cut -f1)"
echo "file owner uid on host: $(stat -c %u "$POOL/beeA/tmp/literal-A.txt") (me=$(id -u))"

say "B. two sessions do not see each other's /tmp"
session beeB open -- sh -c 'ls /tmp | wc -l | sed "s/^/beeB sees entries in its \/tmp: /"; echo b > /tmp/only-b'
session beeA open -- sh -c 'echo "beeA again sees: $(ls /tmp | tr "\n" " ")"'

say "C. same under the existing confinement shape (--ro-bind / /)"
session beeC confined -- sh -c 'echo c > /tmp/c.txt && echo "write /tmp ok"; (echo no > /etc/x) 2>&1 | head -1; (echo no > '"$REAL_HOME"'/x-ssx) 2>&1 | head -1'
ls "$POOL/beeC/tmp"

say "D. processes: control WITHOUT a pid namespace (what the code does today: kill the process group)"
setsid sh -c "sleep 9${TAG#ssx}1 & setsid nohup sleep 9${TAG#ssx}2 >/dev/null 2>&1 & (setsid sh -c 'sleep 9${TAG#ssx}3 &' &) ; sleep 9${TAG#ssx}0" &
host=$!; sleep 1; echo "started, alive: $(survivors)"
kill -KILL -- -"$host" 2>/dev/null; sleep 1
echo "after kill(-pgid): survivors=$(survivors)  <- these are the 51"
pgrep -f "sleep 9${TAG#ssx}[0-9]" | xargs -r kill -KILL; sleep 0.3; echo "cleaned: $(survivors)"

say "E. processes: WITH the session pid namespace; kill only the wrapper (as stop does)"
setsid bash -c "$(declare -f session); POOL='$POOL' LAB='$LAB'; session beeE open -- sh -c \"sleep 9${TAG#ssx}1 & setsid nohup sleep 9${TAG#ssx}2 >/dev/null 2>&1 & (setsid sh -c 'sleep 9${TAG#ssx}3 &' &) ; sleep 9${TAG#ssx}0\"" &
host=$!; sleep 1.5; echo "started, alive: $(survivors)"
kill -KILL -- -"$host" 2>/dev/null; sleep 1
echo "after kill(-pgid) of the wrapper: survivors=$(survivors)"
pgrep -f "sleep 9${TAG#ssx}[0-9]" | xargs -r kill -KILL 2>/dev/null

say "F. hard limit: bytes AND inodes on a per-session tmpfs, no root (unshare + nested bwrap)"
unshare -Urm sh -c 'mount -t tmpfs -o size=32m,nr_inodes=1000,mode=1777 scratch /tmp && exec bwrap --dev-bind / / --unshare-user --uid '"$(id -u)"' --gid '"$(id -g)"' --unshare-pid --proc /proc --die-with-parent -- sh -c "
  id -u | sed s/^/uid\ inside:\ /; df -h /tmp | tail -1; df -i /tmp | tail -1
  i=0; while : > /tmp/f\$i 2>/tmp/.err; do i=\$((i+1)); done 2>/dev/null; echo created \$i files then: \$( ( : > /tmp/zz ) 2>&1 )
  rm -f /tmp/f*; dd if=/dev/zero of=/tmp/big bs=1M count=64 2>&1 | grep -iE \"space|copied\" 
"' 2>&1
echo "host /tmp/big exists? $([ -e /tmp/big ] && echo YES-LEAK || echo no)"
