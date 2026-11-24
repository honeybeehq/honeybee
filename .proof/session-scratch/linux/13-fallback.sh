#!/usr/bin/env bash
# When user namespaces are unavailable: what the probe sees. Simulated with the namespace-local limit, not the host sysctl.
. "$(dirname "$0")/lib.sh"
say "host as it is"; bwrap --dev-bind / / --bind "$TMPDIR" /tmp --unshare-pid --proc /proc -- true && echo "probe: capture=mount"
say "inside a namespace whose user-namespace limit is 0 (stands for a host with unprivileged user namespaces off)"
unshare -Ur sh "$(dirname "$0")/13-inner.sh"
say "bwrap installed setuid? (the one case that works without user namespaces)"; stat -c '%A' "$(command -v bwrap)"
