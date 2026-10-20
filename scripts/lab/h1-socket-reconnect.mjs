import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {renameSync} from 'node:fs';
import {makeRig,drainUntil,sleep,pidAlive} from '../../v2/driver-hsr/tests/helpers.ts';
const rig=makeRig();const driver=rig.driver;let child;
try {
 driver.start('h1-socket-lab',1);
 await drainUntil(driver,events=>events.some(x=>x.kind==='booted'));
 const p=driver.procs.get('h1-socket-lab');child=p.pid;
 for(let i=0;i<500&&(!p.socket?.writable||p.phase!=='idle');i++){driver.observe();await sleep(10);}
 assert.equal(p.phase,'idle');assert(p.socket?.writable);assert.equal(p.pendingDeliveries.size,0);
 let writes=0;const write=driver.writeLine.bind(driver);driver.writeLine=(proc,line)=>{writes++;return write(proc,line);};
 p.socketBroken=true;
 for(let i=0;i<100;i++)assert.deepEqual(driver.deliver('h1-socket-lab',1,24680,'owned fixture'),{accepted:false,reason:'not_ready'});
 assert.equal(writes,0);
 let wrongPeerRefused=null;
 if(process.env.H1_EXPECT_RECOVERY==='1') {
  const saved=p.socketPath+'.owned';renameSync(p.socketPath,saved);
  let frames=0;const impostor=createServer(socket=>socket.on('data',()=>frames++));await new Promise(resolve=>impostor.listen(p.socketPath,resolve));
  p.socket.destroy();await sleep(550);
  wrongPeerRefused=p.socket===null&&p.socketBroken&&frames===0;assert.equal(wrongPeerRefused,true);assert.equal(writes,0);
  await new Promise(resolve=>impostor.close(resolve));renameSync(saved,p.socketPath);
 }
 const previous=p.socket;p.socket?.destroy();
 for(let i=0;i<500&&(p.socket===previous||!p.socket?.writable);i++){driver.observe();await sleep(10);}
 assert(p.socket&&p.socket!==previous&&p.socket.writable);
 const result=driver.deliver('h1-socket-lab',1,24680,'owned fixture');
 console.log(JSON.stringify({case:'authenticated-reconnect-after-never-written-refusal',beforeAttempts:100,beforeWrites:0,connected:true,wrongPeerRefused,socketBroken:p.socketBroken,result,writes,pendingAcknowledgements:p.pendingDeliveries.size,pid:child}));
 const expect=process.env.H1_EXPECT_RECOVERY==='1';assert.equal(result.accepted,expect);assert.equal(writes,expect?1:0);
}finally{driver.disposeAll();for(let i=0;i<100&&child&&pidAlive(child);i++)await sleep(10);if(child)assert.equal(pidAlive(child),false);}
