import {writeHeapSnapshot} from 'node:v8';
function fixture(){const quietBaselines=new Map([['bad-kind',{membership:{kind:'transaction_open'},signature:'x'}],['bad-signature',{membership:{kind:'committed'},signature:{invalid:true}}]]);return ()=>quietBaselines.size;}
globalThis.invalidHeapDispatcher=fixture();
writeHeapSnapshot('/tmp/honeybee-autotitle-cache-heap-invalid.heapsnapshot');
