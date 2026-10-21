import json,pathlib
base=pathlib.Path('.proof/H2B')
rows=[]
def blocks(value,kind):
 if isinstance(value,dict):
  if value.get('type')==kind: yield value
  for child in value.values(): yield from blocks(child,kind)
 elif isinstance(value,list):
  for child in value: yield from blocks(child,kind)
for directory in sorted(base.glob('*-*-*')):
 p=directory/'events.jsonl'
 if not p.is_file():continue
 events=[json.loads(l) for l in p.read_text().splitlines()]
 cli,mode=directory.name.split('-')[:2]
 wires=[e for e in events if e['kind']=='honeybee-wire']
 human=next((e for e in wires if e['data']['body']=='HUMAN_SENTINEL'),None)
 completions=[e for e in events if e['kind']=='stdout' and (e['data'].get('type')=='result' or e['data'].get('method')=='turn/completed')]
 before=[e for e in completions if human and e['ms']<=human['ms']]
 providers=[e for e in events if e['kind']=='provider-request']
 after=[e for e in providers if human and e['ms']>=human['ms']]
 outputs=[b for e in after for kind in ['tool_result','function_call_output'] for b in blocks(e['data'],kind)]
 final=next((e['data'] for e in events if e['kind']=='final-mailbox'),[])
 background=next((m for m in final if m['body']=='BACKGROUND_SENTINEL'),None)
 passed=bool(human and before and len(completions)==2 and outputs and any('TOOL_RESULT_SENTINEL' in json.dumps(b) for b in outputs) and all('HUMAN_SENTINEL' not in json.dumps(b) for b in outputs) and background and background['deliveredAt'] is None and not any(e['kind']=='timeout' for e in events))
 row={'fixture':directory.name,'cli':cli,'mode':mode,'scope':'stock CLI + local fixture provider + real CoreStore/DaemonCore/FakeDriver; not real accounts or model ack','passedNaturalIdle':passed,'humanWireMs':human['ms'] if human else None,'nativeCompletionsBeforeHumanWire':len(before),'nativeCompletions':len(completions),'toolResultInHumanContext':any('TOOL_RESULT_SENTINEL' in json.dumps(b) for b in outputs),'humanOutsideToolResult':bool(outputs) and all('HUMAN_SENTINEL' not in json.dumps(b) for b in outputs),'backgroundPending':bool(background and background['deliveredAt'] is None),'wireOrder':[e['data']['body'] for e in wires],'timeout':any(e['kind']=='timeout' for e in events),'evidence':str(p)}
 if mode=='off':row['policyOffLegacy']=bool(human and not before and len(row['wireOrder'])==2 and row['wireOrder'][0].endswith('BACKGROUND_SENTINEL') and row['wireOrder'][1]=='HUMAN_SENTINEL')
 if mode=='probe':
  request=next(e for e in events if e['kind']=='stdin' and 'ACTIVE_START_PROBE' in json.dumps(e['data']))
  response=next(e for e in events if e['kind']=='stdout' and e['data'].get('id')==request['data']['id'])
  initial=next(e for e in events if e['kind']=='stdout' and e['data'].get('id')==3)
  row['activeStartAcceptedIntoExistingTurn']=response['data']['result']['turn']['id']==initial['data']['result']['turn']['id']
 rows.append(row)
report={
 'notCheckedOnRealData':True,
 'versions':{'claude':'2.1.305','codex':'0.163.0','node':'24.18.0'},
 'strictNativeFreshTurnFence':'UNPROVEN: Claude self-wake and Codex turn/start steering active-turn race; do not enable strict guarantee',
 'actualDaemon':{'evidence':'.proof/H2B/daemon-run.json','passed':json.loads((base/'daemon-run.json').read_text())['passed'],'scope':'disposable actual Honeybee RPC server + stub HSR; separate from stock CLI/FakeDriver provider-context fixtures'},
 'independentReview':{'model':'claude-opus-5-5','sessionId':'60df3153-1702-45ab-a467-ec6395e413cb','sourceHead':'ca9d21d9','mediumOrHigherFindingsRemaining':0},
 'attention':['Native admission is not atomically fenced; DP3 is still open.','The in-memory human-policy I1 eligibility clock resets across daemon restart, undercounting an already overdue eligible row.','Policy-off keeps the legacy I1 quota clock; policy-enabled holds use the new suspension.','Schema48 draft fixtures made before the review FK fix should be recreated; no production rollout occurred.','The repository has no verification skill; existing daemon/driver footholds were used.','A held core seed blocks all other mail until its hold resolves.','Recovery copies share the original authorityId/admissionId without a new admission or receivedAt.','Seed lookup runs an incremental history backfill transaction on the policy-enabled read path.','Perf-map drift contains unaccounted entries and stale owners; no latency or performance improvement is claimed.'],
 'gateReceipt':json.loads((base/'gate-receipt.json').read_text()),
 'verification':[{'evidence':str(base/name),'exit0':'forage: exit 0' in (base/name).read_text()} for name in ['linux-gates-canonical.log','final-focused-clean.log']],
 'runs':rows}

(base/'summary.json').write_text(json.dumps(report,indent=2)+'\n')
for row in rows:print(row['fixture'], 'native-idle='+str(row['passedNaturalIdle']), 'completions='+str(row['nativeCompletions']), 'backgroundPending='+str(row['backgroundPending']), 'timeout='+str(row['timeout']))
assert all(any(r['cli']==cli and r['mode']==mode and r['passedNaturalIdle'] for r in rows) for cli in ['claude','codex'] for mode in ['idle','restart'])
assert any(r.get('activeStartAcceptedIntoExistingTurn') for r in rows)
assert all(any(r['cli']==cli and r['mode']=='off' and r['policyOffLegacy'] for r in rows) for cli in ['claude','codex'])
