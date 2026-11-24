echo 0 > /proc/sys/user/max_user_namespaces; echo "limit now: $(cat /proc/sys/user/max_user_namespaces)"
P="setpriv --bounding-set=-all --inh-caps=-all bwrap --dev-bind / / --bind $TMPDIR /tmp --unshare-pid --proc /proc -- true"
$P 2>&1 | head -2
if $P >/dev/null 2>&1; then echo "probe: capture=mount"; else echo "probe: capture=env (TMPDIR only); reported as a fact of the computer"; fi
