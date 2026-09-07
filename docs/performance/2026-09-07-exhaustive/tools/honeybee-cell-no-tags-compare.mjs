import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const [dirArg,repoArg,outArg]=process.argv.slice(2);assert(dirArg&&repoArg&&outArg);
const dir=resolve(dirArg),{distribution}=await import(pathToFileURL(join(resolve(repoArg),'scripts/perf/report.mjs')).href);
const labels=['a1','b1','b2','a2'],runs=labels.map(x=>JSON.parse(readFileSync(join(dir,'mini-cell-no-tags-'+x+'.json'))));
for(const r of runs){assert(r.completed);assert.deepEqual(r.tools.start,runs[0].tools.start);assert.deepEqual(r.environment.bootIdentityStart,runs[0].environment.bootIdentityStart);assert.equal(r.environment.gitVersion,runs[0].environment.gitVersion);assert.deepEqual(r.workload,runs[0].workload);}
const hashes=runs.map(r=>r.source.start.hashes);assert.deepEqual(hashes[0],hashes[3]);assert.deepEqual(hashes[1],hashes[2]);assert.deepEqual(Object.keys(hashes[0]),Object.keys(hashes[1]));assert.deepEqual(Object.keys(hashes[0]).filter(k=>hashes[0][k]!==hashes[1][k]),['v2/driver-cell/src/capture.ts']);
const result={completed:true,order:labels,scope:'Two independent process runs per side in ABBA order, six balanced samples per ref count per run. Combined headline uses all12 samples per side; resource/clone diagnostic values remain separate single-run observations.',rows:[]};
for(let i=0;i<3;i++){
 const v=runs.map(r=>r.results[i]);for(const x of v)assert.deepEqual(x.expectedResult,v[0].expectedResult);
 const samples=([a,b],key)=>distribution([...v[a].headline.raw,...v[b].headline.raw].map(x=>x[key]));
 const before=samples([0,3],'wallMs'),after=samples([1,2],'wallMs');
 const row={refCount:v[0].refCount,runWallP50:v.map(x=>x.headline.wallMs.p50),beforeWall:before,afterWall:after,beforeParentCpu:samples([0,3],'parentCpuMs'),afterParentCpu:samples([1,2],'parentCpuMs'),wallDeltaPercent:100*(after.p50/before.p50-1),gitCpuMs:v.map(x=>x.gitRusage.aggregate.realGitAndWaitedDescendantCpuMicros/1000),cloneCpuMs:v.map(x=>x.gitRusage.aggregate.raw.find(y=>y.argv[1]==='clone').cpuMicros/1000),maxIndividualRssBytes:v.map(x=>x.gitRusage.aggregate.maxSingleProcessRssBytesAcrossWaitedGitTrees),scratchLogicalBytes:v.map(x=>x.scratchStorage.scratchLogicalBytes.p50),scratchAllocatedBytes:v.map(x=>x.scratchStorage.scratchAllocatedBytes.p50),scratchTags:v.map(x=>x.scratchStorage.raw[0].storage.syntheticTagCount),maintenance:v.map(x=>x.trace2.maintenance.observed)};
 assert.deepEqual(row.scratchTags,[row.refCount,0,0,row.refCount]);result.rows.push(row);
}
writeFileSync(resolve(outArg),JSON.stringify(result,null,2)+'\n');
