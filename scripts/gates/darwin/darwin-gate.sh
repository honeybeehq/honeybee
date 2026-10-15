set -u
SCG_GATE_VERSION=darwin-gate/1
SCG_ALLOWED_HOSTS="trmd-erebor-mini02 trmd-moria-mini03 trmd-hobbiton-mini04 trmd-lorien-mini05"
if [ -z "${SCG_STAGE:-}" ]; then
  H=$(hostname -s | tr '[:upper:]' '[:lower:]')
  case " $SCG_ALLOWED_HOSTS " in *" $H "*) ;; *) echo "REFUSING: host '$H' is not a lab/satellite mini (allowed: $SCG_ALLOWED_HOSTS)"; exit 90;; esac
  [ "$(uname -s)" = Darwin ] || { echo "REFUSING: darwin gate on $(uname -s)"; exit 90; }
  R=$(eval echo "~$(id -un)")
  case "$R" in /Users/*) ;; *) echo "REFUSING: cannot resolve the real home from passwd ($R)"; exit 90;; esac
  case "$R" in *forage*|*/.cache/*) echo "REFUSING: passwd home looks fake ($R)"; exit 90;; esac
  [ -n "${FORAGE_JOB:-}" ] || { echo "REFUSING: not a forage job (FORAGE_JOB unset); launch through forage"; exit 90; }
  case "$PWD/" in "$R/.hive/v2/cells/"*|*"/cells/"*"-space-"*) echo "REFUSING: running inside a Cell checkout ($PWD); Cells never run the daemon suite"; exit 90;; esac
  case "$PWD/" in "$R/.forage/work/"*) ;; *) echo "REFUSING: not in a forage lane ($PWD)"; exit 90;; esac
  [ -z "$(env | grep -E '^HIVE_CELL' | head -1)" ] || { echo "REFUSING: HIVE_CELL* set; this is a Cell"; exit 90; }
  NB=$(HOME="$R" node -p process.execPath 2>/dev/null)
  if [ ! -x "$NB" ] || [ "$("$NB" -p 'process.versions.node.split(".")[0]')" -lt 24 ]; then NB=$(HOME="$R" mise which node 2>/dev/null); fi
  [ -x "$NB" ] && [ "$("$NB" -p 'process.versions.node.split(".")[0]')" -ge 24 ] || { echo "REFUSING: no Node >= 24 on this host (found ${NB:-none})"; exit 90; }
  PB=$(HOME="$R" mise which pnpm 2>/dev/null || true)
  SNAP=$(git rev-parse HEAD 2>/dev/null || echo unknown)
  exec env -i PATH="$(dirname "$NB"):$(dirname "${PB:-/nonexistent/pnpm}"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" LANG=en_US.UTF-8 USER="$(id -un)" LOGNAME="$(id -un)" SHELL=/bin/bash \
    SCG_STAGE=1 SCG_REAL_HOME="$R" SCG_NODE_BIN="$NB" SCG_FORAGE_JOB="$FORAGE_JOB" SCG_LANE="$(basename "$PWD")" SCG_SNAPSHOT="$SNAP" SCG_SOURCE_SHA="${SCG_SOURCE_SHA:-}" SCG_SCRIPTS="${SCG_SCRIPTS:-}" \
    /bin/bash "$0" "$@"
fi
REAL_HOME=$SCG_REAL_HOME; NODE_BIN=$SCG_NODE_BIN; LIB=$REAL_HOME/Library
SCG_RC=0
LIB_THIRD_PARTY_FILE=scripts/gates/darwin/third-party-warn.txt
LIB_THIRD_PARTY=$(grep -v '^#' "$LIB_THIRD_PARTY_FILE" 2>/dev/null | grep .)
[ -n "$LIB_THIRD_PARTY" ] || { echo "REFUSING: third-party WARN list $LIB_THIRD_PARTY_FILE is missing or empty"; exit 99; }
while IFS='|' read -r entry owner mode extra; do
  [ -n "$entry" ] && [ -n "$owner" ] && [ -z "$extra" ] || { echo "REFUSING: malformed line in $LIB_THIRD_PARTY_FILE: $entry|$owner|$mode${extra:+|$extra}"; exit 99; }
  case "$mode" in ""|inside|existing|modified|interim) ;; *) echo "REFUSING: unknown mode '$mode' in $LIB_THIRD_PARTY_FILE"; exit 99;; esac
  case "$mode" in inside|modified) case "$entry" in */) ;; *) echo "REFUSING: mode $mode needs a trailing / in $LIB_THIRD_PARTY_FILE: $entry"; exit 99;; esac;; esac
done <<< "$LIB_THIRD_PARTY"
gate_fail() { echo "GATE FAIL: $*"; SCG_RC=1; }

SENTINEL_KNOWN="hived.sock core.sqlite3"
home_snap() {
  { echo "# real HOME top level (inode name)"; ls -ai "$REAL_HOME" | awk '{print $1, $2}' | sort -k2
    echo "# real hive data dir (inode name)"; ls -ai "$REAL_HOME/.hive/v2" 2>/dev/null | awk '{print $1, $2}' | sort -k2
    echo "# live socket"; stat -f '%i %z %N' "$REAL_HOME/.hive/v2/hived.sock" 2>&1
  } > "$1.ids"
  { stat -f '%m %N' "$REAL_HOME"/.[!.]* "$REAL_HOME"/* "$REAL_HOME/.hive/v2"/* 2>/dev/null | sort -k2; } > "$1.mtimes"
}
home_valid() {
  local f=$1 known=0 k
  [ -s "$f.ids" ] && [ -s "$f.mtimes" ] || { echo "empty snapshot"; return 1; }
  [ "$(grep -vc '^#' "$f.ids")" -ge 3 ] || { echo "snapshot has fewer than 3 entries"; return 1; }
  for k in $SENTINEL_KNOWN; do [ -e "$REAL_HOME/.hive/v2/$k" ] && grep -qE "(^[0-9]+ $k\$|/$k\$)" "$f.ids" && known=1; done
  [ $known -eq 1 ] || { echo "no known real entry (~/.hive/v2/hived.sock or core.sqlite3)"; return 1; }
}

LIB_AREAS="Application Support|Logs|Caches|Containers|LaunchAgents"
LIB_OWN_IDS="dev.apiary. dev.honeybee. com.trmd.apiary ${SCG_LAB_BUNDLE_IDS:-}"
LIB_ELECTRON_OK="AppleTextDirection NSForceRightToLeftWritingDirection NSTreatUnknownArgumentsAsOpen SKPurchaseIntentUpdatesLastChecked"
LIB_HOST_SHARED_CLAUDE='Caches/claude-cli-nodejs'
LIB_OUR_NAMES='dev.apiary.|dev.honeybee.|com.trmd.apiary|com.github.Electron|Apiary|apiary|Honeybee|honeybee'
lib_third_party_owner() {
  local p=$1 before=$2 entry owner mode
  ( IFS='|'; for n in $LIB_OUR_NAMES; do case "$p" in *"$n"*) exit 0;; esac; done; exit 1 ) && return 1
  while IFS='|' read -r entry owner mode; do
    case "$mode" in interim) continue;; esac
    case "$entry" in
      */) case "$mode" in inside) case "$p" in "$entry"?*) echo "$owner"; return 0;; esac;;
            modified) case "$p/" in "$entry"*) cut -d'|' -f2 "$before" | grep -qxF "$p" && { echo "$owner, modified existing entry"; return 0; }; break;; esac;;
            *) case "$p/" in "$entry"*) echo "$owner"; return 0;; esac;; esac;;
      *) [ "$p" = "$entry" ] || continue
         [ "$mode" = existing ] && ! cut -d'|' -f2 "$before" | grep -qxF "$p" && break
         echo "$owner"; return 0;;
    esac
  done <<< "$LIB_THIRD_PARTY"
  while IFS='|' read -r entry owner mode; do
    [ "$mode" = interim ] || continue
    case "$p" in $entry) echo "$owner"; return 0;; esac
  done <<< "$LIB_THIRD_PARTY"
  return 1
}
claude_census() {
  local snap gate_pgid
  gate_pgid=$(ps -o pgid= -p "$SCG_GATE_PID" | tr -d ' ')
  while :; do
    snap=$(ps -axo pid=,ppid=,pgid=,command= 2>/dev/null)
    printf '%s\n' "$snap" | awk -v gate="$SCG_GATE_PID" -v gpg="$gate_pgid" -v root="$GATE_ROOT" -v lane="$PWD" '
      { pid=$1; ppid[pid]=$2; pg[pid]=$3; exe=""
        for (i=4; i<=5 && i<=NF; i++) { n=split($i, parts, "/"); if (parts[n]=="claude" || $i ~ /@anthropic-ai\/claude-code/) { exe=$i; break } }
        if (exe != "" && index(exe, root) != 1 && index(exe, lane) != 1) { cand[pid]=exe; argv_root[pid]=(index($0, root) > 0) } }
      END { for (pid in cand) { own="foreign"; if (pg[pid]==gpg || argv_root[pid]) own="gate"; p=pid
              for (k=0; k<64 && own=="foreign" && p+0>1; k++) { if (p==gate) own="gate"; p=ppid[p] }
              print pid, own, cand[pid] } }'
    sleep 2
  done | while read -r pid own exe; do
    [ "$own" = foreign ] && lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | grep -q "^n$GATE_ROOT" && own=gate
    echo "$pid $own $exe"
  done >> "$GATE_ROOT/claude.census"
}
claude_attribution() {
  local gate foreign
  gate=$(awk '$2=="gate"{print $1}' "$GATE_ROOT/claude.census" 2>/dev/null | sort -u | tr '\n' ' ')
  foreign=$(awk '$2=="foreign"{print $1}' "$GATE_ROOT/claude.census" 2>/dev/null | sort -u | tr '\n' ' ')
  if [ -n "$gate" ]; then echo "gate-owned real Claude CLI pids: $gate"; return 1; fi
  if [ -n "$foreign" ]; then echo "host shared: foreign Claude CLI pids $foreign; no gate-owned Claude CLI seen"; return 0; fi
  echo "unknown: no Claude CLI process seen by the census"; return 1
}
plist_keys() { plutil -convert xml1 -o - "$1" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let depth=0,keys=[];const re=/<(\/?)(dict|key)>([^<]*)/g;let m;while((m=re.exec(s))){if(m[2]==="dict"){depth+=m[1]?-1:1}else if(!m[1]&&depth===1)keys.push(m[3])}console.log(keys.sort().join(","))})'; }
lib_watch() { case "$1" in com.github.Electron*|dev.apiary.*|dev.honeybee.*|com.trmd.apiary*|io.tailscale.*|.GlobalPreferences.plist|com.apple.spaces.plist) return 0;; esac; for i in ${SCG_LAB_BUNDLE_IDS:-}; do case "$1" in "$i"*) return 0;; esac; done; return 1; }
lib_snap() {
  ( cd "$LIB/Preferences" 2>/dev/null && for f in .[!.]*.plist *.plist; do [ -f "$f" ] && stat -f "%N|%B|%m|%z" "$f"; done ) | sort > "$1.prefs"
  : > "$1.keys"; while IFS='|' read -r n _; do lib_watch "$n" && echo "$n|$(plist_keys "$LIB/Preferences/$n")" >> "$1.keys"; done < "$1.prefs"
  ( IFS='|'; for a in $LIB_AREAS; do find "$LIB/$a" -maxdepth 2 2>/dev/null | while read -r p; do echo "$(stat -f %i "$p" 2>/dev/null)|${p#$LIB/}"; done; done ) | sort -t'|' -k2 > "$1.areas"
}
lib_valid() { [ -s "$1.prefs" ] && [ -s "$1.areas" ] && grep -q '|' "$1.prefs" || { echo "empty ~/Library snapshot"; return 1; }; }
lib_verdict() {
  local b=$1 a=$2 n bb bm bz ab am az ak bk k extra
  echo "== ~/Library sentinel (Preferences, $LIB_AREAS)"
  while IFS='|' read -r n ab am az; do
    if ! grep -q "^$(printf %s "$n" | sed 's/[.[\*^$]/\\&/g')|" "$b.prefs"; then
      case "$n" in com.apple.*) echo "WARN created $n mtime=$am size=$az";; *) gate_fail "plist CREATED under ~/Library/Preferences: $n (mtime=$am size=$az)";; esac; continue; fi
    IFS='|' read -r _ bb bm bz < <(grep "^$(printf %s "$n" | sed 's/[.[\*^$]/\\&/g')|" "$b.prefs")
    [ "$bm" = "$am" ] && [ "$bz" = "$az" ] && [ "$bb" = "$ab" ] && continue
    ak=$(lib_watch "$n" && plist_keys "$LIB/Preferences/$n"); bk=$(grep "^$(printf %s "$n" | sed 's/[.[\*^$]/\\&/g')|" "$b.keys" | cut -d'|' -f2)
    case "$n" in
      com.github.Electron*) extra=""; for k in $(echo "$ak" | tr ',' ' '); do case " $LIB_ELECTRON_OK " in *" $k "*) ;; *) extra="$extra $k";; esac; done
        [ -n "$extra" ] && gate_fail "modified $n carries keys beyond the allowed set:$extra" || echo "WARN modified $n (allowed keys only) mtime=$am size=$az keys=$ak";;
      io.tailscale.*) [ "$ak" = "$bk" ] && echo "WARN modified $n (key set unchanged) mtime=$am size=$az" || gate_fail "modified $n changed its key set ($bk -> $ak)";;
      com.apple.*|.GlobalPreferences.plist) echo "WARN modified $n mtime=$bm->$am size=$bz->$az${ak:+ keys=$ak}";;
      *) own=0; for i in $LIB_OWN_IDS; do case "$n" in "$i"*) own=1;; esac; done
        [ $own = 1 ] && gate_fail "modified our app plist $n" || echo "WARN modified third-party plist $n mtime=$bm->$am size=$bz->$az";;
    esac
  done < "$a.prefs"
  while IFS='|' read -r n _; do grep -q "^$(printf %s "$n" | sed 's/[.[\*^$]/\\&/g')|" "$a.prefs" || { own=0; for i in $LIB_OWN_IDS; do case "$n" in "$i"*) own=1;; esac; done; [ $own = 1 ] && gate_fail "our app plist removed: $n" || echo "WARN plist removed: $n"; }; done < "$b.prefs"
  local changed; changed=$( ( IFS='|'; for ar in $LIB_AREAS; do find "$LIB/$ar" \( -newer "$GATE_ROOT/lib.marker" -o -cnewer "$GATE_ROOT/lib.marker" \) 2>/dev/null; done ) | sed "s|^$LIB/||" | sort -u)
  local gone; gone=$(comm -23 <(cut -d'|' -f2 "$b.areas") <(cut -d'|' -f2 "$a.areas"))
  printf '%s\n' "$changed" | while read -r p; do [ -z "$p" ] && continue
    if owner=$(lib_third_party_owner "$p" "$b.areas"); then echo "WARN third-party ($owner): $p"
    elif [ "$p" = "$LIB_HOST_SHARED_CLAUDE" ] || case "$p" in "$LIB_HOST_SHARED_CLAUDE"/*) true;; *) false;; esac; then
      if why=$(claude_attribution); then echo "WARN host shared ($why): $p"; else echo "LIBFAIL claude-cli-nodejs changed, $why: $p"; fi
    else echo "LIBFAIL new/modified under ~/Library: $p"; fi; done > "$GATE_ROOT/lib.changes"
  cat "$GATE_ROOT/lib.changes"
  echo "(~/Library: $(grep -c '^WARN third-party' "$GATE_ROOT/lib.changes") third-party WARN, $(grep -c '^LIBFAIL' "$GATE_ROOT/lib.changes") FAIL)"
  grep -q '^LIBFAIL' "$GATE_ROOT/lib.changes" && gate_fail "~/Library changed outside the Queen-approved third-party list ($(grep -c '^LIBFAIL' "$GATE_ROOT/lib.changes") entries)"
  [ -n "$gone" ] && { printf '%s\n' "$gone" | sed 's/^/LIBFAIL removed: /' | head -20; gate_fail "~/Library entries removed"; }
  echo "(~/Library verdict done)"
}

SCG_SB_PROFILE='(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))(allow network-outbound (remote unix-socket))'
write_net_trap() {
cat > "$1" <<'TRAP'
import net from "node:net";
import dns from "node:dns";
import dgram from "node:dgram";
import fs from "node:fs";
const sink = process.env.SCG_NET_VIOLATIONS;
const local = (h) => !h || h === "localhost" || h.endsWith(".localhost") || /^127\./.test(h) || h === "::1" || /^(0:){7}0*1$/.test(h) || /^::ffff:127\./i.test(h);
const violate = (kind, detail) => {
  try { fs.appendFileSync(sink, `${new Date().toISOString()} pid=${process.pid} ${kind} ${detail} script=${process.argv[1] ?? ""}\n`); } catch {}
  const error = new Error(`scg-gate: outbound network blocked (${kind} ${detail})`);
  error.code = "ESCGNET";
  return error;
};
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let o = args[0];
  if (Array.isArray(o)) o = o[0];
  let host, port, path;
  if (o && typeof o === "object") ({ host, port, path } = o);
  else if (typeof o === "string" && Number.isNaN(Number(o))) path = o;
  else { port = o; host = typeof args[1] === "string" ? args[1] : undefined; }
  if (path || local(host)) return connect.apply(this, args);
  const error = violate("connect", `${host}:${port}`);
  process.nextTick(() => this.destroy(error));
  return this;
};
const lookup = dns.lookup;
dns.lookup = function (host, ...rest) {
  if (typeof host !== "string" || local(host) || net.isIP(host)) return lookup.call(this, host, ...rest);
  const cb = rest[rest.length - 1];
  const error = violate("dns.lookup", host);
  if (typeof cb === "function") process.nextTick(() => cb(error));
  return {};
};
const plookup = dns.promises.lookup;
dns.promises.lookup = async (host, ...rest) => {
  if (typeof host !== "string" || local(host) || net.isIP(host)) return plookup(host, ...rest);
  throw violate("dns.promises.lookup", host);
};
for (const name of ["resolve", "resolve4", "resolve6", "resolveAny", "resolveSrv", "resolveTxt", "resolveMx", "resolveCname", "resolveNs"]) {
  const cbv = dns[name];
  if (typeof cbv === "function") dns[name] = function (host, ...rest) {
    if (local(host)) return cbv.call(this, host, ...rest);
    const cb = rest[rest.length - 1];
    const error = violate(`dns.${name}`, host);
    if (typeof cb === "function") process.nextTick(() => cb(error));
  };
  const pv = dns.promises[name];
  if (typeof pv === "function") dns.promises[name] = async (host, ...rest) => { if (local(host)) return pv(host, ...rest); throw violate(`dns.promises.${name}`, host); };
}
const send = dgram.Socket.prototype.send;
dgram.Socket.prototype.send = function (...args) {
  const address = args.find((value, index) => index > 0 && typeof value === "string");
  if (address && !local(address)) throw violate("dgram.send", address);
  return send.apply(this, args);
};
TRAP
}
net_probe() {
  local pv=$GATE_ROOT/probe-violations ok=1 out
  echo "== NETWORK PROBE (must refuse outbound, allow loopback) before any measured run"
  sandbox-exec -p "$SCG_SB_PROFILE" /usr/bin/nc -z -G 3 1.1.1.1 443 >/dev/null 2>&1 && { echo "probe: seatbelt nc 1.1.1.1:443 CONNECTED"; ok=0; } || echo "probe: seatbelt nc 1.1.1.1:443 refused (ok)"
  out=$(sandbox-exec -p "$SCG_SB_PROFILE" node -e 'require("net").connect({host:"1.1.1.1",port:443}).on("connect",()=>{console.log("CONNECTED");process.exit(0)}).on("error",e=>{console.log(e.code);process.exit(3)})' 2>&1); [ "$out" = EPERM ] && echo "probe: seatbelt node 1.1.1.1:443 -> EPERM (ok)" || { echo "probe: seatbelt node -> $out"; ok=0; }
  out=$(SCG_NET_VIOLATIONS=$pv node --import="$SCG_TRAP" -e 'require("net").connect({host:"1.1.1.1",port:443}).on("connect",()=>{console.log("CONNECTED");process.exit(0)}).on("error",e=>{console.log(e.code);process.exit(3)})' 2>&1); [ "$out" = ESCGNET ] && grep -q '1.1.1.1:443' "$pv" && echo "probe: trap node 1.1.1.1:443 -> ESCGNET, recorded (ok)" || { echo "probe: trap node -> $out"; ok=0; }
  out=$(SCG_NET_VIOLATIONS=$pv node --import="$SCG_TRAP" -e 'require("dns").lookup("example.com",(e,a)=>{console.log(e?e.code:"RESOLVED "+a)})' 2>&1); [ "$out" = ESCGNET ] && echo "probe: trap dns example.com -> ESCGNET (ok)" || { echo "probe: trap dns -> $out"; ok=0; }
  out=$(sandbox-exec -p "$SCG_SB_PROFILE" env SCG_NET_VIOLATIONS=$pv node --import="$SCG_TRAP" -e 'const s=require("net").createServer(c=>c.end("hi")).listen(0,"127.0.0.1",()=>{require("net").connect(s.address().port,"127.0.0.1").on("data",d=>{console.log(String(d));process.exit(0)}).on("error",e=>{console.log(e.code);process.exit(3)})})' 2>&1); [ "$out" = hi ] && echo "probe: loopback under both layers works (ok)" || { echo "probe: loopback -> $out"; ok=0; }
  out=$(sandbox-exec -p "$SCG_SB_PROFILE" sh -c 'GIT_ALLOW_PROTOCOL=file git ls-remote https://github.com/honeybeehq/honeybee 2>&1 | head -1'); case "$out" in *"not allowed"*|*"transport"*) echo "probe: git https refused (ok): $out";; *) echo "probe: git https -> $out"; ok=0;; esac
  out=$(sandbox-exec -p "$SCG_SB_PROFILE" ps -p $$ -o lstart= 2>&1); printf %s "$out" | grep -qE '[0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4}' && [ "$(command -v ps)" = "$SCG_PS_SHIM/ps" ] && echo "probe: seatbelt ps via the non-setuid shim reads lstart (ok)" || { echo "probe: seatbelt ps -> $out ($(command -v ps))"; ok=0; }
  [ $ok = 1 ] || { echo "REFUSING: gate probe failed; the gate cannot prove outbound is blocked or that tests can run under Seatbelt"; exit 97; }
}
net_verdict() {
  echo "== NETWORK verdict"
  if [ -s "$SCG_NET_VIOLATIONS" ]; then cat "$SCG_NET_VIOLATIONS" | head -40; gate_fail "test processes attempted non-loopback network ($(wc -l < "$SCG_NET_VIOLATIONS" | tr -d ' ') events)"; else echo "trap: 0 non-loopback attempts"; fi
  local denies; denies=$(log show --start "$SCG_T0" --style syslog --predicate '(sender == "Sandbox") AND (eventMessage CONTAINS "deny(1) network-outbound")' 2>/dev/null | grep 'network-outbound' | grep -v 'unix-socket' | grep -vi 'mDNSResponder' || true)
  if [ -n "$denies" ]; then printf '%s\n' "$denies" | head -20; gate_fail "Seatbelt denied outbound network during the run ($(printf '%s\n' "$denies" | wc -l | tr -d ' ') events)"; else echo "seatbelt: 0 outbound denies in the system log since $SCG_T0"; fi
}

mkdir -p "$REAL_HOME/.cache/scg"
GATE_ROOT=$(mktemp -d "$REAL_HOME/.cache/scg/r.XXXXXX") || { echo "REFUSING: cannot create the run root"; exit 93; }
GATE_ROOT_LEN=$(printf %s "$GATE_ROOT" | wc -c | tr -d ' ')
[ "$GATE_ROOT_LEN" -lt 40 ] || { echo "REFUSING: run root $GATE_ROOT is $GATE_ROOT_LEN bytes (>= 40)"; rm -rf "$GATE_ROOT"; exit 93; }
home_snap "$GATE_ROOT/sb"; why=$(home_valid "$GATE_ROOT/sb") || { echo "REFUSING: before-sentinel invalid: $why"; rm -rf "$GATE_ROOT"; exit 92; }
touch "$GATE_ROOT/lib.marker"; sleep 1
lib_snap "$GATE_ROOT/lb"; why=$(lib_valid "$GATE_ROOT/lb") || { echo "REFUSING: ~/Library before-sentinel invalid: $why"; rm -rf "$GATE_ROOT"; exit 92; }
export HOME=$GATE_ROOT/h TMPDIR=$GATE_ROOT/t TMP=$GATE_ROOT/t TEMP=$GATE_ROOT/t
export XDG_CONFIG_HOME=$HOME/.config XDG_DATA_HOME=$HOME/.local/share XDG_CACHE_HOME=$HOME/.cache XDG_STATE_HOME=$HOME/.local/state XDG_RUNTIME_DIR=$GATE_ROOT/r
export HIVE_REAL_HOME=$HOME
export CLAUDE_CONFIG_DIR=$HOME/.claude CODEX_HOME=$HOME/.codex GROK_HOME=$HOME/.grok OPENCODE_CONFIG_DIR=$HOME/.config/opencode KIMI_CODE_HOME=$HOME/.kimi CURSOR_CONFIG_DIR=$HOME/.cursor
mkdir -p "$HOME" "$TMPDIR" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME" "$XDG_RUNTIME_DIR" "$CLAUDE_CONFIG_DIR" "$CODEX_HOME"
chmod 700 "$XDG_RUNTIME_DIR"
export npm_config_cache=$REAL_HOME/.npm npm_config_store_dir=$REAL_HOME/Library/pnpm/store
SCG_PS_SHIM=$GATE_ROOT/bin
mkdir -p "$SCG_PS_SHIM" && cp /bin/ps "$SCG_PS_SHIM/ps" && chmod 755 "$SCG_PS_SHIM/ps" && codesign --remove-signature "$SCG_PS_SHIM/ps" && codesign -f -s - "$SCG_PS_SHIM/ps" 2>/dev/null || { echo "REFUSING: cannot build the non-setuid ps shim (Seatbelt refuses setuid /bin/ps)"; rm -rf "$GATE_ROOT"; exit 94; }
export PATH="$SCG_PS_SHIM:$PATH"
SOCK_LEN=$(printf %s "$TMPDIR/hb-v2-daemon-XXXXXX/hived.sock" | wc -c | tr -d ' ')
[ "$SOCK_LEN" -lt 104 ] || { echo "REFUSING: test socket path would be $SOCK_LEN bytes (>= 104)"; rm -rf "$GATE_ROOT"; exit 94; }
export SCG_TRAP=$GATE_ROOT/net-trap.mjs SCG_NET_VIOLATIONS=$GATE_ROOT/net-violations
write_net_trap "$SCG_TRAP"; : > "$SCG_NET_VIOLATIONS"
gate_descendants() { local kids; kids=$(pgrep -P "$1" 2>/dev/null); for k in $kids; do echo "$k"; gate_descendants "$k"; done; }
gate_reap() {
  local me=$$ pids p left=""
  pids=$( { pgrep -f "$GATE_ROOT" 2>/dev/null; gate_descendants $me; } | sort -u | grep -vx "$me" | grep -vx "$PPID")
  pids=$(for p in $pids; do ps -p $p >/dev/null 2>&1 && echo $p; done)
  echo "== REAP: $(echo $pids | wc -w | tr -d ' ') process(es) tied to $GATE_ROOT or this gate's tree"
  [ -z "$pids" ] && return 0
  kill -TERM $pids 2>/dev/null; for i in 1 2 3 4 5 6 7 8 9 10; do left=$(for p in $pids; do ps -p $p >/dev/null 2>&1 && echo $p; done); [ -z "$left" ] && break; sleep 1; done
  [ -n "$left" ] && { kill -KILL $left 2>/dev/null; echo "   KILL after 10s: $left"; }
}
gate_finish() {
  local rc=$? why
  [ $rc -eq 0 ] && [ $SCG_RC -ne 0 ] && rc=$SCG_RC
  [ -n "${SCG_CENSUS_PID:-}" ] && { pkill -P "$SCG_CENSUS_PID" 2>/dev/null; kill "$SCG_CENSUS_PID" 2>/dev/null; }
  gate_reap
  [ -n "${SCG_T0:-}" ] && net_verdict
  echo "== Claude CLI census: $(awk '{print $2}' "$GATE_ROOT/claude.census" 2>/dev/null | sort | uniq -c | tr -s ' ' | tr '\n' ';')"
  home_snap "$GATE_ROOT/sa"
  if why=$(home_valid "$GATE_ROOT/sa"); then
    echo "== HOME sentinel (real HOME top level, ~/.hive/v2, live socket)"
    if diff "$GATE_ROOT/sb.ids" "$GATE_ROOT/sa.ids"; then echo "(no change)"; else gate_fail "real HOME / ~/.hive/v2 / socket changed"; fi
  else gate_fail "HOME after-sentinel invalid: $why"; fi
  lib_snap "$GATE_ROOT/la"
  if why=$(lib_valid "$GATE_ROOT/la"); then lib_verdict "$GATE_ROOT/lb" "$GATE_ROOT/la"; else gate_fail "~/Library after-sentinel invalid: $why"; fi
  [ $rc -eq 0 ] && [ $SCG_RC -ne 0 ] && rc=95
  mkdir -p "$REAL_HOME/.cache/scg/sentinels"; for f in "$GATE_ROOT"/s[ab].* "$GATE_ROOT"/l[ab].* "$GATE_ROOT/lib.changes" "$GATE_ROOT/net-violations" "$GATE_ROOT/claude.census"; do [ -f "$f" ] && mv "$f" "$REAL_HOME/.cache/scg/sentinels/$(basename "$GATE_ROOT")-$(basename "$f")"; done
  rm -rf "$GATE_ROOT"
  echo "== GATE RESULT: $([ $rc -eq 0 ] && echo PASS || echo "FAIL (rc=$rc)") · $SCG_GATE_VERSION · forage run $(basename "$SCG_FORAGE_JOB") · lane $SCG_LANE · snapshot $SCG_SNAPSHOT${SCG_SOURCE_SHA:+ · source $SCG_SOURCE_SHA}${SCG_SCRIPTS:+ · scripts $SCG_SCRIPTS}"
  exit $rc
}
trap gate_finish EXIT
SCG_GATE_PID=$$; : > "$GATE_ROOT/claude.census"; claude_census & SCG_CENSUS_PID=$!; disown "$SCG_CENSUS_PID"
echo "$SCG_GATE_VERSION: host=$(hostname -s) forage-run=$(basename "$SCG_FORAGE_JOB") lane=$SCG_LANE snapshot=$SCG_SNAPSHOT${SCG_SOURCE_SHA:+ source=$SCG_SOURCE_SHA}${SCG_SCRIPTS:+ scripts=[$SCG_SCRIPTS]} root=$GATE_ROOT (${GATE_ROOT_LEN}B) socket-probe=${SOCK_LEN}B node=$NODE_BIN $(node -v) env-vars=$(env | wc -l | tr -d ' ') HIVE_/APIARY_=[$(env | grep -E '^(HIVE_|APIARY_)' | tr '\n' ' ')]"
gate_lockdown() {
  net_probe
  : > "$SCG_NET_VIOLATIONS"; sleep 1
  SCG_T0=$(date '+%Y-%m-%d %H:%M:%S')
  export SCG_T0 NODE_OPTIONS="--import=$SCG_TRAP" GIT_ALLOW_PROTOCOL=file npm_config_offline=true npm_config_update_notifier=false npm_config_audit=false npm_config_fund=false \
    HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 ALL_PROXY=http://127.0.0.1:9 http_proxy=http://127.0.0.1:9 https_proxy=http://127.0.0.1:9 NO_PROXY=localhost,127.0.0.1,::1 no_proxy=localhost,127.0.0.1,::1
  echo "== LOCKDOWN armed at $SCG_T0: Seatbelt profile for sb(), Node trap via NODE_OPTIONS, GIT_ALLOW_PROTOCOL=file, proxies -> 127.0.0.1:9"
}
sb() { sandbox-exec -p "$SCG_SB_PROFILE" "$@"; }
deps_check() { if [ -L node_modules ]; then echo "REFUSING: node_modules is a symlink"; exit 91; fi; }
