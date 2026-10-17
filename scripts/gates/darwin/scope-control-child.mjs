import {writeSync} from 'node:fs';
const timer=setTimeout(()=>process.exit(98),30000);
process.stdin.once('data',()=>{clearTimeout(timer);process.exit(0);});
process.stdin.once('end',()=>{clearTimeout(timer);process.exit(99);});
process.stdin.resume();
writeSync(1,'SCOPE_CONTROL_READY\n');

