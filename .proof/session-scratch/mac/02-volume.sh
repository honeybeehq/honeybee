#!/bin/bash
# macOS: per-session APFS volume with a quota, default mount point (no admin?). 64 MB, removed at once.
set -u; N="hb-lab-ss-vol-$$"; now() { python3 -c 'import time;print(time.time())'; }
t0=$(now); out=$(diskutil apfs addVolume disk3 APFS "$N" -quota 64m 2>&1 </dev/null); rc=$?; t1=$(now)
echo "$out" | tail -2; echo "exit=$rc"; python3 -c "print('addVolume: %.0f ms' % (($t1-$t0)*1000))"
vdev=$(echo "$out" | sed -n 's/.*Created new APFS Volume \(disk[0-9s]*\).*/\1/p'); [ -z "$vdev" ] && exit 0
mp="/Volumes/$N"; mount | grep "$vdev " | sed 's/(.*//' 
df -h "$mp" | tail -1 | awk '{print "size="$2" used="$3" avail="$4}'
dd if=/dev/zero of="$mp/big" bs=1m count=80 2>&1 | grep -iE "space|quota|bytes"
rm -f "$mp/big"
t2=$(now); diskutil apfs deleteVolume "$vdev" 2>&1 </dev/null | tail -1; t3=$(now)
python3 -c "print('deleteVolume: %.0f ms' % (($t3-$t2)*1000))"
echo "volumes with our lab name left: $(diskutil apfs list disk3 | grep -c "$N")"
