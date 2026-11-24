#!/usr/bin/env bash
# Syntax check of the Appendix B2 process snapshot, inside a pid namespace so it sees only lab processes.
. "$(dirname "$0")/lib.sh"
sed 's/f\[3\] > 600/f[3] > 2/' "$(dirname "$0")/15-b2-inner.sh" > "$LAB/b2.sh"
bwrap --dev-bind / / --unshare-pid --proc /proc --die-with-parent -- sh -c "
  HIVE_BEE_ID=lab-a sh -c 'setsid sleep 30 & sleep 30' &
  HIVE_BEE_ID=lab-b sleep 30 &
  sleep 4; sh $LAB/b2.sh"
