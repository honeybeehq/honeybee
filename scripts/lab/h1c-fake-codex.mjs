import {createInterface} from 'node:readline';
import {appendFileSync,existsSync} from 'node:fs';
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
let turnId=null;
createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);
 if(request.method==='initialize')emit({id:request.id,result:{userAgent:'owned-h1c-fixture'}});
 if(request.method==='thread/start')emit({id:request.id,result:{thread:{id:'h1c-thread'}}});
 if(request.method==='turn/start'||request.method==='turn/steer'){
  const refused=request.method==='turn/steer'&&process.env.H1C_REFUSE_STEER==='yes';
  appendFileSync(process.env.H1C_WRITES,JSON.stringify({id:request.id,method:request.method,...(refused?{refused:true}:{})})+'\n');
  if(refused){emit({id:request.id,error:{code:-32000,message:'owned turn ended before steer'}});emit({method:'turn/completed',params:{threadId:'h1c-thread',turn:{id:turnId,status:'completed',error:null}}});turnId=null;return;}
  turnId??='h1c-turn-'+request.id;
  if(process.env.H1C_ACK!=='never'&&!(process.env.H1C_SKIP_ACK_IDS??'').split(',').includes(String(request.id))){
   const reply={id:request.id,result:{turn:{id:turnId}}};
   if(process.env.H1C_ACK_GATE){const timer=setInterval(()=>{if(existsSync(process.env.H1C_ACK_GATE)){clearInterval(timer);emit(reply);}},5);}
   else setTimeout(()=>emit(reply),Number(process.env.H1C_ACK_DELAY_MS??'0'));
  }
  emit({method:'turn/started',params:{threadId:'h1c-thread',turn:{id:turnId}}});
  setTimeout(()=>{emit({method:'turn/completed',params:{threadId:'h1c-thread',turn:{id:turnId,status:'completed',error:null}}});turnId=null;},Number(process.env.H1C_TURN_MS??'100'));
 }
});
process.on('SIGTERM',()=>process.exit(0));
