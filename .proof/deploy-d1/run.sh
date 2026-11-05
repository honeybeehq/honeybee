#!/usr/bin/env bash
set -u
REPO=$(cd "$(dirname "$0")/../.." && pwd)
HERE=$REPO/.proof/deploy-d1
W=$REPO/.cache/d1
SB=$(mktemp -d /tmp/d1-XXXXXX)
RUN=$W/run-$(basename "$SB")
NODE=$(node -p 'require("fs").realpathSync(process.execPath)')
mkdir -p "$SB/home" "$SB/t" "$RUN"
declare -A BUILD=([base]=$W/base [n]=$REPO [n1]=$W/n1 [contract]=$W/contract)
declare -A LABEL=([base]="today's main, schema 58" [n]="this change, schema 59" [n1]="scratch expand step, schema 60 (min reader 59)" [contract]="scratch contract step, schema 61 (min reader 61)")
FAILED=0
DPID=
DATA=
ENVV=()
for v in $(env | grep -o '^HIVE_[A-Za-z0-9_]*'); do ENVV+=(-u "$v"); done
ENVV+=(-u CLAUDE_CONFIG_DIR -u CODEX_HOME HOME="$SB/home" TMPDIR="$SB/t" HIVE_NODE_PATH="$NODE" HIVE_NO_KEYCHAIN=1 HIVE_GATEWAYS_DISABLE=1
  HIVE_TEST_META_URL=http://127.0.0.1:9 HIVE_CLAUDE_USAGE_URL=http://127.0.0.1:9/usage HIVE_CLAUDE_PROFILE_URL=http://127.0.0.1:9/profile
  HIVE_CLAUDE_OAUTH_TOKEN_URL=http://127.0.0.1:9/token HIVE_CODEX_OAUTH_TOKEN_URL=http://127.0.0.1:9/token HIVE_GROK_OAUTH_TOKEN_URL=http://127.0.0.1:9/token)

redact() { sed -e "s#$RUN#\$RUN#g" -e "s#$SB#\$SB#g" -e "s#$REPO#\$REPO#g"; }
step() { echo; echo "### $*"; }
ok() { echo "PASS $*"; }
bad() { echo "FAIL $*"; FAILED=1; }
check() { if [ "$2" = "$3" ]; then ok "$1: $2"; else bad "$1: got '$2', expected '$3'"; fi; }
hosts() { pgrep -f "runner-host.js $DATA/" | wc -l | tr -d ' '; }

world() {
  DATA=$RUN/$1/v2
  mkdir -p "$DATA" "$RUN/$1/runtime" "$RUN/$1/work"
  cat > "$DATA/config.json" <<EOF
{ "tickMs": 20, "bootHangTimeoutMs": 60000, "idleWindowMs": 0, "naming": { "auto": false },
  "accounts": { "vaultDir": "$DATA/vault", "homesDir": "$DATA/homes", "limitsRefreshMs": 0 },
  "agents": { "probe": { "command": "$NODE", "args": ["$REPO/v2/driver-hsr/test-agent/agent.mjs"], "adapter": "stub", "env": { "STUB_TURN_MS": "10" } } } }
EOF
}

start() {
  local build=$1; shift
  local log=$DATA/../daemon-$build.$(date +%s%N).log
  CUR=$build
  local t0=$(date +%s%N)
  env "${ENVV[@]}" "$@" "$NODE" "${BUILD[$build]}/dist/cli.js" daemon run --data-dir "$DATA" --socket "$SB/hived.sock" >"$log" 2>&1 &
  DPID=$!
  while kill -0 "$DPID" 2>/dev/null && ! grep -q "listening on" "$log"; do sleep 0.02; done
  if grep -q "listening on" "$log"; then
    echo "daemon [$build: ${LABEL[$build]}] pid $DPID listening after $(( ($(date +%s%N) - t0) / 1000000 )) ms"
    START=up
  else
    wait "$DPID"; local code=$?
    echo "daemon [$build: ${LABEL[$build]}] did not start, exit code $code, output:"
    redact < "$log" | sed 's/^/    /'
    START=refused; DPID=
  fi
}

stop() {
  [ -n "$DPID" ] || return 0
  kill -TERM "$DPID"; wait "$DPID" 2>/dev/null
  echo "daemon [$CUR] pid $DPID stopped by its own pid; runner hosts still alive: $(hosts)"
  DPID=
}

hive() { env "${ENVV[@]}" "$NODE" "${BUILD[$CUR]}/dist/cli.js" "$@" --data-dir "$DATA" --socket "$SB/hived.sock" --json; }
field() { python3 -c 'import json,sys
d=json.load(sys.stdin)
for k in sys.argv[1].split("."):
    d=d[int(k)] if isinstance(d,list) else d.get(k) if isinstance(d,dict) else None
print(json.dumps(d) if isinstance(d,(dict,list)) else d)' "$1"; }
spawn() { hive spawn "$1" probe --cwd "$DATA/../work" | field beeId; }
send() { local bee=$1; shift; hive send "$bee" "$@"; }
delivered() { send "$@" --wait | python3 -c 'import json,sys; d=json.load(sys.stdin); print("message %s delivered=%s generation=%s" % (d.get("messageId"), d.get("deliveredAt") is not None, d.get("deliveredGeneration")))'; }
mailbox() { hive mailbox "$1" | python3 -c 'import json,sys
for m in json.load(sys.stdin)["messages"]:
    print("    mail %s %-5s %-9s gen=%s  %s" % (m["id"], m["urgency"], "delivered" if m.get("deliveredAt") else "PENDING", m.get("deliveredGeneration"), m["body"].replace(sys.argv[1], "$RUN")[:60]))' "$RUN"; }
pending() { hive mailbox "$1" | python3 -c 'import json,sys; print(sum(1 for m in json.load(sys.stdin)["messages"] if not m.get("deliveredAt")))'; }
bees() { hive list | python3 -c 'import json,sys
for v in json.load(sys.stdin)["views"]:
    print("    bee %-6s runtime=%s generation=%s" % (v["bee"]["name"], (v.get("runtime") or {}).get("state"), (v.get("runtime") or {}).get("generation")))'; }
store_info() { hive deploy-info | field store; }
meta() { python3 - "$DATA/core.sqlite3" <<'EOF'
import sqlite3,sys
db=sqlite3.connect("file:%s?mode=ro" % sys.argv[1], uri=True)
m=dict(db.execute("SELECT key,value FROM meta WHERE key IN ('schema_version','min_reader_schema')"))
print("schema_version=%s min_reader_schema=%s" % (m.get("schema_version"), m.get("min_reader_schema","(absent)")))
EOF
}
sql() { python3 - "$DATA/core.sqlite3" "$1" <<'EOF'
import sqlite3,sys
db=sqlite3.connect("file:%s?mode=ro" % sys.argv[1], uri=True)
for row in db.execute(sys.argv[2]): print("    " + " | ".join(str(c) for c in row))
EOF
}
receipts() { ls "$DATA/core.sqlite3.backups" 2>/dev/null | grep -c '\.json$'; }
boot() { echo "    $(grep -ho '"op":"boot adopted=[^"]*' "$DATA/hived.log" | tail -n 1 | cut -d'"' -f4)"; }
typed_open() {
  env "${ENVV[@]}" "$NODE" --input-type=module -e '
    const { openCoreStore } = await import(process.argv[1] + "/v2/core/src/index.ts");
    try { openCoreStore(process.argv[2]).close(); console.log("opened"); }
    catch (error) { console.log(`${error.constructor.name} kind=${error.kind}`); }
  ' "${BUILD[$1]}" "$DATA/core.sqlite3" 2>&1 | redact
}
rollback_check() {
  local src=$1 target=$2
  env "${ENVV[@]}" "$NODE" --input-type=module -e '
    const { assertRollbackStoreCompatible } = await import(process.argv[1] + "/v2/cli/src/deploy/runtime.ts");
    try { await assertRollbackStoreCompatible(process.argv[2], process.argv[3]); console.log("allowed"); }
    catch (error) { console.log(error.code ? `refused, code ${error.code}: ${error.message}` : `${error.name}: ${error.message}`); }
  ' "${BUILD[$src]}" "$DATA/../runtime" "${BUILD[$target]}" 2>&1 | redact | cut -c1-330
}
reap() {
  for status in "$DATA"/runners/*.status.json; do
    [ -e "$status" ] || continue
    local pid=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("hostPid",""))' "$status" 2>/dev/null)
    [ -n "$pid" ] && grep -qa "$DATA" "/proc/$pid/cmdline" 2>/dev/null && kill -KILL -- "-$pid" 2>/dev/null
  done
}
cleanup() { [ -n "$DPID" ] && kill -TERM "$DPID" 2>/dev/null; for d in "$RUN"/*/v2; do DATA=$d; reap; done; rm -rf "$SB"; [ "${KEEP:-0}" = 1 ] || rm -rf "$RUN"; }
trap cleanup EXIT

echo "host $(hostname), node $("$NODE" --version), $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "scratch only: data dirs under \$RUN (in this Cell's .cache), sockets under \$SB (a private /tmp dir), HOME=\$SB/home, every HIVE_* of the caller unset, provider URLs at 127.0.0.1:9; daemons are started as 'node dist/cli.js daemon run' and stopped by their own pid"
for b in base n n1 contract; do
  echo "build $b (${LABEL[$b]}): source $(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["sourceRevision"][:12])' "${BUILD[$b]}/dist/build-identity.json")$(git -C "${BUILD[$b]}" diff --quiet -- v2 || echo " + expand.patch"), bundle says $(grep -h '^var SCHEMA_VERSION\|^var MIN_READER_SCHEMA' "${BUILD[$b]}"/dist/v2/*.js | tr '\n' ' ')"
done

step "BEFORE 1. today's main (58) creates a store, runs a bee, delivers"
world before
start base
A=$(spawn alpha); echo "alpha: $(delivered "$A" "written by 58")"
stop; echo "store: $(meta)"

step "BEFORE 2. the next build (59, this change) opens it, migrates, delivers"
start n
echo "alpha: $(delivered "$A" "written by 59")"
stop; echo "store: $(meta); migration backup receipts: $(receipts)"

step "BEFORE 3. today's main (58) is asked to open that store again: refused, and its rollback check says restore a backup"
start base
check "58 on a 59 store" "$START" refused
echo "the refusal 58 raises when it opens the store: $(typed_open base)"
echo "rollback check by 58's own code, target 58: $(rollback_check base base)"
start n HIVE_TEST_REAP_RUNTIMES_ON_SHUTDOWN=1; stop

step "AFTER 1. this change (59) creates a store, runs a bee, delivers"
world after
start n
A=$(spawn alpha); echo "alpha: $(delivered "$A" "m1 written by 59")"
echo "deploy-info store: $(store_info)"
stop; echo "store: $(meta)"

step "AFTER 2. an expand build (60, min reader 59) opens it, migrates, writes a bee and mail, and leaves mail pending on a bee that is mid-turn"
start n1
boot
check "deploy-info store under 60" "$(store_info)" '{"schemaVersion": 60, "minReaderSchema": 59}'
B=$(spawn beta); echo "beta (created by 60): $(delivered "$B" "m2 written by 60")"
send "$A" "@wait-file:$RUN/after/release-alpha" >/dev/null
sleep 0.3
send "$A" "m4 queued under 60 while alpha is mid-turn" --urgency idle >/dev/null
send "$B" "@wait-file:$RUN/after/release-beta" >/dev/null
sleep 0.3
send "$B" "m6 queued under 60 while beta is mid-turn" --urgency idle >/dev/null
bees; mailbox "$A"; mailbox "$B"
check "pending mail on alpha under 60" "$(pending "$A")" 1
check "pending mail on beta under 60" "$(pending "$B")" 1
stop; echo "store: $(meta); migration backup receipts: $(receipts)"
check "store after the expand build" "$(meta)" "schema_version=60 min_reader_schema=59"

step "AFTER 3. rollback check on the stopped store (schema 60, min reader 59)"
echo "target 59 (this change): $(rollback_check n n)"
echo "target 58 (today's main): $(rollback_check n base)"
check "rollback to 59 from a 60 expand store" "$(rollback_check n n)" allowed

step "AFTER 4. the rollback: the 59 build opens the 60 store read-write, adopts the bees the 60 daemon left running, and delivers"
start n
check "59 on a 60 expand store" "$START" up
boot
check "deploy-info store under 59" "$(store_info)" '{"schemaVersion": 60, "minReaderSchema": 59}'
bees
check "mail still pending on alpha before its turn ends" "$(pending "$A")" 1
touch "$RUN/after/release-alpha" "$RUN/after/release-beta"
for i in $(seq 1 200); do [ "$(pending "$A")$(pending "$B")" = 00 ] && break; sleep 0.05; done
mailbox "$A"; mailbox "$B"
check "pending mail on alpha after the 59 daemon delivered" "$(pending "$A")" 0
check "pending mail on beta after the 59 daemon delivered" "$(pending "$B")" 0
echo "alpha, new mail under 59: $(delivered "$A" "m7 written by 59 on the 60 store")"
echo "beta, new mail under 59: $(delivered "$B" "m8 written by 59 on the 60 store")"
G=$(spawn gamma); echo "gamma (created by 59 on the 60 store): $(delivered "$G" "m9 written by 59")"
echo "rollback check with the daemon live, target 59: $(rollback_check n n)"
echo "rollback check with the daemon live, target 58: $(rollback_check n base)"
stop
check "store after the 59 build wrote to it" "$(meta)" "schema_version=60 min_reader_schema=59"
echo "bees and the column only schema 60 knows:"; sql "SELECT name, COALESCE(d1_expand_note,'NULL') FROM bees ORDER BY created_at"
echo "rows in the table only schema 60 knows:"; sql "SELECT b.name, l.note FROM d1_expand_log l JOIN bees b ON b.id = l.bee_id"

step "AFTER 5. roll forward: the 60 build opens the store again, no second migration, everything 59 wrote is there"
R=$(receipts)
start n1
boot
check "backup receipts unchanged (no re-migration)" "$(receipts)" "$R"
bees
echo "gamma under 60: $(delivered "$G" "m10 written by 60")"
stop

step "AFTER 6. a contract build (61, min reader 61) opens the store and raises the reader floor"
start contract
D=$(spawn delta); echo "delta (created by 61): $(delivered "$D" "m11 written by 61")"
check "deploy-info store under 61" "$(store_info)" '{"schemaVersion": 61, "minReaderSchema": 61}'
stop
check "store after the contract build" "$(meta)" "schema_version=61 min_reader_schema=61"
SUM=$(sha256sum "$DATA/core.sqlite3" | cut -c1-16)

step "AFTER 7. after the contract step the older builds are refused, typed, and the store is untouched"
start n
check "59 on a contract-61 store" "$START" refused
start n1
check "60 on a contract-61 store" "$START" refused
check "the refusal 59 raises when it opens the store" "$(typed_open n)" "SchemaVersionError kind=schema_newer"
check "store file unchanged by the refused opens" "$(sha256sum "$DATA/core.sqlite3" | cut -c1-16)" "$SUM"
echo "rollback check, target 59: $(rollback_check n n)"
echo "rollback check, target 60: $(rollback_check n n1)"
echo "rollback check, target 61: $(rollback_check n contract)"
case "$(rollback_check n n)" in "refused, code ROLLBACK_STORE_NEWER_THAN_TARGET"*) ok "rollback to 59 past a contract step is refused typed" ;; *) bad "rollback to 59 past a contract step was not refused typed" ;; esac
check "rollback to the contract build itself" "$(rollback_check n contract)" allowed

step "cleanup: one last daemon reaps the scratch bees, then nothing of this run is left running"
start contract HIVE_TEST_REAP_RUNTIMES_ON_SHUTDOWN=1
stop
sleep 0.5
check "scratch processes left" "$(pgrep -f "$RUN|$SB" | grep -vc "^$$\$")" 0

echo
[ "$FAILED" = 0 ] && echo "RESULT: all checks passed" || echo "RESULT: FAILED"
exit "$FAILED"
