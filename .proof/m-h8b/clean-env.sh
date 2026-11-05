#!/usr/bin/env bash
# Run a command with every HIVE_* variable, CLAUDE_CONFIG_DIR and CODEX_HOME unset.
unset_args=()
while IFS= read -r name; do unset_args+=(-u "$name"); done < <(env | grep -oE '^(HIVE_[A-Za-z0-9_]+|CLAUDE_CONFIG_DIR|CODEX_HOME)=' | sed 's/=$//')
exec env "${unset_args[@]}" "$@"
