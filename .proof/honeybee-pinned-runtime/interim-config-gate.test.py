import json,os,pathlib,subprocess,sys,tempfile
script=pathlib.Path(__file__).with_name('interim-config-watch.py').resolve()
with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as directory:
 root=pathlib.Path(directory);before=root/'before';after=root/'after'
 baseline='# real HOME top level (inode name)\n1 config.json\n# real hive data dir (inode name)\n2 config.json\n3 hived.sock\n'
 changed=baseline.replace('2 config.json','4 config.json')
 for label,text,state,expected in [
  ('attributed config only',changed,{'lsofClean':True,'configChanges':[{}],'attributed':True},0),
  ('other file changed',changed.replace('3 hived.sock','5 hived.sock'),{'lsofClean':True,'configChanges':[{}],'attributed':True},1),
  ('HOME config outside hive',changed.replace('1 config.json','6 config.json'),{'lsofClean':True,'configChanges':[{}],'attributed':True},1),
  ('missing RPC attribution',changed,{'lsofClean':True,'configChanges':[{}],'attributed':False},1),
  ('unclean lsof',changed,{'lsofClean':False,'configChanges':[{}],'attributed':True},1),
  ('missing config observation',changed,{'lsofClean':True,'configChanges':[],'attributed':True},1)]:
  before.write_text(baseline);after.write_text(text);(root/'interim-config.json').write_text(json.dumps(state))
  result=subprocess.run([sys.executable,str(script),'verdict',str(root),'/unused',str(before),str(after)],capture_output=True)
  assert result.returncode==expected,label
  print('PASS',label)

with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as directory:
 root=pathlib.Path(directory)
 for label,state,expected in [
  ('unchanged exact config needs no lsof attribution',{'configChanges':[],'logicalEqual':True,'lsofClean':False,'attributed':True,'errors':['live_pid_unsampled']},0),
  ('changed config needs clean lsof',{'configChanges':[{}],'logicalEqual':False,'lsofClean':False,'attributed':True,'errors':[]},1),
  ('changed config needs RPC attribution',{'configChanges':[{}],'logicalEqual':False,'lsofClean':True,'attributed':False,'errors':[]},1),
  ('changed config has both conditions',{'configChanges':[{}],'logicalEqual':True,'lsofClean':True,'attributed':True,'errors':[]},0)]:
  (root/'interim-config.json').write_text(json.dumps(state))
  result=subprocess.run([sys.executable,str(script),'coverage',str(root),'/unused'],capture_output=True)
  assert result.returncode==expected,label
  print('PASS',label)
