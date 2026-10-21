import { createCliFixture } from './cli-fixture.mjs'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
const mode = process.argv[2] ?? 'idle'
const root = resolve('.proof/B1', `claude-${mode}-${Date.now()}`)
mkdirSync(`${root}/home`, { recursive: true })
mkdirSync(`${root}/tmp`, { recursive: true })
mkdirSync(`${root}/cwd/.claude`, { recursive: true })
const start = performance.now()
const log = (kind, data) => appendFileSync(`${root}/events.jsonl`, JSON.stringify({ ms: Math.round(performance.now()-start), kind, data })+'\n')
let count = 0
let child
let sent = false
let results = 0

const nativeHuman=body=>send({type:'user',message:{role:'user',content:[{type:'text',text:body}]}})
const fixture=await createCliFixture({root, mode, log, nativeHuman})
const human=()=>{sent=true;fixture.admit()}
const endOriginal=()=>fixture.turnEnded()
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
child=spawn(process.env.B1_CLAUDE_BIN ?? '/home/trmd/.local/share/apiary-satellite/bin/claude',['-p','--input-format','stream-json','--output-format','stream-json','--verbose','--include-partial-messages','--dangerously-skip-permissions','--model','claude-sonnet-4-6','--strict-mcp-config','--mcp-config','{"mcpServers":{}}'],{cwd:`${root}/cwd`,env:{HOME:`${root}/home`,TMPDIR:`${root}/tmp`,PATH:'/usr/local/bin:/usr/bin:/bin',ANTHROPIC_API_KEY:'fixture-key-no-account',ANTHROPIC_BASE_URL:`http://127.0.0.1:${port}`,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CLAUDE_CONFIG_DIR:`${root}/home/.claude`,DISABLE_AUTOUPDATER:'1'}})
let rest=''
child.stdout.on('data',chunk=>{rest+=chunk;const lines=rest.split('\n');rest=lines.pop();for(const line of lines){let obj;try{obj=JSON.parse(line)}catch{log('stdout-other',line);continue}log('stdout',obj);if(obj.type==='result'){results++;if(sent){endOriginal();if(results===4)setTimeout(()=>child.stdin.end(),300)}}}})
child.on('error',error=>{throw error})
process.once('uncaughtException',error=>{log('failure',String(error.stack ?? error));child.kill('SIGTERM');server.close();fixture.close();process.exit(1)})
child.stderr.on('data',chunk=>log('stderr',String(chunk)))
send({type:'user',message:{role:'user',content:[{type:'text',text:'Run the fixture tool.'}]}})
const timeout=setTimeout(()=>{log('timeout',{});process.exitCode=1;child.kill('SIGTERM')},25000)
await new Promise(r=>child.on('exit',(code,signal)=>{log('exit',{code,signal});r()}))
clearTimeout(timeout);server.close();fixture.verify();log('final-mailbox',fixture.inspect());fixture.close();console.log(root)

