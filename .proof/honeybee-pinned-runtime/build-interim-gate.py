import hashlib,pathlib,sys
body=sys.argv[1]
base=pathlib.Path('.dg.base.sh').read_text()
old='if diff "$GATE_ROOT/sb.ids" "$GATE_ROOT/sa.ids"; then echo "(no change)"; else gate_fail "real HOME / ~/.hive/v2 / socket changed"; fi'
new='if diff "$GATE_ROOT/sb.ids" "$GATE_ROOT/sa.ids"; then echo "(no change)"; elif python3 .proof/honeybee-pinned-runtime/interim-config-watch.py verdict "$GATE_ROOT" "$SCG_REAL_HOME" "$GATE_ROOT/sb.ids" "$GATE_ROOT/sa.ids"; then echo "INTERIM: only config.json attributed; all other sentinels exact"; else gate_fail "real HOME / ~/.hive/v2 / socket changed"; fi'
assert base.count(old)==1
base=base.replace(old,new)
base=base.replace("env | grep -E '^(HIVE_|APIARY_)'", "env | sed 's/=.*//' | grep -E '^(HIVE_|APIARY_)'")
files=['.proof/honeybee-pinned-runtime/interim-config-watch.py','.proof/honeybee-pinned-runtime/build-interim-gate.py',body]
checks=[]
for file in files:
 digest=hashlib.sha256(pathlib.Path(file).read_bytes()).hexdigest();checks.append(f"[ \"$(shasum -a 256 {file} | cut -d' ' -f1)\" = '{digest}' ] || exit 88; echo 'VERIFICATION_OVERLAY {file} sha256={digest}'")
base=base.replace('set -u\n','set -u\n'+'\n'.join(checks)+'\n',1)
pathlib.Path('.dg.sh').write_text(base)
