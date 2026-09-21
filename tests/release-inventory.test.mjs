import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { extractInventory } from '../contracts/release/v1/tools/extract-inventory.mjs'

test('extraction is stable, tracks input/output/commands, and records dynamic coverage', () => {
  const root = mkdtempSync(join(tmpdir(), 'contract-inventory-'))
  try {
    const source = `interface Reply { value: string }; class Client { request<T>(verb: string, params: unknown): Promise<T> { throw 0 } }
      const client = new Client(); client.request<Reply>('read', { id: 1 });
      function offer(caps: {capabilities: string[]}) { if (caps.capabilities.includes('feature.v1')) { return }; client.request('legacy', {}) }
      function forward(verb: string) { return client.request(verb, {}) }
      function dispatch(verb: string, params: {id: number}) { switch (verb) { case 'read': return {value: 'a'}; default: throw 0 } }`
    writeFileSync(join(root, 'api.ts'), source)
    const config = { component: 'apiary', roots: ['.'], providers: [{ path: 'api.ts', switch: 'verb', protocol: 'test/1' }], consumers: [{ receiver: 'Client', method: 'request', operationArgs: [0], paramsArg: 1, protocol: 'test/1' }] }
    const read = () => extractInventory({ root, config, typescript: ts })
    const first = read()
    assert.deepEqual(read(), first)
    assert.equal(first.consumers.find(x => x.operation === 'read').required, true)
    assert.equal(first.consumers.find(x => x.operation === 'read').response.promise.properties.find(p => p.name === 'value').shape.type, 'string')
    assert.equal(first.optionalFeatures[0].capability, 'feature.v1')
    assert.equal(first.optionalFeatures[0].required, false)
    assert.ok(first.coverage.gaps.some(x => x.reason.includes('dynamic operation')))
    for (const mutation of [source.replace('id: 1', "id: '1'"), source.replace('value: string', 'value: number'), source.replace("case 'read'", "case 'other'")]) {
      writeFileSync(join(root, 'api.ts'), mutation)
      assert.notEqual(read().fingerprint, first.fingerprint)
    }
    writeFileSync(join(root, 'api.ts'), '// harmless comment\n' + source.replace('id: 1', 'id:    1'))
    assert.equal(read().fingerprint, first.fingerprint)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('project compiler semantics are evidence and affect both fingerprints', () => {
  const root = mkdtempSync(join(tmpdir(), 'contract-options-'))
  try {
    writeFileSync(join(root, 'api.ts'), `class Client { request(verb: string, params: unknown) { const rows: string[] = []; return rows[0] } }; new Client().request('read', {})`)
    writeFileSync(join(root, 'base.json'), JSON.stringify({ compilerOptions: { strict: true, noUncheckedIndexedAccess: true } }))
    const config = { component: 'apiary', roots: ['.'], projects: ['tsconfig.json'], providers: [], consumers: [{ receiver: 'Client', method: 'request', operationArgs: [0], paramsArg: 1, protocol: 'test/1' }] }
    const project = enabled => writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ extends: './base.json', compilerOptions: { noUncheckedIndexedAccess: enabled }, include: ['api.ts'] }))
    const read = () => extractInventory({ root, config, typescript: ts })
    project(true)
    const first = read()
    assert.deepEqual(first.consumers[0].response.union.map(x => x.type).sort(), ['string', 'undefined'])
    project(false)
    const second = read()
    assert.equal(second.consumers[0].response.type, 'string')
    assert.notEqual(second.providerFingerprint, first.providerFingerprint)
    assert.notEqual(second.consumerFingerprint, first.consumerFingerprint)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('guard dispatch is extracted and unsupported conditions remain unknown', () => {
  const root = mkdtempSync(join(tmpdir(), 'contract-guards-'))
  try {
    writeFileSync(join(root, 'api.ts'), `function edit(verb: string) { if (verb !== 'edit') return {error: true}; return {saved: true} }
      function compound(verb: string, ok: boolean) { if (verb === 'remove' && ok) return {removed: true} }
      function dynamic(verb: string) { if (['a', 'b'].includes(verb)) return {dynamic: true} }`)
    const config = { component: 'apiary', roots: ['.'], providers: [{path: 'api.ts', switch: 'verb', protocol: 'test/1'}], consumers: [] }
    const result = extractInventory({ root, config, typescript: ts })
    const edit = result.providers.find(x => x.operation === 'edit')
    assert.ok(edit)
    assert.ok(edit.response.some(x => x.expression.includes('saved')))
    assert.ok(result.providers.some(x => x.operation === 'remove'))
    assert.equal(result.coverage.complete, false)
    assert.ok(result.coverage.gaps.some(x => x.reason.includes('provider condition')))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
