#!/usr/bin/env bash
# Runs a command with every HIVE_* variable, CLAUDE_CONFIG_DIR and CODEX_HOME unset.
for v in $(env | grep -o "^HIVE_[A-Z0-9_]*"); do unset "$v"; done
unset CLAUDE_CONFIG_DIR CODEX_HOME
exec "$@"
