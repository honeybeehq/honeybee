#!/bin/bash
# macOS: does Claude Code put its own temp files in CLAUDE_CODE_TMPDIR? Lab home and config dir, a dummy key and a
# dead local base URL, so no login is read and no model call can leave this Mac. Nothing but --print with no tools.
set -u; : "${HIVE_SCRATCH:?}"; L="$HIVE_SCRATCH/cl.$$"; mkdir -p "$L/home" "$L/cfg" "$L/work-with" "$L/work-without" "$L/ct"; trap 'rm -rf "$L"' EXIT
CL=$(command -v claude); echo "claude $("$CL" --version 2>/dev/null | head -1)"
uidtmp="/tmp/claude-$(id -u)"; before=$(ls -A "$uidtmp" 2>/dev/null | sort)
run() { # run <cwd> <extra env...>
  local cwd="$1"; shift
  ( cd "$cwd" && env -i PATH="$PATH" HOME="$L/home" CLAUDE_CONFIG_DIR="$L/cfg" USER="$USER" TERM=dumb \
      ANTHROPIC_API_KEY=lab-dummy-not-a-key ANTHROPIC_BASE_URL=http://127.0.0.1:9 DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
      TMPDIR="$L/ct" "$@" "$CL" -p "say hi" --max-turns 1 </dev/null 2>&1 | tail -2 | cut -c1-160 ) &
  local p=$!; ( sleep 45; kill $p 2>/dev/null ) & local w=$!; wait $p 2>/dev/null; kill $w 2>/dev/null
}
echo "== A. TMPDIR set to the scratch, CLAUDE_CODE_TMPDIR not set (what Honeybee does today)"
run "$L/work-without"
after=$(ls -A "$uidtmp" 2>/dev/null | sort); new=$(comm -13 <(echo "$before") <(echo "$after"))
echo "new entries in $uidtmp: ${new:-none}"; echo "in the scratch: $(find "$L/ct" -mindepth 1 -maxdepth 3 | sed "s|$L|<lab>|" | head -8 | tr '\n' ' ')"
for n in $new; do case "$n" in *cl-$$*|*cl.$$*|*work-without*) rm -rf "$uidtmp/$n"; echo "removed my entry $n";; esac; done
rm -rf "$L/ct"; mkdir -p "$L/ct"; before=$(ls -A "$uidtmp" 2>/dev/null | sort)
echo "== B. CLAUDE_CODE_TMPDIR set to the scratch"
run "$L/work-with" CLAUDE_CODE_TMPDIR="$L/ct"
after=$(ls -A "$uidtmp" 2>/dev/null | sort); new=$(comm -13 <(echo "$before") <(echo "$after"))
echo "new entries in $uidtmp: ${new:-none}"; echo "in the scratch: $(find "$L/ct" -mindepth 1 -maxdepth 4 | sed "s|$L|<lab>|" | head -10 | tr '\n' ' ')"
echo "lab config dir got: $(ls -A "$L/cfg" | tr '\n' ' ')"
