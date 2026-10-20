import assert from "node:assert/strict";
import {openCoreStore} from '../../v2/core/src/index.ts';
import {DaemonCore} from '../../v2/daemon/src/loops.ts';
import {FakeDriver} from '../../v2/daemon/tests/helpers.ts';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
Math.random=()=>0.5;
let clock=1000; const now=()=>clock;
const root=mkdtempSync(join(process.env.TMPDIR,'h1-'));
const store=openCoreStore(join(root,'core.sqlite3'),{now,ephemeral:true});
const driver=new FakeDriver(now); const logs=[]; const violations=[];
const core=new DaemonCore({store,driver,now,log:x=>logs.push({at:clock,op:x}),onI1Violation:x=>violations.push(x),policy:{bootHangTimeoutSteps:50000,commandsPerStep:8,i1DeadlineSteps:540000}});
core.boot(); store.createBee({id:'lab',name:'lab',agent:'stub',substrate:'hsr',cwd:root}); store.enqueueCommand('spawn','lab');core.step();core.step();core.step();
driver.acceptDeliveries=false;
const msg=store.send('lab','owned fixture').message;
for(let i=0;i<300;i++){core.step();clock+=200;}
console.log(JSON.stringify({case:'refusal-cadence',ticks:300,attempts:logs.filter(x=>x.op.startsWith('deliver.refused')),pending:store.getMessage(msg.id).deliveredAt===null}));
for(let i=0;i<2701;i++){core.step();clock+=200;}
console.log(JSON.stringify({case:'bounded-retry-and-i1',attempts:logs.filter(x=>x.op.startsWith('deliver.refused')).map(x=>x.at),violations:violations.length}));
if(violations.length!==1) throw Error('I1 alert missing');
const attempts=logs.filter(x=>x.op.startsWith('deliver.refused'));assert(attempts.length<40);for(let i=1;i<attempts.length;i++)assert(attempts[i].at-attempts[i-1].at<=30200);
driver.events.push({beeId:'lab',generation:1,kind:'turn_started'}); core.step();clock+=200;
driver.acceptDeliveries=true;driver.events.push({beeId:'lab',generation:1,kind:'turn_ended'}); core.step();
assert.notEqual(store.getMessage(msg.id).deliveredAt,null);
console.log(JSON.stringify({case:'busy-to-idle',delivered:store.getMessage(msg.id).deliveredAt!==null,at:clock}));
const pages=store.db.prepare('PRAGMA page_count').get().page_count;
store.db.exec(`PRAGMA max_page_count=${pages}`);
let full=false;
try {store.send('lab','x'.repeat(8*1024*1024));} catch(e) {full=/full/i.test(e.message); console.log(JSON.stringify({case:'owned-sqlite-full',full,message:e.message}));}
if(!full) throw Error('FULL not reproduced');
store.db.exec('PRAGMA max_page_count=1073741823');
const recovered=store.send('lab','space returned').message;core.step();
assert.notEqual(store.getMessage(recovered.id).deliveredAt,null);assert.equal(store.quickCheck().ok,true);
console.log(JSON.stringify({case:'recovery-integrity',delivered:store.getMessage(recovered.id).deliveredAt!==null,check:store.quickCheck(),restart:false}));
store.close();
