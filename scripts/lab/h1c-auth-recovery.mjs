import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,renameSync,existsSync} from 'node:fs';
import {join} from 'node:path';
assert(process.env.TMPDIR?.startsWith('/var/tmp/'));
const root=mkdtempSync(join(process.env.TMPDIR,'h1c-auth-'));
process.env.H1C_AUTH_FAULT=join(root,'fault');
await import('./h1c-peer-auth-fault.mjs');
const {openCoreStore}=await import('../../v2/core/src/index.ts');
const {DaemonCore}=await import('../../v2/daemon/src/loops.ts');
const {HsrDriver}=await import('../../v2/driver-hsr/src/index.ts');
const {codexAdapter}=await import('../../v2/adapters/src/index.ts');
const {fixtureRuntimeIdentity,sleep,pidAlive}=await import('../../v2/driver-hsr/tests/helpers.ts');
let clock=Date.now();const store=openCoreStore(join(root,'core.sqlite'),{now:()=>clock});const writes=join(root,'writes');
const driver=new HsrDriver({now:()=>clock,random:()=>0.5,sessionLogDir:join(root,'logs'),runnersDir:join(root,'runners'),runtimeIdentity:fixtureRuntimeIdentity(root),resolve:()=>({adapter:codexAdapter({cwd:root}),command:process.execPath,args:[new URL('./h1c-fake-codex.mjs',import.meta.url).pathname],cwd:root,env:{...process.env,H1C_WRITES:writes}})});
const logs=[];const core=new DaemonCore({store,driver,now:()=>clock,random:()=>0.5,policy:{bootHangTimeoutSteps:500_000,commandsPerStep:8,i1DeadlineSteps:540_000},log:line=>logs.push(line)});let pid;
try{
 core.boot();store.createBee({id:'bee',name:'owned-auth',agent:'codex',substrate:'hsr',cwd:root});store.enqueueCommand('spawn','bee');core.step();
 for(let i=0;i<1000&&!(driver.deliveryLaneReady('bee',1)&&driver.procs.get('bee')?.sessionId);i++){clock+=100;core.step();await sleep(5);}
 assert(driver.deliveryLaneReady('bee',1));writeFileSync(process.env.H1C_AUTH_FAULT,'owned peer inspection fault');driver.procs.get('bee').socket.destroy();
 for(let i=0;i<1000&&driver.procs.get('bee')?.authFailureSince===undefined;i++){clock+=1;core.step();await sleep(5);}
 const p=driver.procs.get('bee');pid=p.pid;assert.notEqual(p.authFailureSince,undefined);assert.equal(p.socket,null);
 const message=store.send('bee','owned auth failure recovery').message;
 for(let i=0;i<230;i++){clock+=1;core.step();await sleep(5);}
 const attempts=p.authFailures;assert(attempts>=2&&attempts<=4);assert.equal(store.getDeliveryConfirmationIntent(message.id),null);assert.equal(existsSync(writes),false);
 clock+=31_000;for(let i=0;i<500&&store.getMessage(message.id)?.deliveryConfirmation?.reason!=='host_auth_failed';i++){clock+=200;core.step();await sleep(2);}
 assert.equal(store.getMessage(message.id).deliveryConfirmation.reason,'host_auth_failed');assert.equal(store.view('bee').waitingForYou,true);assert.equal(existsSync(writes),false);
 renameSync(process.env.H1C_AUTH_FAULT,join(root,'fault-trashed'));
 for(let i=0;i<3000&&store.getMessage(message.id)?.deliveredAt===null;i++){clock+=100;core.step();await sleep(5);}
 assert.notEqual(store.getMessage(message.id).deliveredAt,null);assert.equal(store.getDeliveryConfirmationIntent(message.id),null);
 assert.equal(readFileSync(writes,'utf8').trim().split('\n').length,1);
 console.log(JSON.stringify({case:'authenticated-lane-recovery',failedAttemptsIn1second:attempts,closedOnAuthFailure:true,planRefusalsLogged:logs.some(line=>line.includes('confirmation_plan_not_ready')),heldReason:'host_auth_failed',visibleAfter30s:true,deliveredAfterRecovery:true,stdinWrites:1,root}));
}catch(error){console.error(error);throw error;}
finally{driver.disposeAll();if(pid&&pidAlive(pid)&&driver.procs.get('bee')?.child?.exitCode===null)process.kill(-pid,'SIGKILL');for(let i=0;i<500&&pid&&pidAlive(pid);i++)await sleep(10);store.close();if(pid)assert.equal(pidAlive(pid),false);}
