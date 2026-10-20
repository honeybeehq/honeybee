import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {HsrDriver} from '../../v2/driver-hsr/src/index.ts';
import {codexAdapter} from '../../v2/adapters/src/index.ts';
import {DeliveryReceipts} from '../../v2/driver-hsr/src/delivery-receipts.ts';
import {drainUntil,sleep,pidAlive,fixtureRuntimeIdentity,persistFixtureProcess} from '../../v2/driver-hsr/tests/helpers.ts';
assert(tmpdir().startsWith('/var/tmp/')||tmpdir().startsWith('/private/var/tmp/'),'set TMPDIR to an owned run root');
const root=mkdtempSync(join(tmpdir(),'h1c-receipts-'));
const fake=new URL('./h1c-fake-codex.mjs',import.meta.url).pathname;
const fault=new URL('./h1c-journal-full.mjs',import.meta.url).pathname;
const host=new URL('../../v2/driver-hsr/src/runner-host-main.ts',import.meta.url).pathname;
for(const mode of ['journal-full','missing-ack']){
 const writes=join(root,mode+'.jsonl');
 const config={sessionLogDir:join(root,mode),runnersDir:join(root,mode,'runners'),runtimeIdentity:fixtureRuntimeIdentity(root+mode),
  hostCommand:path=>({command:process.execPath,args:[...(mode==='journal-full'?['--import',fault]:[]),host,path]}),
  resolve:()=>({adapter:codexAdapter({cwd:root}),command:process.execPath,args:[fake],cwd:root,env:{...process.env,H1C_WRITES:writes,H1C_TURN_MS:'300',H1C_ACK:mode==='missing-ack'?'never':'yes'}})};
 let driver=new HsrDriver(config);let child;
 try{
  driver.start('bee',1);
  for(let i=0;i<1000;i++){driver.observe();if(driver.procs.get('bee')?.phase==='idle'&&driver.procs.get('bee')?.deliveryProtocol?.authenticated)break;await sleep(5);}
  const p=driver.procs.get('bee');child=p.pid;assert.equal(p.phase,'idle');assert.equal(p.deliveryProtocol?.authenticated,true);
  driver.deliver('bee',1,24679,'owned starter turn');
  for(let i=0;i<100&&!p.turnId;i++){driver.observe();await sleep(2);}
  assert.equal(p.phase,'running');assert(p.turnId);
  const plan=driver.planDeliveryConfirmation('bee',1,24680,'owned fixture');assert(plan);
  assert.equal(driver.deliver('bee',1,24680,'owned fixture',{confirmation:plan}).accepted,false);
  await drainUntil(driver,events=>events.some(e=>e.kind==='turn_ended'));
  assert.equal(p.phase,'idle');
  persistFixtureProcess(root+mode,'bee',1,driver.procOf('bee',1));
  driver.detachAll();
  driver=new HsrDriver(config);assert(driver.adopt('bee',1,child,p.pidStartedAt));
  let result;
  for(let i=0;i<1000;i++){driver.observe();result=driver.reconcileDeliveryConfirmation('bee',1,24680,plan);if(result===(mode==='journal-full'?'accepted':'pending_ack')&&driver.procs.get('bee')?.deliveryProtocol?.authenticated){if(mode==='journal-full')break;}await sleep(2);if(mode==='missing-ack'&&i>50)break;}
  assert.equal(result,mode==='journal-full'?'accepted':'pending_ack');
  if(mode==='missing-ack')for(let i=0;i<100;i++)driver.deliver('bee',1,24680,'owned fixture',{confirmation:plan});
  await sleep(30);
  const rows=readFileSync(writes,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter(row=>row.id===25680).length,1);
  console.log(JSON.stringify({case:mode,midTurn:true,afterTurnEnd:true,afterDaemonDetach:true,status:result,stdinWrites:1,pid:child,root}));
 }finally{driver.disposeAll();for(let i=0;i<500&&child&&pidAlive(child);i++)await sleep(10);if(child)assert.equal(pidAlive(child),false);}
}
let now=1;const receipts=new DeliveryReceipts('bee',1,()=>now,2,100);
const line=id=>JSON.stringify({id,result:null,method:'turn/start'});
const tag=id=>({id,digest:createHash('sha256').update(line(id)).digest('hex'),beeId:'bee',generation:1});
assert(receipts.begin(tag(1),line(1)));assert.equal(receipts.begin(tag(1),line(1)),false);
assert.equal(receipts.status({...tag(1),generation:2}).state,'unknown');
assert.equal(receipts.status({...tag(1),beeId:'other'}).state,'unknown');
assert.equal(receipts.status({...tag(1),digest:'0'.repeat(64)}).state,'unknown');
receipts.begin(tag(2),line(2));receipts.begin(tag(3),line(3));
assert.equal(receipts.status(tag(1)).state,'unknown');now=102;
assert.equal(receipts.status(tag(3)).state,'unknown');assert.equal(receipts.begin(tag(3),line(3)),false);
console.log(JSON.stringify({case:'bounded-retention-and-fences',countEviction:'unknown',ageEviction:'unknown',wrongGeneration:'unknown',wrongBee:'unknown',digestMismatch:'unknown',agedOutWrites:0}));
