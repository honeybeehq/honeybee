#!/bin/sh
D=$(dirname "$0")
BODY=${1:-$D/daemon-suite-body.sh}
SRC=$(git -C "$D" rev-parse HEAD 2>/dev/null)
[ -n "$(git -C "$D" status --porcelain -- . 2>/dev/null)" ] && SRC="$SRC+dirty"
SCRIPTS=""
for f in "$D/darwin-gate.sh" "$BODY" "$D/seatbelt-exceptions.txt"; do [ -f "$f" ] && SCRIPTS="$SCRIPTS $(basename "$f"):$(shasum -a 256 "$f" | cut -c1-12)"; done
echo "SCG_SOURCE_SHA=\${SCG_SOURCE_SHA:-$SRC}; SCG_SCRIPTS='${SCRIPTS# }'; export SCG_SOURCE_SHA SCG_SCRIPTS"
cat "$D/darwin-gate.sh" "$BODY"
