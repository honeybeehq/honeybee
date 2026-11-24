#!/usr/bin/env bash
# Per harness: does the binary start inside both shapes, and what does it put in /tmp? Lab HOME (no login), --version/--help only.
. "$(dirname "$0")/lib.sh"
UH=$(getent passwd "$(id -un)" | cut -d: -f6)
S="$LAB/scratch/bee"; mkdir -p "$S/.var-tmp" "$LAB/cell"
found=""
for h in claude codex cursor-agent grok opencode kimi agy muse; do
  b=$(ls -d "$UH"/.local/bin/$h "$UH"/.npm-global/bin/$h "$UH"/.claude/local/$h "$UH"/.bun/bin/$h "$UH"/.local/share/pnpm/$h "$UH"/.local/share/mise/shims/$h "$UH"/.nvm/versions/node/*/bin/$h "$UH"/.cursor/bin/$h "$UH"/.grok/bin/$h "$UH"/.opencode/bin/$h /usr/local/bin/$h /usr/bin/$h 2>/dev/null | head -1)
  echo "$h: $([ -n "$b" ] && echo "found (${b#$UH/})" || echo "not found")"; [ -n "$b" ] && found="$found $h=$b"
done
P="$PATH:$UH/.local/bin:/usr/local/bin"
wrap()  { bwrap --dev-bind / / --bind "$S" /tmp --bind "$S/.var-tmp" /var/tmp --size 268435456 --tmpfs /dev/shm --unshare-pid --proc /proc --die-with-parent --setenv TMPDIR /tmp --setenv PATH "$P" "$@"; }
wrapc() { bwrap --ro-bind / / --dev /dev --bind "$LAB" "$LAB" --bind "$S" /tmp --bind "$S/.var-tmp" /var/tmp --size 268435456 --tmpfs /dev/shm --unshare-pid --proc /proc --die-with-parent --setenv TMPDIR /tmp --setenv PATH "$P" "$@"; }
for kv in $found; do h=${kv%%=*}; b=${kv#*=}
  echo "$h plain:    $(timeout 30 "$b" --version 2>&1 | tail -1 | cut -c1-70)"
  echo "$h open:     $(wrap  -- timeout 30 "$b" --version 2>&1 | tail -1 | cut -c1-70)"
  echo "$h confined: $(wrapc -- timeout 30 "$b" --version 2>&1 | tail -1 | cut -c1-70)"
done
echo "entries left in the session's /tmp: $(ls -A "$S" | grep -v '^.var-tmp$' | tr '\n' ' ')"
echo "entries left in lab HOME: $(ls -A "$HOME" | tr '\n' ' ')"
