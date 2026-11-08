import {mkdirSync,writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import assert from 'node:assert/strict';
import {questionEgressCensus,assertQuestionEgress} from '../../v2/daemon/tests/questionEgressCensus.ts';
const output=process.argv[2];
if(!output)throw Error('Expected output JSON path');
const raw=questionEgressCensus();
assertQuestionEgress(raw);
if(process.argv.includes('--require-reuse')){
 assert.ok(globalThis.__HB_CENSUS_COUNTS__,'Run with census-count-loader.mjs');
 assert.equal(globalThis.__HB_CENSUS_COUNTS__.excessRootWalks,0,'Each checker type gets one complete root walk');
}
mkdirSync(dirname(output),{recursive:true});
writeFileSync(output,JSON.stringify({counts:globalThis.__HB_CENSUS_COUNTS__??null,raw},null,2)+'\n');
console.log(JSON.stringify({output,counts:globalThis.__HB_CENSUS_COUNTS__??null}));
