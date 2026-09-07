import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {existsSync,readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {setTimeout as delay,setImmediate as yieldTurn} from 'node:timers/promises';
import {writeHeapSnapshot} from 'node:v8';

// Disposable structural baseline, not an A/B ruler or a canonical RAM claim.
const args=process.argv.slice(2);assert.equal(args.length,6,'--root ROOT --count N --out JSON');
assert.equal(args[0],'--root');assert.equal(args[2],'--count');assert.equal(args[4],'--out');
const root=resolve(args[1]),count=Number(args[3]),out=resolve(args[5]);
assert(Number.isSafeInteger(count)&&count>=0&&count<=100000);assert(!existsSync(out));
assert.equal(typeof globalThis.gc,'function');
assert.equal(execFileSync('git',['status','--porcelain','--untracked-files=no'],{cwd:root,encoding:'utf8'}),'');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const files=['v2/driver-hsr/src/driver.ts','v2/driver-hsr/src/runner-host.ts','v2/adapters/src/stub.ts'];
const hashes=()=>Object.fromEntries(files.map(p=>[p,sha(readFileSync(join(root,p)))]));
const initialHashes=hashes(),revision=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const toolPath=fileURLToPath(import.meta.url),toolHash=sha(readFileSync(toolPath));
const {HsrDriver}=await import(pathToFileURL(join(root,'v2/driver-hsr/src/index.ts')).href);
const {stubAdapter}=await import(pathToFileURL(join(root,'v2/adapters/src/index.ts')).href);
const dir=mkdtempSync(join(tmpdir(),'hb-driver-history-')),receipt=join(dir,'received.json'),agent=join(dir,'agent.mjs');
const agentSource=`import assert from 'node:assert/strict';
import {createInterface} from 'node:readline';
import {writeFileSync} from 'node:fs';
const target=Number(process.env.HB_HISTORY_COUNT),path=process.env.HB_HISTORY_RECEIPT;let count=0;
const save=()=>writeFileSync(path,JSON.stringify({count,lastId:count,allSequential:true,body:'history-probe'}));
save();process.stdout.write(JSON.stringify({event:'ready',sessionId:'history-probe'})+'\\n');
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);assert.equal(m.type,'message');assert.equal(m.id,count+1);assert.equal(m.body,'history-probe');count++;assert(count<=target);if(count===target)save();});
`;
writeFileSync(agent,agentSource);
let driver=new HsrDriver({sessionLogDir:join(dir,'logs'),stopKillGraceMs:400,resolve:()=>({adapter:stubAdapter,command:process.execPath,args:[agent],cwd:dir,env:{HB_HISTORY_COUNT:String(count),HB_HISTORY_RECEIPT:receipt}})});
const phases=[];let host=null;let stopped=false;
async function memory(phase){for(let i=0;i<3;i++){globalThis.gc();await delay(0);}await delay(0);phases.push({phase,diagnosticOnly:true,memoryUsage:process.memoryUsage()});}
async function until(pred,why){const end=Date.now()+60000;while(!pred()){assert(Date.now()<end,why);await delay(10);}}
try{
 await memory('constructed');driver.start('history-probe',1);host=driver.procOf('history-probe',1);assert(host&&host.pid>0);
 await until(()=>driver.observe().some(e=>e.kind==='booted'&&!e.synthetic),'boot witness');
 await memory('booted');
 // Accepted deliveries and socket/host I/O happen outside all memory sampling.
 for(let id=1;id<=count;id++){
  let accepted=false;await until(()=>{const r=driver.deliver('history-probe',1,id,'history-probe');if(r.accepted){accepted=true;return true;}assert.equal(r.reason,'not_ready');driver.observe();return false;},'delivery accept');assert(accepted);
  if(id%1000===0)await yieldTurn();
 }
 await until(()=>{driver.observe();return existsSync(receipt)&&JSON.parse(readFileSync(receipt,'utf8')).count===count;},'exact agent receipt');
 assert.deepEqual(JSON.parse(readFileSync(receipt,'utf8')),{count,lastId:count,allSequential:true,body:'history-probe'});
 assert.equal(driver.consumedCount(),count);for(let id=1;id<=count;id++)assert.equal(driver.consumedGeneration(id),1);
 assert.equal(driver.hasProcess('history-probe',1),true);driver.observe();driver.observeEvidence();driver.observeSessions();driver.observeRecoveryCursors();
 await memory('deliveredAndDrained');
 assert.deepEqual(driver.stop('history-probe',1,'stopped_by_system'),{hadProcess:true});
 await until(()=>driver.observe().some(e=>e.kind==='exited'),'host exit');stopped=true;assert.equal(driver.hasProcess('history-probe',1),false);assert.equal(driver.consumedCount(),count);
 await memory('stopped');
 writeHeapSnapshot(out+'.stopped.heapsnapshot');
 driver=null;await yieldTurn();await memory('released');
 writeHeapSnapshot(out+'.released.heapsnapshot');
 assert.deepEqual(hashes(),initialHashes);assert.equal(sha(readFileSync(toolPath)),toolHash);
 writeFileSync(out,JSON.stringify({completed:true,scope:'Studio structural baseline using public HsrDriver delivery through a real detached runner host and provider-free input-counting child. Not paired performance evidence. Memory is whole-process occupancy after best-effort GC; no exact recorder attribution. Historic count remains N after runtime stop. Snapshot-mode memory readings are diagnostic only. Stopped/released heap snapshots are for structural inspection; no numeric comparison with the none-mode probe. No provider work. Temporary fixture removed only after exact host exit.',revision,root,toolHash,sourceHashes:initialHashes,agentSourceSha256:sha(agentSource),node:process.version,count,host,phases,receipt:{count,lastId:count,allSequential:true},gcProtocol:'3 x gc, timer turn after each, then timer turn before memoryUsage'},null,2)+'\n');
 console.log(JSON.stringify({completed:true,count,phases:phases.map(p=>({phase:p.phase,heapUsed:p.memoryUsage.heapUsed,rss:p.memoryUsage.rss}))}));
}finally{
 if(driver&&!stopped){driver.disposeAll();await until(()=>{driver.observe();return !driver.hasProcess('history-probe',1);},'fixture cleanup');}
 rmSync(dir,{recursive:true,force:true});
}
