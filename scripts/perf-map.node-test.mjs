import { execFileSync } from 'node:child_process'
// Test template for a generated perf map. Copy beside the copied perf-map.mjs and
// adjust the import path and fixture to the repo's census config. Runs with `node --test`.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { census, drift, loadConfig, loadSchema, validateAgainst, checkReceipt, renderIndex, metricCounts } from './perf-map.mjs'

const SCHEMA_DIR = new URL('../.agents/skills/perf-honeybee/workloads/', import.meta.url).pathname // directory holding record.schema.json

function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), 'perf-map-'))
  const w = (p, text) => { mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), text) }
  w('src/routes.ts', "export const Routes = {\n  Home: 'home',\n  Search: 'search',\n}\n")
  w('src/server.ts', "const t = setInterval(() => {}, 1000)\n// setInterval( in a comment must not count\nconst s = createServer()\nconst child = spawn('git', [])\n")
  w('src/server.test.ts', 'setInterval(() => {}, 1)\n')
  w('src/api/users.ts', "router.get('/users', h)\nrouter.post('/users', h)\n")
  w('map/census.config.json', JSON.stringify({
    version: 1, sourceRoots: ['src'], extensions: '\\.ts$', exclude: '(\\.test\\.)',
    registries: [{ inventory: 'entry-points', prefix: 'route:', file: 'src/routes.ts', kind: 'const-map', name: 'Routes' }],
    patterns: [
      { inventory: 'work-triggers', prefix: 'timer:', regex: '\\bsetInterval\\(', mode: 'ordinal' },
      { inventory: 'boundaries', prefix: 'socket:', regex: '\\bcreateServer\\(', mode: 'ordinal' },
      { inventory: 'resource-owners', prefix: 'spawn:', regex: '\\bspawn\\(', mode: 'file' },
      { inventory: 'entry-points', prefix: 'api:', regex: "router\\.(get|post)\\('([^']+)'", mode: 'capture', keyTemplate: '{1} {2}' },
    ],
  }))
  return root
}

test('census is deterministic, sorted, and skips tests and comments', () => {
  const root = fixtureRepo()
  const cfg = loadConfig(join(root, 'map'))
  const a = census(root, cfg)
  const b = census(root, cfg)
  assert.deepEqual(a, b)
  const keys = a.entries.map((e) => e.key)
  assert.deepEqual(keys, [...keys].sort())
  assert.deepEqual(keys, ['api:get /users', 'api:post /users', 'route:home', 'route:search', 'socket:src/server.ts#1', 'spawn:src/server.ts', 'timer:src/server.ts#1'])
  for (const e of a.entries) assert.match(e.blob, /^[0-9a-f]{40}$/)
})

test('drift reports unaccounted keys, dead accounts, prefix coverage, and changed owners', () => {
  const root = fixtureRepo()
  const data = census(root, loadConfig(join(root, 'map')))
  const record = sampleRecord()
  record.accounts = [{ inventory: 'entry-points', key: 'route:*' }, { inventory: 'boundaries', key: 'socket:src/server.ts#1' }, { inventory: 'boundaries', key: 'socket:gone#1' }]
  record.owners = ['src/server.ts@' + 'f'.repeat(40)]
  const report = drift(data, [{ file: 'x.json', record }], { gaps: [{ key: 'timer:*', reason: 'test' }] })
  const un = report.unaccounted.map((e) => e.key)
  assert.deepEqual(un, ['api:get /users', 'api:post /users', 'spawn:src/server.ts'])
  assert.deepEqual(report.dead, [{ key: 'socket:gone#1', workload: record.id }])
  assert.equal(report.staleOwners.length, 1)
})

test('records validate against the schema and the index renders', () => {
  const schema = loadSchema(SCHEMA_DIR)
  const good = sampleRecord()
  assert.deepEqual(validateAgainst(schema, good), [])
  const bad = structuredClone(good)
  bad.lane = 'vibes'
  assert.ok(validateAgainst(schema, bad).some((e) => e.includes('$.lane')))
  assert.match(renderIndex([{ file: 'x.json', record: good }], { gaps: [] }), /\| \[Sample\]\(\.\/sample\.md\)/)
  assert.deepEqual(metricCounts(good), { gap: 0, 'recipe-only': 1, measured: 0, stale: 0, gated: 0 })
})

test('check is conservative', () => {
  const record = sampleRecord()
  record.metrics = [
    { id: 'effectMs', unit: 'ms', scope: 'app', collector: 'x', aggregation: 'median', kind: 'actual', status: 'measured', states: ['repeated'], betterWhen: 'lower', budget: { value: 50, unit: 'ms', status: 'ruled', source: 's' }, baseline: { seriesId: 'S1', receipt: 'r', commit: 'c', samples: 5, machine: 'm', runtime: 'node', buildMode: 'built', median: 40 } },
    { id: 'calls', unit: 'count', scope: 'app', collector: 'x', aggregation: 'sum', kind: 'actual', status: 'gated', states: ['repeated'], betterWhen: 'lower', invariant: 'zero calls', baseline: { seriesId: 'S1', receipt: 'r', commit: 'c', samples: 3, machine: 'm', runtime: 'node', buildMode: 'built', aggregation: 'sum', aggregate: 0 } },
  ]
  const records = [{ file: 'sample.json', record }]
  const run = (results, seriesId = 'S1') => checkReceipt({ workload: 'sample', seriesId, results }, records, 0.1).verdict
  assert.equal(run([{ metric: 'effectMs', samples: [41, 39, 42, 40, 38] }, { metric: 'calls', samples: [0], invariantHolds: true }]), 'pass')
  assert.equal(run([{ metric: 'effectMs', samples: [48, 47, 49, 46, 48] }]), 'regression')
  assert.equal(run([{ metric: 'effectMs', samples: [60, 61, 59] }]), 'fail')
  assert.equal(run([{ metric: 'calls', samples: [1], invariantHolds: false }]), 'fail')
  assert.equal(run([{ metric: 'calls', samples: [0] }]), 'inconclusive')
  assert.equal(run([{ metric: 'effectMs', samples: [10, 10, 10] }], 'S2'), 'not-comparable')
  assert.equal(run([{ metric: 'effectMs', samples: [10] }]), 'inconclusive')
  assert.equal(run([]), 'inconclusive')
})

function sampleRecord() {
  return {
    protocolVersion: 1, id: 'sample', title: 'Sample', lane: 'interaction', processes: ['renderer'],
    effect: { user: 'A view opens.', assertions: ['the view is active'] },
    accounts: [{ inventory: 'entry-points', key: 'route:home' }],
    states: { idle: { matters: false, why: 'n/a' }, 'first-use': { matters: true, why: 'cold' }, repeated: { matters: true, why: 'warm' }, scale: { matters: false, why: 'n/a' }, background: { matters: false, why: 'n/a' }, release: { matters: false, why: 'n/a' }, recovery: { matters: false, why: 'n/a' } },
    metrics: [{ id: 'effectMs', unit: 'ms', scope: 'renderer', collector: 'driver', aggregation: 'median', kind: 'actual', status: 'recipe-only', states: ['repeated'], betterWhen: 'lower' }],
    updatedAt: '2026-01-01',
  }
}

test('invalid tolerance cannot turn a baseline regression into a pass', async () => {
  const { checkResult } = await import('./perf-map.mjs')
  const record = { id: 'bounded', metrics: [{ id: 'work', unit: 'count', aggregation: 'sum', kind: 'actual', betterWhen: 'lower', baseline: { seriesId: 'S', aggregation: 'sum', aggregate: 10 } }] }
  const result = { metric: 'work', samples: [100] }
  const receipt = { seriesId: 'S' }
  assert.equal(checkResult(record, result, receipt).verdict, 'regression')
  assert.equal(checkResult(record, result, receipt, 0).verdict, 'regression')
  for (const tolerance of [NaN, Infinity, -Infinity, -1, 'not-a-number']) {
    assert.throws(() => checkResult(record, result, receipt, tolerance), /tolerance must be a finite non-negative number/)
  }
})


test('zero-width census patterns advance even through skipped comments', () => {
  const root = fixtureRepo()
  const config = JSON.parse(readFileSync(join(root, 'map/census.config.json'), 'utf8'))
  config.patterns = [{ inventory: 'boundaries', prefix: 'line:', regex: '^', flags: 'm', mode: 'ordinal' }]
  writeFileSync(join(root, 'map/census.config.json'), JSON.stringify(config))
  const script = `import { census, loadConfig } from ${JSON.stringify(new URL('./perf-map.mjs', import.meta.url).href)};
    console.log(JSON.stringify(census(${JSON.stringify(root)}, loadConfig(${JSON.stringify(join(root, 'map'))})).counts));`
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 2000, encoding: 'utf8' })
  assert.ok(JSON.parse(output).boundaries > 0)
})
