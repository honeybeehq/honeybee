#!/usr/bin/env bash
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
HERE=$REPO/.proof/deploy-d1
W=$REPO/.cache/d1
BASE_REV=${BASE_REV:-6000b313}
clean() { local a=(); for v in $(env | grep -o '^HIVE_[A-Za-z0-9_]*'); do a+=(-u "$v"); done; env "${a[@]}" -u CLAUDE_CONFIG_DIR -u CODEX_HOME TMPDIR=/tmp "$@"; }
mkdir -p "$W"
for name in base n1 contract; do
  git -C "$REPO" worktree remove --force "$W/$name" 2>/dev/null || rm -rf "$W/$name"
done
git -C "$REPO" worktree prune
git -C "$REPO" worktree add -q --detach "$W/base" "$BASE_REV"
git -C "$REPO" worktree add -q --detach "$W/n1" HEAD
git -C "$REPO" worktree add -q --detach "$W/contract" HEAD
git -C "$W/n1" apply "$HERE/expand.patch"
git -C "$W/contract" apply "$HERE/expand.patch"
sed -i 's/^export const SCHEMA_VERSION = 60;$/export const SCHEMA_VERSION = 61;/; s/^export const MIN_READER_SCHEMA = 59;$/export const MIN_READER_SCHEMA = 61;/' "$W/contract/v2/core/src/schema.ts"
sed -i 's/schema 60"/schema 61"/g' "$W/contract/v2/core/src/store.ts"
for name in base n1 contract; do
  ln -s "$REPO/node_modules" "$W/$name/node_modules"
  (cd "$W/$name" && clean npm run -s build >"$W/build-$name.log" 2>&1)
done
(cd "$REPO" && clean npm run -s build >"$W/build-n.log" 2>&1)
for pair in "base:$W/base" "n:$REPO" "n1:$W/n1" "contract:$W/contract"; do
  echo "${pair%%:*}: $(grep -h '^var SCHEMA_VERSION\|^var MIN_READER_SCHEMA' "${pair#*:}"/dist/v2/*.js | tr '\n' ' ')"
done
