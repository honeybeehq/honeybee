import { openCoreStore } from '../../v2/core/src/store.ts'
import { DaemonCore } from '../../v2/daemon/src/loops.ts'
import { FakeDriver } from '../../v2/daemon/tests/helpers.ts'
import { createHash } from 'node:crypto'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
const mode=process.argv[2]??'idle'
const root=resolve('.proof/H2B',`codex-${mode}-${Date.now()}`)
for(const p of ['home','tmp','cwd','config'])mkdirSync(`${root}/${p}`,{recursive:true})
const start=performance.now()
const log=(kind,data)=>appendFileSync(`${root}/events.jsonl`,JSON.stringify({ms:Math.round(performance.now()-start),kind,data})+'\n')
let child, threadId, turnId, count=0, sent=false, interruptSent=false, ends=0, seq=0
const send=(method,params)=>{const obj={id:++seq,method,params};log('stdin',obj);child.stdin.write(JSON.stringify(obj)+'\n')}

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
const nativeHuman=body=>send(mode==='off'?'turn/steer':'turn/start',mode==='off'?{threadId,expectedTurnId:turnId,input:[{type:'text',text:body}]}:{threadId,input:[{type:'text',text:body}]})
const human=()=>{admit();if(mode==='probe')send('turn/start',{threadId,input:[{type:'text',text:'ACTIVE_START_PROBE'}]})}
const server=http.createServer(async(req,res)=>{
 let raw='';for await(const chunk of req)raw+=chunk
 if(!req.url.includes('responses')){res.writeHead(200,{'content-type':'application/json'});res.end('{}');return}
 const body=JSON.parse(raw);count++;log('provider-request',{count,body})
 const first=count===1
 const tool=body.tools.find(x=>x.name==='exec_command')??body.tools.find(x=>x.name==='shell_command')??body.tools.find(x=>x.name==='shell')
 const args=tool?.name==='exec_command'?{cmd:'sleep 2; printf TOOL_RESULT_SENTINEL',yield_time_ms:10000}:tool?.name==='shell_command'?{command:'sleep 2; printf TOOL_RESULT_SENTINEL',timeout_ms:10000}:{command:['bash','-lc','sleep 2; printf TOOL_RESULT_SENTINEL'],timeout_ms:10000}
 const item=first?{type:'function_call',id:'fc_fixture',call_id:'call_fixture',name:tool?.name??'exec_command',arguments:JSON.stringify(args),status:'completed'}:{type:'message',id:`msg_${count}`,role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(body.input).includes('HUMAN_SENTINEL')?'FIXTURE_ACK':'FIXTURE_DONE',annotations:[]}]}
 res.writeHead(200,{'content-type':'text/event-stream'})
 const emit=(type,data)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`)
 const response={id:`resp_${count}`,object:'response',created_at:Math.floor(Date.now()/1000),status:'in_progress',model:body.model,output:[]}
 emit('response.created',{response})
 emit('response.output_item.added',{output_index:0,item:first?{...item,arguments:'',status:'in_progress'}:{...item,status:'in_progress'}})
 if(first){emit('response.function_call_arguments.delta',{item_id:item.id,output_index:0,delta:item.arguments});emit('response.function_call_arguments.done',{item_id:item.id,output_index:0,arguments:item.arguments})}
 else{emit('response.content_part.added',{item_id:item.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}});emit('response.output_text.delta',{item_id:item.id,output_index:0,content_index:0,delta:item.content[0].text});emit('response.output_text.done',{item_id:item.id,output_index:0,content_index:0,text:item.content[0].text})}
 emit('response.output_item.done',{output_index:0,item})
 emit('response.completed',{response:{...response,status:'completed',output:[item],usage:{input_tokens:10,output_tokens:10,total_tokens:20}}});res.end()
 if(first)setTimeout(human,500)
})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
writeFileSync(`${root}/config/config.toml`,`model = "gpt-5.4"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Fixture"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`)
child=spawn('/home/trmd/.local/share/apiary-satellite/bin/codex',['app-server'],{cwd:`${root}/cwd`,env:{HOME:`${root}/home`,TMPDIR:root.replace(process.cwd(),`/proc/${process.pid}/cwd`)+"/tmp",CODEX_HOME:`${root}/config`,PATH:'/usr/local/bin:/usr/bin:/bin'}})
let rest=''
child.stdout.on('data',chunk=>{rest+=chunk;const lines=rest.split('\n');rest=lines.pop();for(const line of lines){let obj;try{obj=JSON.parse(line)}catch{log('stdout-other',line);continue}log('stdout',obj)
 if(obj.id===1&&obj.result){child.stdin.write('{"method":"initialized"}\n');send('thread/start',{cwd:`${root}/cwd`,approvalPolicy:'never',sandbox:'danger-full-access',model:'gpt-5.4'})}
 if(obj.id===2&&obj.result){threadId=obj.result.thread.id;send('turn/start',{threadId,input:[{type:'text',text:'Run the fixture tool.'}]})}
 if(obj.method==='turn/started')turnId=obj.params.turn.id
 if(obj.method==='turn/completed'){ends++;if(sent&&mode!=='off'&&ends===1)endOriginal();else if(sent)setTimeout(()=>child.stdin.end(),300)}
}})
child.stderr.on('data',chunk=>log('stderr',String(chunk)))
send('initialize',{clientInfo:{name:'fixture',version:'1'},capabilities:{}})
const timeout=setTimeout(()=>{log('timeout',{});child.kill('SIGTERM')},25000)
await new Promise(r=>child.on('exit',(code,signal)=>{log('exit',{code,signal});r()}));clearTimeout(timeout);server.close();log('final-mailbox',store.listMessages(bee.id));store.close();console.log(root)

