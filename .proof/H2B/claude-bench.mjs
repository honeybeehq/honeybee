import { openCoreStore } from '../../v2/core/src/store.ts'
import { DaemonCore } from '../../v2/daemon/src/loops.ts'
import { FakeDriver } from '../../v2/daemon/tests/helpers.ts'
import { createHash } from 'node:crypto'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
const mode = process.argv[2] ?? 'idle'
const root = resolve('.proof/H2B', `claude-${mode}-${Date.now()}`)
mkdirSync(`${root}/home`, { recursive: true })
mkdirSync(`${root}/tmp`, { recursive: true })
mkdirSync(`${root}/cwd/.claude`, { recursive: true })
const start = performance.now()
const log = (kind, data) => appendFileSync(`${root}/events.jsonl`, JSON.stringify({ ms: Math.round(performance.now()-start), kind, data })+'\n')
let count = 0
let child
let sent = false
let results = 0
let interruptSent = false
let providerStarts = 0

let store=openCoreStore(root+'/queue.sqlite',{ephemeral:true})
const driver=new FakeDriver(Date.now)
let core=new DaemonCore({store,driver,now:Date.now,log:x=>log('honeybee',x),policy:{idleWindowSteps:null,commandsPerStep:8,bootHangTimeoutSteps:100000}})
core.boot()
const bee=store.createBee({name:'fixture',agent:'stub',substrate:'hsr',cwd:root}).bee
store.enqueueCommand('spawn',bee.id)
for(let i=0;i<4;i++)core.step()
driver.events.push({beeId:bee.id,generation:1,kind:'turn_started'});core.step()
let bg,hm
const originalDeliver=driver.deliver.bind(driver)
driver.deliver=(id,gen,msg,body,options)=>{const outcome=originalDeliver(id,gen,msg,body);if(outcome.accepted){log('honeybee-wire',{msg,body,options});nativeHuman(body)}return outcome}
const admit=()=>{sent=true;log('human-submitted',mode);bg=store.send(bee.id,'BACKGROUND_SENTINEL',{urgency:mode==='off'?'next':'idle',senderKind:'automation'}).message;const admission={version:1,authorityId:'fixture-apiary',admissionId:'human-1',beeId:bee.id,bodySha256:createHash('sha256').update('HUMAN_SENTINEL').digest('hex'),idempotencyKey:'human-1',humanFirst:mode!=='off'};hm=store.send(bee.id,'HUMAN_SENTINEL',{humanChat:admission}).message;const duplicate=store.send(bee.id,'HUMAN_SENTINEL',{humanChat:admission}).message;if(duplicate.id!==hm.id)throw Error('duplicate row');core.step();log('pending-during-tool',store.undeliveredMessages(bee.id));if(mode==='restart'){store.close();store=openCoreStore(root+'/queue.sqlite',{ephemeral:true});core=new DaemonCore({store,driver,now:Date.now,log:x=>log('honeybee',x),policy:{idleWindowSteps:null,commandsPerStep:8,bootHangTimeoutSteps:100000}});core.boot();log('restart-pending',store.undeliveredMessages(bee.id));}if(mode==='off')core.step()}
const endOriginal=()=>{driver.events.push({beeId:bee.id,generation:1,kind:'turn_ended'});core.step();log('pending-after-human-start',store.undeliveredMessages(bee.id))}
const nativeHuman=body=>send({type:'user',message:{role:'user',content:[{type:'text',text:body}]}})
const human=admit
const send = obj => { log('stdin', obj); child.stdin.write(JSON.stringify(obj)+'\n') }
const server = http.createServer(async (req,res) => {
  let raw = ''; for await (const chunk of req) raw += chunk
  if (!req.url.includes('/messages')) { res.writeHead(200,{'content-type':'application/json'}); res.end('{}'); return }
  const body = JSON.parse(raw); count++; log('provider-request', { count, messages: body.messages })
  const isFirst = count === 1
  const content = isFirst ? { type: 'tool_use', id: 'toolu_fixture', name: 'Bash', input: { command: `sleep 2; printf TOOL_RESULT_SENTINEL`, description:'Fixture slow tool' } } : { type: 'text', text: body.messages.some(x=>JSON.stringify(x).includes('HUMAN_SENTINEL')) ? 'FIXTURE_ACK' : 'FIXTURE_DONE' }
  const contents = [content]
  const msg = { id:`msg_fixture_${count}`,type:'message',role:'assistant',model:body.model,content:contents,stop_reason:isFirst?'tool_use':'end_turn',stop_sequence:null,usage:{input_tokens:10,output_tokens:10} }
  if (!body.stream) { res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(msg));return }
  res.writeHead(200,{'content-type':'text/event-stream'})
  const emit = (type,data) => res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`)
  emit('message_start',{message:{...msg,content:[],stop_reason:null,usage:{input_tokens:10,output_tokens:0}}})
  for (const [index, block] of contents.entries()) {
  emit('content_block_start',{index,content_block:block.type==='tool_use'?{...block,input:{}}:{type:'text',text:''}})
  emit('content_block_delta',{index,delta:block.type==='tool_use'?{type:'input_json_delta',partial_json:JSON.stringify(block.input)}:{type:'text_delta',text:block.text}})
  emit('content_block_stop',{index})
  }
  emit('message_delta',{delta:{stop_reason:msg.stop_reason,stop_sequence:null},usage:{output_tokens:10}})
  emit('message_stop',{});res.end()
  if(isFirst) setTimeout(human, 500)
})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const port=server.address().port
child=spawn('/home/trmd/.local/share/apiary-satellite/bin/claude',['-p','--input-format','stream-json','--output-format','stream-json','--verbose','--include-partial-messages','--dangerously-skip-permissions','--model','claude-sonnet-4-6','--strict-mcp-config','--mcp-config','{"mcpServers":{}}'],{cwd:`${root}/cwd`,env:{HOME:`${root}/home`,TMPDIR:root.replace(process.cwd(),`/proc/${process.pid}/cwd`)+"/tmp",PATH:'/usr/local/bin:/usr/bin:/bin',ANTHROPIC_API_KEY:'fixture-key-no-account',ANTHROPIC_BASE_URL:`http://127.0.0.1:${port}`,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_AUTOUPDATER:'1'}})
let rest=''
child.stdout.on('data',chunk=>{rest+=chunk;const lines=rest.split('\n');rest=lines.pop();for(const line of lines){let obj;try{obj=JSON.parse(line)}catch{log('stdout-other',line);continue}log('stdout',obj);if(obj.type==='result'){results++;if(sent&&mode!=='off'&&results===1)endOriginal();else if((mode==='off'&&sent)||(mode!=='off'&&results===2))setTimeout(()=>child.stdin.end(),300)}}})
child.stderr.on('data',chunk=>log('stderr',String(chunk)))
send({type:'user',message:{role:'user',content:[{type:'text',text:'Run the fixture tool.'}]}})
const timeout=setTimeout(()=>{log('timeout',{});child.kill('SIGTERM')},25000)
await new Promise(r=>child.on('exit',(code,signal)=>{log('exit',{code,signal});r()}))
clearTimeout(timeout);server.close();log('final-mailbox',store.listMessages(bee.id));store.close();console.log(root)

