import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectProcess,sameProcess} from '../../v2/harness/src/processIdentity.ts';
const root=fileURLToPath(new URL('../../',import.meta.url));
const dir=mkdtempSync('/tmp/hbls-');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const identity=pid=>{const value=inspectProcess(pid);assert.equal(value.kind,'present');return {pid,birth:value.birth,bootId:value.bootId};};
const exited=id=>{const value=inspectProcess(id.pid);return value.kind==='gone'||value.kind==='present'&&(!sameProcess(id,value)||value.state==='zombie');};
const kill=(id,signal)=>{const value=inspectProcess(id.pid);if(value.kind==='present'&&value.state==='live'&&sameProcess(id,value))process.kill(id.pid,signal);};
async function waitFor(fn,label,ms=30000){const end=performance.now()+ms;while(!fn()){if(performance.now()>end)throw Error('timeout: '+label);await sleep(20);}}
const results=[];
for(const [signal,expected] of [['SIGINT',130],['SIGTERM',143],['SIGHUP',1]]){
 const file=join(dir,signal+'.test.mjs'),ready=join(dir,signal+'.pid');
 writeFileSync(file,`import{test}from'node:test';import{writeFileSync}from'node:fs';test('signal fixture',async()=>{writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);await new Promise(()=>{});});`);
 const child=spawn(process.execPath,[join(root,'scripts/run-node-tests.mjs'),file],{cwd:root,detached:true,stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,HOME:dir,TMPDIR:dir,HIVE_NO_KEYCHAIN:'1',HIVE_TEST_CONCURRENCY:'1'}});
 let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>output=(output+chunk).slice(-4000));
 const ended=new Promise((resolve,reject)=>{child.once('exit',(code,signal)=>resolve({code,signal}));child.once('error',reject);});
 const owned=[];
 try{
  const launcher=identity(child.pid);owned.push(launcher);
  await waitFor(()=>{if(child.exitCode!==null||child.signalCode!==null)throw Error('early exit: '+output);return existsSync(ready);},'worker ready');
  const worker=identity(Number(readFileSync(ready,'utf8')));owned.push(worker);
  const controller=identity(inspectProcess(worker.pid).ppid);owned.push(controller);
  assert.equal(inspectProcess(controller.pid).ppid,launcher.pid,'owned process ancestry');
  kill(launcher,signal);
  const result=await Promise.race([ended,new Promise((_,reject)=>setTimeout(()=>reject(Error('launcher exit: '+output)),15000).unref())]);
  assert.equal(result.code,expected);
  await waitFor(()=>exited(worker)&&exited(controller),'owned test workers exited',4000);
  results.push({signal,exitCode:result.code,launcher,controller,worker,workersExited:true});
 }finally{
  for(const id of owned.reverse())kill(id,'SIGKILL');
  await Promise.race([ended,sleep(5000)]);
 }
}
console.log(JSON.stringify({fixtureDir:dir,results},null,2));
