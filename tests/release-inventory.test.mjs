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

test('declared host wrappers propagate literal arguments with caller and forwarding evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'contract-wrapper-'))
  try {
    writeFileSync(join(root, 'api.ts'), `class Client { read(domain: string, verb: string, args: object): unknown { return {} } }
      class Host { client = new Client(); read(domain: string, verb: string, args: object) { const client = this.client; if (!client) throw new Error("unavailable"); return client.read(domain, verb, args) } }
      const host = new Host(); host.read('files', 'repos', { limit: 2 }); host.read('hive', 'mail.history', { beeId: 'b' });
      function dynamic(domain: string) { return host.read(domain, 'repos', {}) }`)
    const config = { component: 'apiary', roots: ['.'], providers: [], consumers: [{ receiver: '^Client$', method: 'read', operationArgs: [0, 1], paramsArg: 2, protocol: 'apiaryd/1' }],
      wrappers: [{ path: 'api.ts', receiver: 'Host', method: 'read', target: { receiver: '^Client$', method: 'read' } }] }
    const inventory = extractInventory({ root, config, typescript: ts })
    const route = inventory.consumers.find(c => c.operation === 'files.repos')
    assert.ok(route)
    assert.equal(route.method, 'read')
    assert.equal(route.required, true)
    assert.equal(route.request.expression, '{ limit: 2 }')
    assert.deepEqual(route.routing.argumentMap, [0, 1, 2])
    assert.match(inventory.evidence[route.routing.wrapper.implementation], /client.read/)
    assert.ok(inventory.consumers.some(c => c.operation === 'hive.mail.history'))
    assert.ok(inventory.consumers.some(c => c.operation === null && c.coverage === 'unknown'))
    assert.equal(inventory.coverage.complete, false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

function domainFixture(sourceChange = source => source, configChange = config => config) {
  const root = mkdtempSync(join(tmpdir(), 'contract-domain-'))
  const source = `interface DomainRegistration { name: string; read(verb: string, args: {id?: string}): unknown }
    const registration: DomainRegistration = { name: 'files', read(verb, args) {
      if (!args) throw new Error('invalid_request');
      switch (verb) { case 'repos': return {ok: true, repos: []}; case 'stat': return {ok: true, path: args.id}; default: throw new Error('unknown_verb') }
    }};
    const registrations = [registration];
    function localRead(domain: string, verb: string, args: {id?: string}) {
      const registration = registrations.find(r => r.name === domain);
      if (!registration) throw new Error('unknown_domain');
      return registration.read(verb, args);
    }
    const READS = { files: { repos: 15000, stat: 15000 } };
    function listener(type: string, domain: string, verb: string, args: {id?: string}) {
      switch(type) { case 'read':
        if (!Object.hasOwn(READS, domain)) throw new Error('invalid_request');
        return localRead(domain, verb, args);
      }
    }`
  writeFileSync(join(root, 'api.ts'), sourceChange(source))
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({compilerOptions: {strict: true, target: 'ESNext'}, include: ['api.ts']}))
  const config = configChange({ component: 'apiary', roots: ['.'], projects: ['tsconfig.json'], providers: [], consumers: [],
    domainRoutes: [{ pathPattern: '^api.ts$', registrationType: 'DomainRegistration', protocol: 'apiaryd/1',
      transports: [{ path: 'api.ts', switch: 'type', operation: 'read', method: 'read', forward: 'localRead',
        dispatch: { path: 'api.ts', function: 'localRead', collection: 'registrations' },
        allowlist: { path: 'api.ts', registry: 'READS', kind: 'verbs' } }] }] })
  try { return extractInventory({root, config, typescript: ts}) }
  finally { rmSync(root, {recursive: true, force: true}) }
}

test('domain registration connects files.repos to scoped transport and preserves validation failures', () => {
  const inventory = domainFixture()
  const provider = inventory.providers.find(p => p.operation === 'files.repos')
  assert.ok(provider)
  assert.equal(provider.protocol, 'apiaryd/1')
  assert.equal(provider.scope, 'read')
  assert.equal(provider.routing.domain, 'files')
  assert.equal(provider.routing.verb, 'repos')
  assert.equal(provider.routing.transports[0].allowlisted, true)
  assert.equal(provider.coverage, 'extracted')
  assert.equal(provider.routing.transports[0].coverage, 'extracted')
  assert.match(inventory.evidence[provider.implementation], /invalid_request/)
  assert.match(inventory.evidence[provider.implementation], /unknown_verb/)
  assert.match(inventory.evidence[provider.implementation], /unknown_domain/)
  assert.ok(provider.response.some(r => r.expression?.includes('repos')))
  assert.ok(inventory.providers.some(p => p.operation === 'files.stat'))
  assert.equal(inventory.coverage.complete, false)
  assert.deepEqual(domainFixture(), inventory)
})

test('missing, dynamic, and ambiguous domain routes remain unknown', () => {
  for (const [change, reason] of [
    [s => s.replace('return localRead(domain, verb, args)', 'return localRead(verb, domain, args)'), 'forwarding'],
    [s => s.replace("r.name === domain", 'r.name === verb'), 'selection'],
    [s => s.replace('repos: 15000, stat: 15000', 'stat: 15000'), 'absent'],
    [s => s.replace('const READS = { files:', 'const READS = { [String(Date.now())]:'), 'dynamic'],
    [s => s.replace("const READS =", "const another: DomainRegistration = {name: 'files', read(verb, args) {switch (verb) {case 'repos': return 0}}}; const READS ="), 'ambiguous'],
  ]) {
    const inventory = domainFixture(change)
    const routes = inventory.providers.filter(p => p.operation === 'files.repos')
    assert.ok(routes.length)
    assert.ok(routes.every(p => p.coverage === 'unknown'), reason)
    assert.ok(inventory.coverage.gaps.some(g => g.reason.includes(reason)), reason)
  }
  const dynamic = domainFixture(s => s.replace("name: 'files'", "name: String(Date.now())"))
  assert.ok(!dynamic.providers.some(p => p.operation === 'files.repos'))
  assert.ok(dynamic.coverage.gaps.some(g => g.reason.includes('dynamic')))
  const missing = domainFixture(s => s, c => ({...c, domainRoutes: c.domainRoutes.map(d => ({...d, transports: d.transports.map(t => ({...t, path: 'missing.ts'}))}))}))
  assert.ok(missing.coverage.gaps.some(g => g.reason.includes('missing transport')))
})

test('guard-based domain verbs retain scoped route and full handler evidence', () => {
  const inventory = domainFixture(s => s.replace("switch (verb) { case 'repos': return {ok: true, repos: []}; case 'stat': return {ok: true, path: args.id}; default: throw new Error('unknown_verb') }", "if (verb === 'repos') return {ok: true, repos: []}; throw new Error('unknown_verb')"))
  const provider = inventory.providers.find(p => p.operation === 'files.repos')
  assert.ok(provider)
  assert.equal(provider.scope, 'read')
  assert.equal(provider.coverage, 'unknown')
  assert.match(inventory.evidence[provider.implementation], /unknown_verb/)
})

test('route evidence fingerprints change with allowlists and failures, not formatting', () => {
  const original = domainFixture()
  for (const change of [s => s.replace('repos: 15000', 'repos: 20000'), s => s.replace('unknown_domain', 'unavailable')]) {
    assert.notEqual(domainFixture(change).providerFingerprint, original.providerFingerprint)
  }
  assert.equal(domainFixture(s => '// comment\n' + s.replace('repos: 15000', 'repos:   15000')).fingerprint, original.fingerprint)
})

test('wrapper transformations and multiple forwarding targets never yield guessed literal routes', () => {
  const root = mkdtempSync(join(tmpdir(), 'contract-wrapper-negative-'))
  try {
    const config = { component: 'apiary', roots: ['.'], providers: [], consumers: [{ receiver: '^Client$', method: 'read', operationArgs: [0, 1], paramsArg: 2, protocol: 'apiaryd/1' }],
      wrappers: [{path: 'api.ts', receiver: 'Host', method: 'read', target: {receiver: '^Client$', method: 'read'}}] }
    for (const body of [
      "domain = 'hive'; return this.client.read(domain, verb, args)",
      "Object.assign(args, {limit: 100}); return this.client.read(domain, verb, args)",
      "const neverCalled = () => { return this.client.read(domain, verb, args) }",

      "return this.client.read(domain.toLowerCase(), verb, args)",
      "if (domain) return this.client.read(domain, verb, args); return this.client.read('hive', verb, args)",
    ]) {
      writeFileSync(join(root, 'api.ts'), `class Client {read(domain: string, verb: string, args: object) {return {}}}; class Host {client = new Client(); read(domain: string, verb: string, args: object) {${body}}}; new Host().read('files', 'repos', {})`)
      const inventory = extractInventory({root, config, typescript: ts})
      assert.ok(!inventory.consumers.some(c => c.receiver === 'Host' && c.operation !== null))
      assert.ok(inventory.coverage.gaps.some(g => g.reason.includes('wrapper')))
    }
  } finally { rmSync(root, {recursive: true, force: true}) }
})


test('transport and dispatcher transformations are unknown, including intermediate payloads', () => {
  for (const change of [
    s => s.replace('return localRead(domain, verb, args)', "domain = 'absent'; return localRead(domain, verb, args)"),
    s => s.replace('return registration.read(verb, args)', "verb = 'absent'; return registration.read(verb, args)"),
    s => s.replace('return localRead(domain, verb, args)', 'return localRead(domain, verb, {different: true})'),
    s => s.replace('return localRead(domain, verb, args)', 'Object.assign(args, {different: true}); return localRead(domain, verb, args)'),
  ]) {
    const inventory = domainFixture(change)
    const provider = inventory.providers.find(p => p.operation === 'files.repos')
    assert.equal(provider.coverage, 'unknown')
    assert.equal(provider.routing.transports[0].coverage, 'unknown')
  }
})

test('every registration participates in ambiguity, including identical and unsupported handlers', () => {
  for (const extra of [
    "const duplicate: DomainRegistration = {name: 'files', read() {throw new Error('unavailable')}};",
    null,
  ]) {
    const inventory = domainFixture(s => {
      const copy = extra ?? s.slice(s.indexOf('const registration:'), s.indexOf('const registrations =')).replace('const registration:', 'const duplicate:')
      return s + copy
    })
    const providers = inventory.providers.filter(p => p.operation === 'files.repos')
    assert.ok(providers.length)
    assert.ok(providers.every(p => p.coverage === 'unknown'))
    assert.ok(inventory.coverage.gaps.some(g => g.reason.includes('ambiguous domain registration')))
  }
})

test('payload deletions through direct and aliased bindings remain unknown', () => {
  for (const mutation of ['delete args.id;', 'const alias = args; delete (alias as any).id;']) {
    const inventory = domainFixture(s => s.replace('return localRead(domain, verb, args)', `${mutation} return localRead(domain, verb, args)`))
    const provider = inventory.providers.find(p => p.operation === 'files.repos')
    assert.equal(provider.coverage, 'unknown')
    assert.equal(provider.routing.transports[0].coverage, 'unknown')
  }
})

test('mutations before a selected transport case remain unknown', () => {
  for (const mutation of ["domain = 'absent';", "args.id = 'replacement';"]) {
    const inventory = domainFixture(s => s.replace('switch(type)', `${mutation} switch(type)`))
    const provider = inventory.providers.find(p => p.operation === 'files.repos')
    assert.equal(provider.coverage, 'unknown')
    assert.equal(provider.routing.transports[0].coverage, 'unknown')
  }
})

test('unsupported payload aliases and escapes remain unknown', () => {
  for (const mutation of [
    "let alias = args; alias.id = 'replacement';",
    'let alias = args; delete alias.id;',
    "const holder = {args}; holder.args.id = 'replacement';",
    "const holder: any = {}; holder.args = args; holder.args.id = 'replacement';",
    "const {id} = args;",
  ]) {
    const inventory = domainFixture(s => s.replace('return localRead(domain, verb, args)', `${mutation} return localRead(domain, verb, args)`))
    const provider = inventory.providers.find(p => p.operation === 'files.repos')
    assert.equal(provider.coverage, 'unknown', mutation)
    assert.equal(provider.routing.transports[0].coverage, 'unknown', mutation)
  }
})


test('unsupported intermediate payloads preserve independent allowlist evidence', () => {
  const inventory = domainFixture(
    s => s + 'class Service { read(domain: string, verb: string, args: object) {return localRead(domain, verb, {})} }',
    c => ({...c, domainRoutes: c.domainRoutes.map(d => ({...d, transports: d.transports.map(t => ({...t, via: [{path: 'api.ts', receiver: 'Service', function: 'read', forward: 'localRead'}]}))}))}),
  )
  const transport = inventory.providers.find(p => p.operation === 'files.repos').routing.transports[0]
  assert.equal(transport.coverage, 'unknown')
  assert.match(transport.reason, /intermediate argument/)
  assert.equal(transport.allowlisted, true)
})
