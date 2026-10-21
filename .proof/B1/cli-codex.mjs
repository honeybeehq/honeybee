import assert from 'node:assert/strict'
import { createCliFixture } from './cli-fixture.mjs'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
const mode=process.argv[2]??'idle'
const root=resolve('.proof/B1',`codex-${mode}-${Date.now()}`)
for(const p of ['home','tmp','cwd','config'])mkdirSync(`${root}/${p}`,{recursive:true})
const start=performance.now()
const log=(kind,data)=>appendFileSync(`${root}/events.jsonl`,JSON.stringify({ms:Math.round(performance.now()-start),kind,data})+'\n')
let child, threadId, count=0, sent=false, ends=0, seq=0
const send=(method,params)=>{const obj={id:++seq,method,params};log('stdin',obj);child.stdin.write(JSON.stringify(obj)+'\n')}

const nativeHuman=body=>send('turn/start',{threadId,input:[{type:'text',text:body}]})
const fixture=await createCliFixture({root, mode, log, nativeHuman})
const human=()=>{sent=true;fixture.admit()}
const endOriginal=()=>fixture.turnEnded()
const server=http.createServer(async(req,res)=>{
 let raw='';for await(const chunk of req)raw+=chunk
 if(!req.url.includes('responses')){res.writeHead(200,{'content-type':'application/json'});res.end('{}');return}
 const body=JSON.parse(raw)
 if(!Array.isArray(body.input)||!body.tools?.some(t=>['exec_command','shell_command','shell'].includes(t.name))){log('provider-aux-request',{url:req.url,body});res.writeHead(200,{'content-type':'application/json'});res.end('{}');return}
 fixture.nativeRequest();count++;log('provider-request',{count,body})
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
const binary=process.env.B1_CODEX_BIN ?? '/home/trmd/.local/share/apiary-satellite/bin/codex'
fixture.recordBinary(binary)
child=spawn(binary,['app-server'],{cwd:`${root}/cwd`,env:{HOME:`${root}/home`,TMPDIR:`${root}/tmp`,CODEX_HOME:`${root}/config`,PATH:'/usr/local/bin:/usr/bin:/bin'}})
let rest=''
child.stdout.on('data',chunk=>{rest+=chunk;const lines=rest.split('\n');rest=lines.pop();for(const line of lines){let obj;try{obj=JSON.parse(line)}catch{log('stdout-other',line);continue}log('stdout',obj)
 if(obj.error)throw Error(JSON.stringify(obj.error)); if(obj.id===1&&obj.result){child.stdin.write('{"method":"initialized"}\n');send('thread/start',{cwd:`${root}/cwd`,approvalPolicy:'never',sandbox:'danger-full-access',model:'gpt-5.4'})}
 if(obj.id===2&&obj.result){threadId=obj.result.thread.id;send('turn/start',{threadId,input:[{type:'text',text:'Run the fixture tool.'}]})}
 if(obj.method==='turn/completed'){ends++;if(sent){endOriginal();if(ends===4)setTimeout(()=>child.stdin.end(),300)}}
}})
child.on('error',error=>{throw error})
process.once('uncaughtException',error=>{log('failure',String(error.stack ?? error));child.kill('SIGTERM');server.close();fixture.fail(error);fixture.close();process.exit(1)})
child.stderr.on('data',chunk=>log('stderr',String(chunk)))
send('initialize',{clientInfo:{name:'fixture',version:'1'},capabilities:{}})
const timeout=setTimeout(()=>{log('timeout',{});process.exitCode=1;child.kill('SIGTERM')},25000)
await new Promise(r=>child.on('exit',(code,signal)=>{log('exit',{code,signal});if(code!==0||signal)process.exitCode=1;r()}));clearTimeout(timeout);server.close();try{assert.ok(!process.exitCode,'native CLI must exit cleanly');fixture.verify();log('final-mailbox',fixture.inspect())}catch(error){fixture.fail(error);throw error}finally{fixture.close()}console.log(root)

