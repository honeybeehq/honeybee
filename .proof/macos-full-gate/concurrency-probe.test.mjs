import {test} from 'node:test';
let active=0, peak=0;
for(let i=0;i<4;i++)test(`top level ${i}`,async()=>{peak=Math.max(peak,++active);await new Promise(r=>setTimeout(r,20));active--;});
test('report peak',()=>console.log(JSON.stringify({peak})));
