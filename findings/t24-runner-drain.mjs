import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {once} from 'node:events';
import {exactProcessBirth,inspectProcess,sameProcess} from '../v2/harness/src/processIdentity.ts';
const baseline=process.argv.includes('--baseline');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const wait=async predicate=>{for(let n=0;n<500;n++){if(predicate())return;await sleep(10);}throw Error('fixture deadline');};
for(const gated of [false,true]) for(const mode of ['none','finite','infinite']) {
  const dir=resolve(`.audit/drain-${gated}-${mode}-${Date.now()}`); mkdirSync(dir,{recursive:true});
  const pidFile=dir+'/holder';
  const holder=`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setTimeout(()=>{console.log(JSON.stringify({late:'output'}));console.error('late-stderr');},250);${mode==='finite'?'setTimeout(()=>process.exit(0),3500);':'setInterval(()=>{},1000);'}`;
  const agent=`const {spawn}=require('node:child_process');${mode==='none'?'':`const c=spawn(process.execPath,['-e',${JSON.stringify(holder)}],{stdio:['ignore','inherit','inherit']});c.unref();`}const line=JSON.stringify({final:'x'.repeat(131072)});process.stderr.write('final-stderr\\n');process.stdout.write(line+'\\n',()=>setTimeout(()=>process.exit(23),100));`;
  const start={intentId:'t24-drain',beeId:'t24',runtimeGeneration:1,claim:{}};
  const cfg={beeId:'t24',generation:1,command:process.execPath,args:['-e',agent],cwd:process.cwd(),env:{PATH:process.env.PATH},sessionLogPath:dir+'/session',observationLogPath:dir+'/observations',sidecarPath:dir+'/stderr',socketPath:'/proc/self/cwd/'+dir.slice(process.cwd().length+1)+'/sock',statusPath:dir+'/status',bootLines:[],...(gated?{executionStart:start,executionOwner:{pid:process.pid,birth:exactProcessBirth(process.pid)}}:{})};
  const config=dir+'/config';writeFileSync(config,JSON.stringify(cfg));
  const host=spawn(process.execPath,[baseline?'dist/v2/t24-before-runner.js':'v2/driver-hsr/src/runner-host-main.ts',config],{stdio:['ignore','pipe','pipe',...(gated?['ipc']:[])]});
  let errors='';host.stderr.on('data',data=>errors+=data);
  host.on('message',frame=>{if(frame.op==='execution_ready')host.send({...frame,op:'execution_release'});});
  const closed=once(host,'close');let identity,result,hostFallbackKills=0;
  try {
    await wait(()=>existsSync(cfg.statusPath)&&JSON.parse(readFileSync(cfg.statusPath)).agentPid);
    if(mode!=='none'){await wait(()=>existsSync(pidFile));identity=inspectProcess(Number(readFileSync(pidFile,'utf8')));assert.equal(identity.kind,'present');}
    await sleep(1800);
    const status=JSON.parse(readFileSync(cfg.statusPath));
    assert.equal(!!status.exited,mode==='none'||!baseline);
    if(status.exited){assert.equal(status.exitCode,23);assert.equal(status.outputDrainTimedOut,mode==='none'?undefined:true);}
    const lines=readFileSync(cfg.observationLogPath,'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(lines[0].final.length,131072);
    assert.equal(readFileSync(cfg.sessionLogPath,'utf8'),readFileSync(cfg.observationLogPath,'utf8'));
    assert.ok(readFileSync(cfg.sidecarPath,'utf8').includes('final-stderr'));
    if(mode!=='none'){assert.ok(lines.some(x=>x.late==='output'));assert.ok(readFileSync(cfg.sidecarPath,'utf8').includes('late-stderr'));assert.ok(sameProcess(identity,inspectProcess(identity.pid)));}
    result={gated,mode,baseline,exited:!!status.exited,exitCode:status.exitCode??null,outputDrainTimedOut:status.outputDrainTimedOut??false,fullFinalOutput:true,lateOutput:mode!=='none',holderStillOwnedAndLive:mode!=='none'};
  } finally {
    if(identity&&sameProcess(identity,inspectProcess(identity.pid)))process.kill(identity.pid,'SIGTERM');
    await Promise.race([closed,sleep(1500)]);
    if(host.exitCode===null&&host.signalCode===null){hostFallbackKills++;host.kill('SIGKILL');await closed;}
    assert.equal(errors,'');
  }
  console.log(JSON.stringify({...result,hostFallbackKills}));
}
