#!/usr/bin/env bash
# Where package stores and clones land per session, and what a cache both sessions can reach saves.
. "$(dirname "$0")/lib.sh"
UH=$(getent passwd "$(id -un)" | cut -d: -f6); PNPM="$UH/.local/bin/pnpm"; REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
POOL="$LAB/pool"; CACHE="$POOL/cache"; mkdir -p "$CACHE/git"
B=(bwrap --dev-bind / / --unshare-pid --proc /proc --die-with-parent --setenv TMPDIR /tmp --setenv PATH "$PATH:$UH/.local/bin")
proj='mkdir -p /tmp/app && cd /tmp/app && printf "{\"name\":\"app\",\"private\":true,\"dependencies\":{\"typescript\":\"5.6.3\",\"vite\":\"5.4.10\",\"eslint\":\"9.14.0\",\"react\":\"18.3.1\",\"react-dom\":\"18.3.1\"}}" > package.json'
echo "pnpm $($PNPM --version)"
say "A. /tmp is a RAM filesystem of its own (today's shared /tmp, and today's sandbox): where does the store go?"
"${B[@]}" --tmpfs /tmp -- sh -c "$proj && $PNPM install --silent >/dev/null 2>&1; echo \"store: \$($PNPM store path)\"; echo \"session /tmp holds \$(du -s --inodes /tmp | cut -f1) inodes, \$(du -sh /tmp | cut -f1); hard links into a store outside /tmp: 0 (other filesystem)\""
say "B. /tmp is the session's folder on the same filesystem as the home (the design's default)"
for bee in b1 b2; do mkdir -p "$POOL/s/$bee"
  t0=$(date +%s%N); "${B[@]}" --bind "$POOL/s/$bee" /tmp -- sh -c "$proj && $PNPM install --silent >/dev/null 2>&1; echo \"store: \$($PNPM store path)\"" | sed "s|$LAB|<lab>|"; t1=$(date +%s%N)
  f=$(find "$POOL/s/$bee/app/node_modules" -type f | wc -l); h=$(find "$POOL/s/$bee/app/node_modules" -type f -links +1 | wc -l)
  echo "session $bee: $(( (t1-t0)/1000000 )) ms; node_modules files=$f, of which hard links to the shared store=$h; inodes that are the session's own=$(( $(du -s --inodes "$POOL/s/$bee" | cut -f1) - h ))"
done
echo "shared store (in the lab home): $(du -s --inodes "$HOME/.local/share/pnpm" 2>/dev/null | cut -f1) inodes, $(du -sh "$HOME/.local/share/pnpm" 2>/dev/null | cut -f1), paid once"
say "C. git: clone of this repository, plain vs --reference to a mirror the computer keeps"
git -C "$REPO" rev-parse --is-shallow-repository | sed 's/^/source is shallow: /'
git clone -q --mirror "file://$REPO" "$CACHE/git/honeybee.git" 2>&1 | grep -v hint | tail -1; echo "mirror: $(du -sh "$CACHE/git/honeybee.git" | cut -f1)"
for v in plain ref; do mkdir -p "$POOL/s/c-$v"; extra=(); [ $v = ref ] && extra=(--reference "$CACHE/git/honeybee.git")
  t0=$(date +%s%N); "${B[@]}" --bind "$POOL/s/c-$v" /tmp -- git clone -q --no-checkout "${extra[@]}" "file://$REPO" /tmp/r 2>&1 | grep -v hint | tail -1; t1=$(date +%s%N)
  echo "$v clone: $(( (t1-t0)/1000000 )) ms, .git $(du -sh "$POOL/s/c-$v/r/.git" | cut -f1), $(du -s --inodes "$POOL/s/c-$v/r/.git" | cut -f1) inodes"
done
