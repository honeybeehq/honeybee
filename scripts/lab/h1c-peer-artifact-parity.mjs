import assert from 'node:assert/strict';
import {mkdtempSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
assert(process.env.TMPDIR?.startsWith('/var/tmp/'));
const source=process.argv[2],harness=process.argv[3];assert(source&&(source===process.cwd()||source.startsWith(process.env.TMPDIR+'/')));assert(['claude','codex'].includes(harness));
const root=mkdtempSync(join(process.env.TMPDIR,'h1c-peer-parity-')),writes=join(root,'writes');
const peerOnly=process.argv.includes('--peer-only');
if(peerOnly){assert.equal(harness,'claude');process.env.H1C_AUTH_FAULT=join(root,'peer-fault');writeFileSync(process.env.H1C_AUTH_FAULT,'owned peer-only fault');await import('./h1c-peer-auth-fault.mjs');}
else await import('./h1c-missing-peer-artifact.mjs');
const {HsrDriver}=await import(pathToFileURL(join(source,'v2/driver-hsr/src/driver.ts')).href);
const {claudeAdapter,codexAdapter}=await import(pathToFileURL(join(source,'v2/adapters/src/index.ts')).href);
const driver=new HsrDriver({sessionLogDir:join(root,'logs'),runnersDir:join(root,'runners'),resolve:()=>({adapter:harness==='codex'?codexAdapter({cwd:root}):claudeAdapter,command:process.execPath,args:[new URL('./h1c-fake-codex.mjs',import.meta.url).pathname],cwd:root,env:{...process.env,H1C_WRITES:writes}})});
driver.start('bee',1);const p=driver.procs.get('bee');
try{
 for(let i=0;i<100;i++){driver.observe();await new Promise(resolve=>setTimeout(resolve,5));}
 const outcome=driver.deliver('bee',1,24680,'owned peer fixture');
 if(peerOnly){assert.equal(outcome.accepted,true);for(let i=0;i<100&&!existsSync(writes);i++)await new Promise(resolve=>setTimeout(resolve,5));assert(p.processIdentity);assert.equal(readFileSync(writes,'utf8').trim().split('\n').length,1);}
 else{assert.equal(outcome.accepted,false);assert.equal(outcome.reason,'not_ready');assert.equal(p.socket,null);assert.equal(existsSync(writes),false);}
 console.log(JSON.stringify({case:peerOnly?'nonconfirming-peer-check-remains-conditional':'missing-peer-artifact-parity',revision:source===process.cwd()?'fixed':'main-8d71abd2',harness,delivered:outcome.accepted,reason:outcome.reason??null,socketOpen:!!p.socket,stdinWrites:peerOnly?1:0}));
}finally{
 if(p.child?.exitCode===null){const ended=new Promise(resolve=>p.child.once('exit',resolve));process.kill(-p.pid,'SIGKILL');await ended;}
 driver.detachAll();
}
