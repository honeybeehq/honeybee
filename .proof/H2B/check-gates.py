import json,pathlib,re
base=pathlib.Path('.proof/H2B')
read=lambda name:(base/name).read_text()
focused=read('final-focused-clean.log')
prefix=read('linux-gates-canonical.log')
socket=read('socket-fixture.log')
tail=read('daemon-tail.log')
assert 'forage: exit 0' in focused
assert 'forage: exit 0' in socket and 'ℹ tests 7' in socket and 'ℹ pass 7' in socket
assert 'forage: exit 0' in tail
assert re.findall(r'ℹ fail ([1-9][0-9]*)',prefix)==['3']
assert not re.findall(r'ℹ fail ([1-9][0-9]*)',focused+socket+tail)
failures=[line for line in prefix.splitlines() if line.startswith('✖ ') and line!='✖ failing tests:']
allowed=['✖ socket placement: a deep data dir moves every socket','✖ socket placement: a recorded dir that is world-writable','✖ a daemon on a deep data dir listens on a short socket']
assert failures and all(any(line.startswith(name) for name in allowed) for line in failures)
remaining=next(json.loads(line)['remainingFiles'] for line in tail.splitlines() if line.startswith('{"remainingFiles"'))
expected=sorted([str(p) for p in pathlib.Path('v2/daemon/tests').glob('*.test.ts') if p.name>'socket-path.test.ts']+[str(p) for p in pathlib.Path('v2/cli/tests').glob('*.test.ts')])
assert remaining==expected
result={
 'passed':True,
 'scope':'All core tests and daemon/CLI files covered across full-prefix, short-namespace socket rerun and remaining-file sweep; latest policy changes checked separately.',
 'latestFocusedSource':'ca9d21d9','fullSweepSource':'cdc8ff11',
 'fullPrefixExit':1,'fullPrefixOnlyFailures':'Three socket-path fixture assertions caused by the forensic checkout path length; not labelled a green original command.',
 'socketRerunTests':7,'remainingFiles':len(remaining),
 'evidence':['.proof/H2B/final-focused-clean.log','.proof/H2B/linux-gates-canonical.log','.proof/H2B/socket-fixture.log','.proof/H2B/daemon-tail.log'],
 'notCheckedOnRealData':True}
(base/'gate-receipt.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
