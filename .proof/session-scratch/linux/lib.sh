# Sourced by every Linux experiment: a lab folder we create and remove; HOME and TMPDIR pinned inside it.
set -u
LAB_PARENT="${LAB_PARENT:-$HOME/.cache/hb-session-scratch-lab}"
mkdir -p "$LAB_PARENT"
LAB="$(mktemp -d "$LAB_PARENT/run.XXXXXX")"
REAL_HOME="$HOME"
export HOME="$LAB/home" TMPDIR="$LAB/tmp"
mkdir -p "$HOME" "$TMPDIR"
cleanup() { cd /; chmod -R u+rwx "$LAB" 2>/dev/null; rm -rf "$LAB"; rmdir "$LAB_PARENT" 2>/dev/null || true; }
trap cleanup EXIT
say() { printf '\n== %s\n' "$*"; }
