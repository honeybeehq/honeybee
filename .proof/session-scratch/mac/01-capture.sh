#!/bin/bash
# macOS: what can capture a literal /tmp path? Light; everything lives under $HIVE_SCRATCH and is removed.
set -u
: "${HIVE_SCRATCH:?}"; L="$HIVE_SCRATCH/ss-mac.$$"; mkdir -p "$L/scratch"; trap 'rm -rf "$L"' EXIT
say() { printf '\n== %s\n' "$*"; }
N="hb-lab-ss-probe-$$"            # the only name we ever try in the shared folder; removed below if it appears
say "host"; sw_vers | tr '\n' ' '; echo; csrutil status 2>&1 | head -1
say "1. Seatbelt can refuse a literal /tmp write; it cannot redirect it"
sandbox-exec -p '(version 1)(allow default)(deny file-write* (subpath "/private/tmp"))' /bin/sh -c "echo x > /tmp/$N" 2>&1 | sed 's/^/sh says: /'
sandbox-exec -p '(version 1)(allow default)(deny file-write* (subpath "/private/tmp"))' /usr/bin/python3 -c "
import tempfile,os
try: open('/tmp/$N','w')
except Exception as e: print('python says:',e)
print('python tempfile.gettempdir() with TMPDIR set ->', tempfile.gettempdir())" 2>&1
echo "created in shared folder? $([ -e /tmp/$N ] && echo yes || echo no)"; rm -f "/tmp/$N"
say "2. DYLD_INSERT_LIBRARIES path rewrite: works for unprotected binaries only"
cat > "$L/shim.c" <<'C'
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static const char *fix(const char *p, char *buf) {
  const char *s = getenv("HIVE_SCRATCH_CAPTURE");
  if (!s || !p) return p;
  if (!strncmp(p, "/tmp/", 5)) { snprintf(buf, 1024, "%s/%s", s, p + 5); return buf; }
  if (!strncmp(p, "/private/tmp/", 13)) { snprintf(buf, 1024, "%s/%s", s, p + 13); return buf; }
  return p;
}
int my_open(const char *p, int f, ...) { char b[1024]; va_list a; va_start(a, f); int m = va_arg(a, int); va_end(a); return open(fix(p, b), f, m); }
__attribute__((used)) static struct { const void *r, *o; } ip[] __attribute__((section("__DATA,__interpose"))) = { { my_open, open } };
C
if cc -dynamiclib -o "$L/shim.dylib" "$L/shim.c" 2>"$L/cc.err"; then
  NODE=$(command -v node); export HIVE_SCRATCH_CAPTURE="$L/scratch"
  DYLD_INSERT_LIBRARIES="$L/shim.dylib" "$NODE" -e "require('fs').writeFileSync('/tmp/$N-node','x')" 2>&1 | head -2
  echo "node ($NODE): captured=$([ -e "$L/scratch/$N-node" ] && echo yes || echo no) leaked=$([ -e /tmp/$N-node ] && echo yes || echo no)"
  DYLD_INSERT_LIBRARIES="$L/shim.dylib" /bin/sh -c "echo x > /tmp/$N-sh" 2>&1 | head -2
  echo "/bin/sh (SIP-protected, what every harness shell tool runs): captured=$([ -e "$L/scratch/$N-sh" ] && echo yes || echo no) leaked=$([ -e /tmp/$N-sh ] && echo yes || echo no)"
  DYLD_INSERT_LIBRARIES="$L/shim.dylib" "$NODE" -e "require('child_process').execSync('touch /tmp/$N-child')" 2>&1 | head -2
  echo "node -> sh -> touch: captured=$([ -e "$L/scratch/$N-child" ] && echo yes || echo no) leaked=$([ -e /tmp/$N-child ] && echo yes || echo no)"
  rm -f "/tmp/$N-node" "/tmp/$N-sh" "/tmp/$N-child"; unset HIVE_SCRATCH_CAPTURE
else echo "no compiler: $(head -1 "$L/cc.err")"; fi
say "3. per-session sparse disk image with a hard size (64 MB), no admin"
t0=$(python3 -c 'import time;print(time.time())')
hdiutil create -quiet -size 64m -type SPARSE -fs APFS -volname hb-lab-ss "$L/s.sparseimage" && \
dev=$(hdiutil attach -nobrowse -noautofsck -mountpoint "$L/mnt" "$L/s.sparseimage" | awk 'NR==1{print $1}')
t1=$(python3 -c 'import time;print(time.time())')
python3 -c "print('create+attach: %.0f ms' % (($t1-$t0)*1000))"
if [ -d "$L/mnt" ] && mount | grep -q "$L/mnt"; then
  df -h "$L/mnt" | tail -1; df -i "$L/mnt" | tail -1 | awk '{print "inodes: used="$6" free="$7}'
  dd if=/dev/zero of="$L/mnt/big" bs=1m count=80 2>&1 | grep -iE "space|bytes"
  rm -f "$L/mnt/big"; i=0; while [ $i -lt 3000 ] && : > "$L/mnt/f$i"; do i=$((i+1)); done 2>/dev/null; echo "empty files created before any error: $i (APFS has no fixed inode table)"
  echo "backing file on the real disk: $(du -sh "$L/s.sparseimage" | cut -f1) for a 64 MB cap"
  t2=$(python3 -c 'import time;print(time.time())'); hdiutil detach -quiet "$dev"; t3=$(python3 -c 'import time;print(time.time())')
  python3 -c "print('detach: %.0f ms' % (($t3-$t2)*1000))"
fi
say "4. per-session APFS volume with a quota in the boot container"
cont=$(diskutil info / | awk -F: '/APFS Container/{gsub(/ /,"",$2);print $2}'); echo "container: $cont"
t0=$(python3 -c 'import time;print(time.time())')
out=$(diskutil apfs addVolume "$cont" APFS "$N" -quota 64m -mountpoint "$L/vol" 2>&1 </dev/null); rc=$?
t1=$(python3 -c 'import time;print(time.time())')
echo "$out" | tail -3; echo "exit=$rc"; python3 -c "print('addVolume: %.0f ms' % (($t1-$t0)*1000))"
vdev=$(echo "$out" | sed -n 's/.*Created new APFS Volume \(disk[0-9s]*\).*/\1/p')
if [ -n "$vdev" ]; then
  df -h "$L/vol" | tail -1
  dd if=/dev/zero of="$L/vol/big" bs=1m count=80 2>&1 | grep -iE "space|quota|bytes"
  t2=$(python3 -c 'import time;print(time.time())'); diskutil apfs deleteVolume "$vdev" 2>&1 </dev/null | tail -1; t3=$(python3 -c 'import time;print(time.time())')
  python3 -c "print('deleteVolume: %.0f ms' % (($t3-$t2)*1000))"
  diskutil apfs list "$cont" | grep -c "$N" | sed 's/^/volumes with our lab name left: /'
fi
