#!/bin/bash
# Inside a throwaway privileged container: a pool filesystem with project quotas, set up once as root,
# then used by an ordinary user with no privilege. Nothing here touches the host's mounts.
set -u
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq xfsprogs bubblewrap e2fsprogs >/dev/null 2>&1 || { echo "apt failed"; exit 1; }
useradd -m -u 1001 bee
echo "== ROOT, ONCE: make the pool (300 MB image), default per-project limits 20 MB and 500 inodes"
truncate -s 300M /pool.img && mkfs.xfs -q /pool.img && mkdir /pool
LOOP=$(losetup -f); [ -e "$LOOP" ] || mknod "$LOOP" b 7 "${LOOP#/dev/loop}"
losetup "$LOOP" /pool.img && mount -o prjquota "$LOOP" /pool || { echo "mount failed"; losetup -d "$LOOP" 2>/dev/null; exit 1; }
trap 'umount /pool 2>/dev/null; losetup -d "$LOOP" 2>/dev/null' EXIT
xfs_quota -x -c 'limit -p -d bhard=20m ihard=500' /pool
mkdir /pool/sessions && chown bee /pool/sessions
df -h /pool | tail -1; df -i /pool | tail -1
cat > /as-bee.sh <<'B'
set -u
echo "== UNPRIVILEGED DAEMON (uid $(id -u)): give each session folder its own project id; no root"
for n in 1 2; do mkdir -p /pool/sessions/bee$n; xfs_io -c "chproj 100$n" -c 'chattr +P' /pool/sessions/bee$n 2>&1 | head -1; done
xfs_io -c lsproj /pool/sessions/bee1
echo "== SESSION bee1 (own namespace, /tmp = its folder) hits its limits"
bwrap --dev-bind / / --bind /pool/sessions/bee1 /tmp --unshare-pid --proc /proc -- sh -c '
  echo "df inside: $(df -h /tmp | tail -1 | awk "{print \$2\" total, \"\$4\" free\"}")  inodes: $(df -i /tmp | tail -1 | awk "{print \$2}")"
  dd if=/dev/zero of=/tmp/big bs=1M count=40 2>&1 | grep -iE "space|quota|copied"
  rm -f /tmp/big; i=0; while touch /tmp/f$i 2>/dev/null; do i=$((i+1)); done; echo "files created: $i; then: $(touch /tmp/zz 2>&1)"
  echo "can the session move itself to another project? $(xfs_io -c "chproj 0" /tmp 2>&1 | head -1)"
  rm -f /tmp/f*'
echo "== SESSION bee2 is untouched by bee1 being full"
bwrap --dev-bind / / --bind /pool/sessions/bee2 /tmp -- sh -c 'dd if=/dev/zero of=/tmp/ok bs=1M count=10 2>&1 | grep -iE "space|copied"'
echo "== what the daemon reads without walking any tree (one call per pool)"
xfs_quota -c 'report -p -b -i -N' /pool 2>&1 | head -6
B
su bee -c 'bash /as-bee.sh'
echo "== ROOT view of the same report"
xfs_quota -x -c 'report -p -b -i -N' /pool | grep -E '^#100' 
echo "== per-computer limit: the pool itself is a filesystem; a session with a raised limit cannot pass it"
xfs_quota -x -c 'limit -p bhard=10g ihard=1000000 1002' /pool
su bee -c "dd if=/dev/zero of=/pool/sessions/bee2/huge bs=1M count=400 2>&1 | grep -iE 'space|copied'"
echo "root filesystem of the container still writable: $(touch /root/ok && echo yes)"
umount /pool; losetup -d "$LOOP"; echo "loop devices still attached to the image: $(losetup -a | grep -c pool.img)"
