// Disposable H10 retained-memory ruler. Source HSR and a real owned runner host.
// Usage: node TOOL beforeRoot afterRoot out.json control|candidate|default none|snapshot 0,10000,100000
// control: byte-identical runtime roots, omitted history option on both.
// candidate: exact driver.ts + daemon.ts runtime delta, after passes false.
// default: the same A/B sources, omitted option on both (compatibility control).
// Numeric readings describe the DRIVER process only, after best-effort GC.
// They exclude runner/agent processes and are not an exact Map/RSS attribution.
// Snapshot mode is diagnostic-only throughout and emits no derived differences.
// This small-integer, non-confirming fixture proves one retention mechanism;
// confirming acknowledgements, Cell wiring, and lifecycle parity need separate tests.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {existsSync,readFileSync,writeFileSync,mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir,hostname,loadavg} from 'node:os';
import {resolve,join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {setTimeout as delay,setImmediate as yieldTurn} from 'node:timers/promises';
import {writeHeapSnapshot} from 'node:v8';

const hash=b=>createHash('sha256').update(b).digest('hex');
const tool=fileURLToPath(import.meta.url);
const toolSha256=hash(readFileSync(tool));
const git=(root,...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:32*1024*1024});
function fingerprint(root){
  assert.equal(git(root,'status','--porcelain').trim(),'','root must be clean');
  const paths=git(root,'ls-files','v2','package.json','package-lock.json').trim().split('\n')
    .filter(p=>(p.includes('/src/')&&/\.(ts|js|mjs|json)$/.test(p))||p.endsWith('package.json')||p==='package-lock.json');
  return {revision:git(root,'rev-parse','HEAD').trim(),hashes:Object.fromEntries(paths.map(p=>[p,hash(readFileSync(join(root,p)))]))};
}
const boot=()=>execFileSync('/usr/sbin/sysctl',['-n','kern.boottime'],{encoding:'utf8'}).trim();
const identity=()=>({hostname:hostname(),boot:boot(),node:process.version,executable:realpathSync(process.execPath),executableSha256:hash(readFileSync(process.execPath))});
const gcProtocol='3 x gc(), timer turn after each, then another timer turn before memoryUsage';
const ready=JSON.stringify({event:'ready',sessionId:'history-probe'})+'\n';
const frame=id=>JSON.stringify({type:'message',id,body:'history-probe'})+'\n';
const agentSource=`import assert from 'node:assert/strict';
import {createInterface} from 'node:readline';
import {writeFileSync,renameSync} from 'node:fs';
import {createHash} from 'node:crypto';
const target=Number(process.env.HB_HISTORY_COUNT),path=process.env.HB_HISTORY_RECEIPT;
let count=0;const wire=createHash('sha256');
const save=()=>{writeFileSync(path+'.tmp',JSON.stringify({count,lastId:count,wireSha256:wire.copy().digest('hex')}));renameSync(path+'.tmp',path);};
save();process.stdout.write(${JSON.stringify(ready)});
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);assert.deepEqual(m,{type:'message',id:count+1,body:'history-probe'});wire.update(line+'\\n');count++;assert(count<=target);if(count===target)save();});
`;

async function child(spec){
  const {root,count,out,mode,disabled,source,hostIdentity}=spec;
  assert.equal(typeof globalThis.gc,'function');
  assert(Number.isSafeInteger(count)&&count>=0&&count<=100000);
  assert(['none','snapshot'].includes(mode));assert.equal(typeof disabled,'boolean');
  assert.deepEqual(fingerprint(root),source);assert.deepEqual(identity(),hostIdentity);
  const {HsrDriver}=await import(pathToFileURL(join(root,'v2/driver-hsr/src/index.ts')).href);
  const {stubAdapter}=await import(pathToFileURL(join(root,'v2/adapters/src/index.ts')).href);
  const dir=mkdtempSync(join(tmpdir(),'hb-history-ab-'));
  const receiptPath=join(dir,'receipt.json'),agentPath=join(dir,'agent.mjs');
  writeFileSync(agentPath,agentSource);assert.equal(hash(readFileSync(agentPath)),hash(agentSource));
  let driver=new HsrDriver({sessionLogDir:join(dir,'logs'),stopKillGraceMs:400,
    ...(disabled?{recordDeliveryHistory:false}:{}),
    resolve:()=>({adapter:stubAdapter,command:process.execPath,args:[agentPath],cwd:dir,
      env:{HB_HISTORY_COUNT:String(count),HB_HISTORY_RECEIPT:receiptPath}})});
  let host=null,stopped=false;
  const observations=[],evidence=[],sessions=[],cursors=[],phases=[],snapshots=[];
  const drain=()=>{observations.push(...driver.observe());evidence.push(...driver.observeEvidence());sessions.push(...driver.observeSessions());cursors.push(...driver.observeRecoveryCursors());};
  async function until(pred,why){const end=Date.now()+90000;while(!pred()){assert(Date.now()<end,why);await delay(10);}}
  async function memory(phase){for(let i=0;i<3;i++){globalThis.gc();await delay(0);}await delay(0);phases.push({phase,diagnosticOnly:mode==='snapshot',memoryUsage:process.memoryUsage()});}
  function history(){
    if(disabled){
      const error={name:'Error',message:'delivery history recording is disabled for this driver'};
      assert.throws(()=>driver.consumedCount(),error);assert.throws(()=>driver.consumedGeneration(1),error);
      assert.equal(Reflect.get(driver,'consumed'),null);
    }else{
      assert.equal(driver.consumedCount(),count);
      for(let id=1;id<=count;id++)assert.equal(driver.consumedGeneration(id),1);
    }
  }
  // No references to ManagedProcess/socket escape this frame into a heap reading.
  function liveState(){
    const procs=Reflect.get(driver,'procs');assert(procs instanceof Map);assert.equal(procs.size,1);
    const p=procs.get('history-probe');assert(p&&typeof p==='object');
    const r={};
    for(const key of ['pendingDeliveries','confirmedDeliveries']){const v=Reflect.get(p,key);assert(v instanceof Set);r[key]=v.size;}
    for(const key of ['pendingWrites','outboundPending']){const v=Reflect.get(p,key);assert(Array.isArray(v));r[key]=v.length;}
    const rest=Reflect.get(p,'stdoutRest');assert(Buffer.isBuffer(rest));r.stdoutRest=rest.length;
    const socket=Reflect.get(p,'socket');assert(socket&&typeof socket==='object');
    r.socketWritableLength=Reflect.get(socket,'writableLength');assert.equal(typeof r.socketWritableLength,'number');
    r.legacySharedObservation=Reflect.get(p,'legacySharedObservation');assert.equal(r.legacySharedObservation,false);
    return r;
  }
  function snapshot(phase){const path=out+'.'+phase+'.heapsnapshot';assert(!existsSync(path));writeHeapSnapshot(path);snapshots.push({phase,path,bytes:readFileSync(path).length,sha256:hash(readFileSync(path))});}
  function wireProof(){
    const expectedWire=createHash('sha256'),expectedLog=createHash('sha256').update(ready);
    for(let id=1;id<=count;id++){const line=frame(id);expectedWire.update(line);expectedLog.update(line);}
    const receipt=JSON.parse(readFileSync(receiptPath,'utf8'));
    assert.deepEqual(receipt,{count,lastId:count,wireSha256:expectedWire.digest('hex')});
    const transcriptSha256=hash(readFileSync(driver.sessionLogPath('history-probe')));
    assert.equal(transcriptSha256,expectedLog.digest('hex'));
    assert.equal(readFileSync(driver.observationLogPath('history-probe',1),'utf8'),ready);
    return {receipt,transcriptSha256,observationSha256:hash(ready)};
  }
  try{
    await memory('constructed');driver.start('history-probe',1);host=driver.procOf('history-probe',1);
    assert(host&&Number.isInteger(host.pid)&&host.pid>0&&Number.isFinite(host.pidStartedAt));
    assert.equal(host.observationCursor,0);
    await until(()=>{drain();return observations.some(e=>e.kind==='booted'&&!e.synthetic);},'boot witness');
    await memory('booted');
    let retries=0;
    for(let id=1;id<=count;id++){
      await until(()=>{const r=driver.deliver('history-probe',1,id,'history-probe');
        if(r.accepted){assert.deepEqual(r,{accepted:true});return true;}
        assert.deepEqual(r,{accepted:false,reason:'not_ready'});retries++;drain();return false;},'delivery accept');
      if(id%1000===0)await yieldTurn();
    }
    await until(()=>{drain();return JSON.parse(readFileSync(receiptPath,'utf8')).count===count;},'exact agent receipt');
    await until(()=>{drain();const r=liveState();return Object.entries(r).every(([k,v])=>k==='legacySharedObservation'?v===false:v===0);},'drained protocol and socket');
    const protocolAtRead=liveState(),wire=wireProof();history();drain();
    await memory('deliveredAndDrained');
    assert.deepEqual(driver.stop('history-probe',1,'stopped_by_system'),{hadProcess:true});
    await until(()=>{drain();return observations.some(e=>e.kind==='exited');},'exact host exit');stopped=true;
    assert.equal(driver.hasProcess('history-probe',1),false);history();
    const procs=Reflect.get(driver,'procs');assert(procs instanceof Map);assert.equal(procs.size,0);
    const normalized=observations.map(e=>{
      const copy={...e};
      if('pid' in copy){assert.equal(copy.pid,host.pid);delete copy.pid;}
      if('pidStartedAt' in copy){assert.equal(copy.pidStartedAt,host.pidStartedAt);delete copy.pidStartedAt;}
      return copy;
    });
    const semantics={observations:normalized,evidence,sessions,cursors,wire,protocolAtRead};
    await memory('stopped');if(mode==='snapshot')snapshot('stopped');
    driver=null;await yieldTurn();await memory('released');if(mode==='snapshot')snapshot('released');
    assert.deepEqual(fingerprint(root),source);assert.deepEqual(identity(),hostIdentity);assert.equal(hash(readFileSync(tool)),toolSha256);
    return {completed:true,root,source,count,disabled,mode,host,retries,semantics,phases,snapshots,gcProtocol,toolSha256,agentSourceSha256:hash(agentSource)};
  }finally{
    if(driver&&!stopped){driver.disposeAll();await until(()=>{drain();return !driver.hasProcess('history-probe',1);},'owned host cleanup');}
    rmSync(dir,{recursive:true,force:true});
  }
}

if(process.argv[2]==='--child'){
  const spec=JSON.parse(readFileSync(process.argv[3],'utf8'));
  assert(!existsSync(spec.out));
  try{writeFileSync(spec.out,JSON.stringify(await child(spec),null,2)+'\n');}
  catch(error){writeFileSync(spec.out,JSON.stringify({completed:false,error:String(error),stack:error.stack},null,2)+'\n');throw error;}
}else{
  const [before,after,outArg,comparison,mode,countsArg]=process.argv.slice(2);
  assert(before&&after&&outArg&&countsArg);assert(['control','candidate','default'].includes(comparison));assert(['none','snapshot'].includes(mode));
  const roots=[before,after].map(p=>realpathSync(p)),out=resolve(outArg);assert.notEqual(...roots);assert(!existsSync(out));
  const counts=countsArg.split(',').map(Number);assert(counts.length>0&&new Set(counts).size===counts.length);assert(counts.every(n=>Number.isSafeInteger(n)&&n>=0&&n<=100000));
  const sources=roots.map(fingerprint),hostIdentity=identity();
  assert.deepEqual(Object.keys(sources[0].hashes),Object.keys(sources[1].hashes));
  const changed=Object.keys(sources[0].hashes).filter(p=>sources[0].hashes[p]!==sources[1].hashes[p]).sort();
  assert.deepEqual(changed,comparison==='control'?[]:['v2/daemon/src/daemon.ts','v2/driver-hsr/src/driver.ts']);
  const result={completed:false,comparison,mode,roots,sources,changed,hostIdentity,toolSha256,agentSourceSha256:hash(agentSource),gcProtocol,counts,order:[0,1,1,0],loadBefore:loadavg(),runs:[],
    scope:'Source HSR driver process only; independent serial ABBA children, two children per side per count. Whole-process heap/RSS occupancy after best-effort GC, not exact Map bytes or whole daemon/host/agent memory. Snapshot readings are diagnostic only, with no numeric differences. No CPU/timing claims. Small integer IDs 1..N and generation 1; non-confirming stub protocol only. Separate default, acknowledgement, lifecycle, Cell and actual-daemon tests are required.'};
  const env={...process.env};for(const key of ['HIVE_PARENT','HIVE_SPAWN_TRACE','NODE_OPTIONS'])delete env[key];
  try{
    for(const count of counts){
      let expectedSemantics;
      for(const [orderIndex,side] of result.order.entries()){
        const childOut=`${out}.n${count}.run${orderIndex}.json`,specPath=childOut+'.spec.json';
        const spec={root:roots[side],count,out:childOut,mode,disabled:comparison==='candidate'&&side===1,source:sources[side],hostIdentity};
        assert(!existsSync(specPath));writeFileSync(specPath,JSON.stringify(spec,null,2)+'\n');
        const r=spawnSync(process.execPath,['--expose-gc',tool,'--child',specPath],{env,encoding:'utf8',maxBuffer:16*1024*1024,timeout:600000});
        writeFileSync(childOut+'.log',(r.stdout??'')+(r.stderr??''));
        assert.equal(r.status,0,`${childOut}: ${r.error??r.stderr}`);
        const value=JSON.parse(readFileSync(childOut,'utf8'));assert.equal(value.completed,true);
        if(expectedSemantics===undefined)expectedSemantics=value.semantics;else assert.deepEqual(value.semantics,expectedSemantics,'cross-process observable parity');
        const run={side,orderIndex,count,path:childOut,sha256:hash(readFileSync(childOut)),value};
        if(mode==='none'){
          const from=value.phases.find(p=>p.phase==='constructed').memoryUsage;
          run.wholeProcessDifferencesFromConstructed=value.phases.map(p=>({phase:p.phase,differences:Object.fromEntries(Object.keys(from).map(k=>[k,p.memoryUsage[k]-from[k]]))}));
        }
        result.runs.push(run);console.log(JSON.stringify({count,side,orderIndex,completed:true}));
      }
    }
    assert.deepEqual(roots.map(fingerprint),sources);assert.deepEqual(identity(),hostIdentity);assert.equal(hash(readFileSync(tool)),toolSha256);
    result.completed=true;result.loadAfter=loadavg();
  }catch(error){result.error=String(error);throw error;}
  finally{writeFileSync(out,JSON.stringify(result,null,2)+'\n');}
}
