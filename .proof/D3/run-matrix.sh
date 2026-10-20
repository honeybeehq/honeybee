#!/usr/bin/env bash
repo_root=$(pwd)
run_root=$(mktemp -d /var/tmp/hb-D3-matrix-XXXXXX) || exit 1
mkdir -p "$run_root/tmp" "$run_root/cache" "$run_root/trash" || exit 1
printf '%s\n' "$run_root" > .proof/D3/run-root-final.txt
result=0
for readonly_mode in 0 1; do
  for delayed in 0 1; do
    label="final-readonly-$readonly_mode-delay-$delayed"
    mkdir -p "$run_root/$label-home" || exit 1
    imports="--import=$repo_root/.proof/D3/probe.mjs"
    if [ "$delayed" = 1 ]; then imports="$imports --import=$repo_root/.proof/D3/delay-cli.mjs"; fi
    env -i HOME="$run_root/$label-home" PATH=/usr/local/bin:/usr/bin:/bin TMPDIR="$run_root/tmp" NODE_COMPILE_CACHE="$run_root/cache" D2_ROOT="$run_root" D2_READONLY_CODEX="$readonly_mode" D2_FS_LOG="$repo_root/.proof/D3/$label-homes.jsonl" NODE_OPTIONS="$imports" node --test --test-name-pattern="^central Codex: isolated daemon rotates once" v2/daemon/tests/codex-central-credentials.test.ts > ".proof/D3/$label.log" 2>&1
    status=$?
    printf '%s %s\n' "$label" "$status"
    if [ "$status" != 0 ]; then result=1; fi
  done
done
exit "$result"
