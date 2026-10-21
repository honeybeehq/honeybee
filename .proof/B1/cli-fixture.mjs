import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export async function createCliFixture({root,mode,log,nativeHuman}) {
  assert.ok(['idle','restart'].includes(mode),'mode must be idle or restart')
  const sourceRoot=resolve(process.env.B1_SOURCE_ROOT ?? '.')
  const load=path=>import(pathToFileURL(resolve(sourceRoot,path)).href)
  const [{openCoreStore},{DaemonCore},{FakeDriver}]=await Promise.all([
    load('v2/core/src/store.ts'),load('v2/daemon/src/loops.ts'),load('v2/daemon/tests/helpers.ts')])
  let clock=Date.now()
  const now=()=>clock
  let store=openCoreStore(`${root}/queue.sqlite`,{ephemeral:true,now})
  assert.equal(typeof store.setMailBatchingPolicy,'function','B1 implementation required; H2-only source cannot qualify batching')
  const driver=new FakeDriver(now)
  const makeCore=()=>new DaemonCore({store,driver,now,log:x=>log('honeybee',x),policy:{idleWindowSteps:null,commandsPerStep:8,bootHangTimeoutSteps:100000}})
  let core=makeCore()
  core.boot()
  const bee=store.createBee({name:'b1-fixture',agent:'stub',substrate:'hsr',cwd:root}).bee
  store.setMailBatchingPolicy(bee.id,true)
  store.enqueueCommand('spawn',bee.id)
  for(let i=0;i<4;i++)core.step()
  driver.events.push({beeId:bee.id,generation:1,kind:'turn_started'})
  core.step()
  let human,reprompt,peers=[],turns=0,admitted=false
  const wires=[]
  const originalDeliver=driver.deliver.bind(driver)
  driver.deliver=(id,generation,messageId,body,options)=>{
    const outcome=originalDeliver(id,generation,messageId,body,options)
    if(outcome.accepted){
      const kind=messageId===human?.id?'human':messageId===reprompt?.id?'reprompt':'digest'
      const wire={messageId,body,options,kind,clock}
      wires.push(wire);log('honeybee-wire',wire)
      driver.events.push({beeId:id,generation,kind:'turn_started',messageId})
      nativeHuman(body)
    }
    return outcome
  }
  const restart=stage=>{
    const before=store.undeliveredMessages(bee.id).map(m=>m.id)
    store.close();store=openCoreStore(`${root}/queue.sqlite`,{ephemeral:true,now})
    core=makeCore();core.boot()
    assert.deepEqual(store.undeliveredMessages(bee.id).map(m=>m.id),before)
    log('restart',{stage,pending:before,batches:store.listMailBatches(bee.id)})
  }
  const inspect=()=>({messages:store.listMessages(bee.id),batches:store.listMailBatches(bee.id),wires,clock,turns})
  return {
    admit(){
      assert.equal(admitted,false);admitted=true
      const senders=Array.from({length:12},(_,index)=>store.createBee({name:`fixture-peer-${index}`,agent:'stub',substrate:'hsr',cwd:root}).bee)
      peers=Array.from({length:12},(_,index)=>store.send(bee.id,`PEER_${String(index).padStart(2,'0')}_SENTINEL full original body λ`,{sender:senders[index].id,urgency:index%2?'next':'now',senderKind:'automation'}).message)
      const body='HUMAN_SENTINEL'
      const humanChat={version:1,authorityId:'fixture-apiary',admissionId:'human-1',beeId:bee.id,bodySha256:createHash('sha256').update(body).digest('hex'),idempotencyKey:'human-1',humanFirst:true}
      human=store.send(bee.id,body,{humanChat}).message
      assert.equal(store.send(bee.id,body,{humanChat}).message.id,human.id)
      reprompt=store.send(bee.id,'TELL_REPROMPT_SENTINEL',{sender:'fixture-apiary',senderKind:'automation',automationKind:'tell-reprompt'}).message
      core.step()
      assert.equal(wires.length,0,'no injection during native tool turn')
      assert.equal(driver.interrupts.length,0,'ordinary now cannot interrupt')
      log('admitted',{human,reprompt,peers,clock})
      if(mode==='restart')restart('during-tool')
    },
    turnEnded(){
      turns++
      log('native-turn-ended',{turns,clock})
      driver.events.push({beeId:bee.id,generation:1,kind:'turn_ended'})
      core.step()
      if(turns===1)assert.deepEqual(wires.map(w=>w.kind),['human'])
      if(turns===2)assert.deepEqual(wires.map(w=>w.kind),['human','reprompt'])
      if(turns===3){
        clock+=119999;core.step()
        assert.equal(wires.length,2,'ordinary peers held before 120 seconds')
        if(mode==='restart')restart('before-window-release')
        clock++;core.step()
        assert.deepEqual(wires.map(w=>w.kind),['human','reprompt','digest'])
      }
    },
    recordBinary(binary){
      const version=execFileSync(binary,['--version'],{cwd:`${root}/cwd`,env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:`${root}/home`,TMPDIR:`${root}/tmp`,CODEX_HOME:`${root}/config`,CLAUDE_CONFIG_DIR:`${root}/home/.claude`},encoding:'utf8',timeout:10000}).trim()
      log('binary',{binary,version,sha256:createHash('sha256').update(readFileSync(binary)).digest('hex'),node:process.version})
    },
    nativeRequest(){
      const before=wires.length
      core.step()
      assert.equal(wires.length,before,'no delivery during native provider request')
      assert.equal(driver.interrupts.length,0)
      log('mid-turn-probe',{clock,wires:before})
    },
    inspect,
    verify(){
      assert.equal(turns,4,'bootstrap, human, reprompt and digest must each complete')
      assert.equal(driver.interrupts.length,0)
      assert.deepEqual(wires.map(w=>w.kind),['human','reprompt','digest'])
      const batches=store.listMailBatches(bee.id)
      assert.equal(batches.length,1)
      assert.deepEqual(batches[0].memberIds,peers.map(m=>m.id))
      assert.match(wires[2].body,/Background digest/)
      for(const peer of peers)assert.ok(wires[2].body.includes(peer.body),`missing full body ${peer.id}`)
      assert.ok(!wires[2].body.includes('TELL_REPROMPT_SENTINEL'))
      assert.equal(store.undeliveredMessages(bee.id).length,0)
      const events=readFileSync(`${root}/events.jsonl`,'utf8').trim().split('\n').map(JSON.parse)
      const requests=events.filter(e=>e.kind==='provider-request')
      assert.equal(requests.length,5,'tool call, tool result and three fresh turns')
      const context=e=>e.data.messages ?? e.data.body.input
      const toolRequest=context(requests[1])
      const toolResult=toolRequest.flatMap(item=>item.type==='function_call_output'?[item]:Array.isArray(item.content)?item.content.filter(block=>block.type==='tool_result'):[])
      assert.ok(JSON.stringify(toolResult).includes('TOOL_RESULT_SENTINEL'),'actual next provider context preserves tool result')
      assert.ok(!JSON.stringify(toolResult).includes('HUMAN_SENTINEL'),'human never nested in tool result')
      assert.ok(JSON.stringify(context(requests[2])).includes('HUMAN_SENTINEL'))
      assert.ok(!JSON.stringify(context(requests[2])).includes('PEER_00_SENTINEL'))
      assert.ok(JSON.stringify(context(requests[3])).includes('TELL_REPROMPT_SENTINEL'))
      assert.ok(!JSON.stringify(context(requests[3])).includes('PEER_00_SENTINEL'))
      const lastUser=e=>{const items=context(e);return JSON.stringify(items.filter(item=>item.role==='user').at(-1))}
      assert.ok(lastUser(requests[2]).includes('HUMAN_SENTINEL'))
      assert.ok(!lastUser(requests[2]).includes('TELL_REPROMPT_SENTINEL'))
      assert.ok(lastUser(requests[3]).includes('TELL_REPROMPT_SENTINEL'))
      assert.ok(!lastUser(requests[3]).includes('HUMAN_SENTINEL'))
      assert.ok(lastUser(requests[4]).includes('Background digest'))
      assert.ok(!lastUser(requests[4]).includes('TELL_REPROMPT_SENTINEL'))
      assert.ok(events.some(e=>e.kind==='stdout'&&JSON.stringify(e.data).includes('FIXTURE_ACK')),'fixture acknowledgement emitted in native output; not a real model ack')
      const digestContext=JSON.stringify(context(requests[4]))
      for(const peer of peers)assert.ok(digestContext.includes(peer.body),'full peer body in actual provider context')
      writeFileSync(`${root}/summary.json`,JSON.stringify({passed:true,scope:'stock native CLI + local fixture provider + real CoreStore/DaemonCore + FakeDriver bridge; store-level classification only; not HSR or RPC end-to-end; authority gates, frozen/uncertain confirmation restarts, paging/bounds, deferred stopped wake and cancel/expedite unqualified; restarts gracefully reopen store and retain FakeDriver/native process; not real data or model ack latency',mode,sourceRoot,binary:events.find(e=>e.kind==='binary')?.data,node:process.version,...inspect()},null,2))
    },
    close(){store.close()},
  }
}
