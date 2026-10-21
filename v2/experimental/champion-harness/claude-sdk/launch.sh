#!/bin/sh
set -eu
spike_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cell_root=$(CDPATH= cd -- "$spike_dir/../../../.." && pwd)
audit_dir="$cell_root/.audit/claude-sdk"
private_tmpdir="$audit_dir/tmp"
mkdir -p "$audit_dir/home" "$private_tmpdir"
exec /usr/bin/sandbox-exec -D "AUDIT_DIR=$audit_dir" -D "PRIVATE_TMPDIR=$private_tmpdir" -f "$spike_dir/runtime.sb" /usr/bin/env -i HOME="$audit_dir/home" TMPDIR="$private_tmpdir" PATH=/Users/trmd/.local/share/mise/installs/node/lts/bin:/usr/bin:/bin /Users/trmd/.local/share/mise/installs/node/lts/bin/node "$spike_dir/dist/spike.js" "$audit_dir/sandbox-run-$(date -u +%Y%m%dT%H%M%SZ)"
