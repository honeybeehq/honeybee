#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
root="$PWD"
mkdir -p "$root/.proof/B1/cli-state/home" "$root/.proof/B1/cli-state/tmp"
runs=()
for cli in claude codex; do
  for mode in idle restart human-active; do
    output=$(env -i PATH=/usr/local/bin:/usr/bin:/bin \
      HOME="$root/.proof/B1/cli-state/home" TMPDIR="$root/.proof/B1/cli-state/tmp" \
      B1_SOURCE_ROOT="${B1_SOURCE_ROOT:-$root}" \
      B1_CLAUDE_BIN="${B1_CLAUDE_BIN:-/home/trmd/.local/share/apiary-satellite/bin/claude}" \
      B1_CODEX_BIN="${B1_CODEX_BIN:-/home/trmd/.local/share/apiary-satellite/bin/codex}" \
      node "$root/.proof/B1/cli-$cli.mjs" "$mode")
    printf '%s\n' "$output"
    runs+=("$output")
  done
done
node .proof/B1/cli-collect.mjs "${runs[@]}"
