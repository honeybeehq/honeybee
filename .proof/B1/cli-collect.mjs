import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, relative } from 'node:path'
const roots=process.argv.slice(2)
assert.equal(roots.length,6,'provide the six fresh run directories, in CLI/mode order')
const destination=resolve('.proof/B1/cli-receipts')
mkdirSync(destination,{recursive:true})
const runs=roots.map((root,index)=>{
  const cli=index<3?'claude':'codex'
  const mode=['idle','restart','human-active'][index%3]
  const summary=JSON.parse(readFileSync(resolve(root,'summary.json'),'utf8'))
  assert.equal(summary.passed,true)
  assert.equal(summary.mode,mode)
  assert.ok(summary.binary.version.toLowerCase().includes(cli))
  for(const file of ['events.jsonl','summary.json'])copyFileSync(resolve(root,file),resolve(destination,`${cli}-${mode}.${file}`))
  return {cli,mode,passed:summary.passed,binary:summary.binary,turns:summary.turns,members:summary.batches[0].memberIds.length,scope:summary.scope,events:relative(process.cwd(),resolve(destination,`${cli}-${mode}.events.jsonl`)),summary:relative(process.cwd(),resolve(destination,`${cli}-${mode}.summary.json`))}
})
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim()
writeFileSync(resolve('.proof/B1/cli-receipt.json'),JSON.stringify({passed:true,fixtureRevision:git('rev-parse','HEAD'),implementationRevision:git('log','-1','--format=%H','--','v2'),runs},null,2)+'\n')
console.log('.proof/B1/cli-receipt.json')
