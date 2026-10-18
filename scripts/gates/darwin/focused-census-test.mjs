import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { analyze, validate } from './focused-census.mjs';

const ts = createRequire(import.meta.url)(process.argv[2]);
let count = 0;
function test(name, run) { run(); count++; console.log('PASS ' + name); }
function audit(root, content, extra = {}) {
  writeFileSync(join(root, 'entry.ts'), content);
  return {files: [{path: 'entry.ts', siblingClosure: true}], packages: [], spawns: [], capabilityReferences: [], nativeEdges: [], ...extra};
}
const root = mkdtempSync(join(tmpdir(), 'census-unit-'));
try {
  test('reader lifetime requirement permits only omitted or boolean reviewed values', () => {
    for (const value of [false, true]) assert.equal(validate(ts, root, audit(root, '', {readerLifetimeBarrierRequired: value})).errors.some(error => error.includes('requirement must be boolean')), false);
    for (const value of [null, 0, 1, 'true', [], {}]) assert.equal(validate(ts, root, audit(root, '', {readerLifetimeBarrierRequired: value})).errors.some(error => error.includes('requirement must be boolean')), true);
  });
  test('all static, side-effect and export edges', () => {
    for (const text of ["import './missing.ts';", "import 'unknown-package';", "export * from './missing.ts';", "export {x} from './missing.ts';", "import x = require('./missing.ts');"]) assert.equal(validate(ts, root, audit(root, text)).ok, false);
  });
  test('all nonliteral imports and require aliases refuse', () => {
    for (const text of ['await import(variable);', 'require(variable);', "import {createRequire as cr} from 'node:module'; const req=cr(import.meta.url); req(variable);"]) {
      const result = validate(ts, root, audit(root, text));
      assert.equal(result.ok, false);
      assert(result.errors.some(value => value.includes('nonliteral')));
    }
  });
  test('aliased spawn and computed namespace calls are found', () => {
    for (const text of ["import {spawn as launch} from 'node:child_process'; launch('ps', []);", "import * as cp from 'child_process'; cp['spawn']('ps', []);", "const cp=await import('node:child_process'); cp.execFileSync('ps');"]) {
      const result = analyze(ts, 'entry.ts', text);
      assert(result.calls.some(call => call.executable === 'ps'));
      assert.equal(validate(ts, root, audit(root, text)).ok, false);
    }
  });
  test('manual review cannot relabel a literal ps executable as node', () => {
    const text = "import {spawn as launch} from 'node:child_process';\nlaunch('ps', []);";
    const data = audit(root, text, {capabilityReferences: [{path: 'entry.ts', line: 1, module: 'node:child_process', kind: 'import'}], spawns: [{path: 'entry.ts', line: 2, executable: 'node', manualReview: true}]});
    assert(validate(ts, root, data).errors.some(value => value.includes('literal executable')));
  });
  test('module factories, process bindings and workers are capabilities', () => {
    for (const text of ["import {createRequire as cr} from 'node:module'; cr(import.meta.url);", "const p=process; p['binding']('spawn_sync');", "import {Worker as W} from 'node:worker_threads'; new W('entry.js');"]) assert(analyze(ts, 'entry.ts', text).capabilities.length > 0);
  });
  test('workerData and parentPort remain data through properties and optional chains', () => {
    const text = ["import {workerData,parentPort} from 'node:worker_threads';", 'const data=workerData as PoolWorkerData;', 'const sha=data.request.sha ?? resolveCellBase(data.request.originRepo)?.sha;', 'parentPort?.postMessage({sha});'].join('\n');
    const result = analyze(ts, 'entry.ts', text);
    assert.deepEqual(result.capabilities, [{line: 1, module: 'node:worker_threads', kind: 'import'}]);
    assert.deepEqual(result.calls, []);
    const namespace = analyze(ts, 'entry.ts', "import wt from 'node:worker_threads';\nconst data=wt.workerData;\nconst sha=data?.request?.sha ?? 'none';\nwt.parentPort.postMessage(sha);");
    assert.deepEqual(namespace.capabilities, [{line: 1, module: 'node:worker_threads', kind: 'import'}]);
    assert.deepEqual(namespace.calls, []);
  });
  test('Worker constructors and destructured aliases remain capabilities', () => {
    for (const text of ["import {Worker} from 'node:worker_threads'; new Worker('reader.mjs');", "import * as wt from 'node:worker_threads'; const {Worker: W}=wt; new W('reader.mjs');", "import * as wt from 'node:worker_threads'; let W; ({Worker:W}=wt); new W('reader.mjs');", "import wt from 'node:worker_threads'; new wt.Worker('reader.mjs');"]) {
      assert(analyze(ts, 'entry.ts', text).calls.some(row => row.module === 'node:worker_threads'));
    }
    assert.equal(validate(ts, root, audit(root, "import * as wt from 'node:worker_threads'; const W=wt[name];")).error?.type, 'CensusFailure');
  });
  test('cluster startup exports are capabilities and cluster state is data', () => {
    const text = "import cluster,{isPrimary,isWorker,worker} from 'node:cluster';\nconst state=isPrimary || isWorker; const pid=worker?.process?.pid;\ncluster.worker?.send({state});\ncluster.fork(); cluster.setupPrimary({}); new cluster.Worker({});";
    const result = analyze(ts, 'entry.ts', text);
    assert(!result.capabilities.some(row => [2,3].includes(row.line)));
    assert.equal(result.calls.length, 3);
  });
  test('module loader mutation exports remain sensitive and unknown exports fail', () => {
    for (const text of ["import {register} from 'node:module'; register('loader.mjs');", "import {Module} from 'node:module'; Module._load('reader.mjs');", "import Module from 'node:module'; const handlers=Module._extensions;", "import Module from 'node:module'; const load=Module.prototype.require;", "import {syncBuiltinESMExports} from 'node:module'; syncBuiltinESMExports();"]) {
      assert(analyze(ts, 'entry.ts', text).capabilities.some(row => row.kind === 'reference' || row.kind === 'binding'));
    }
    for (const text of ["import {unreviewed} from 'node:module';", "import Module from 'node:module'; Module.unreviewed();", "import Module from 'node:module'; const method=Module[name];"]) {
      assert.equal(validate(ts, root, audit(root, text)).error?.type, 'CensusFailure');
    }
  });
  test('re-exported builtin namespaces preserve data and loader distinctions', () => {
    writeFileSync(join(root, 'facade.ts'), "export * from 'node:worker_threads';");
    let data = audit(root, "import {workerData,Worker} from './facade.ts';\nconst sha=workerData.request.sha ?? 'none';\nnew Worker('reader.mjs');");
    data.files.push({path: 'facade.ts', siblingClosure: true});
    let result = validate(ts, root, data);
    assert(!result.error);
    assert(!result.capabilityGroups.some(row => row.path === 'entry.ts' && row.line === 2));
    assert(result.capabilityGroups.some(row => row.path === 'entry.ts' && row.line === 3));
    writeFileSync(join(root, 'facade.ts'), "export * from 'node:module';");
    data = audit(root, "import {unreviewed} from './facade.ts';");
    data.files.push({path: 'facade.ts', siblingClosure: true});
    assert.equal(validate(ts, root, data).error?.type, 'CensusFailure');
    writeFileSync(join(root, 'facade.ts'), "export {createRequire as default} from 'node:module';");
    data = audit(root, "import cr from './facade.ts'; const req=cr(import.meta.url); req(variable);");
    data.files.push({path: 'facade.ts', siblingClosure: true});
    result = validate(ts, root, data);
    assert(result.errors.some(value => value.includes('nonliteral module edge')));
  });
  test('re-exported primitive alias reaches caller census', () => {
    writeFileSync(join(root, 'facade.ts'), "export {spawn as launch} from 'node:child_process';");
    const data = audit(root, "import {launch as go} from './facade.ts'; go('ps', []);");
    data.files.push({path: 'facade.ts', siblingClosure: true});
    const result = validate(ts, root, data);
    assert.equal(result.ok, false);
    assert(result.capabilityGroups.some(row => row.path === 'entry.ts' && row.module === 'node:child_process'));
  });
  test('stale citations fail', () => {
    const data = audit(root, 'const harmless = 1;', {capabilityReferences: [{path: 'entry.ts', line: 1, module: 'node:child_process', kind: 'reference'}]});
    assert(validate(ts, root, data).errors.some(value => value.includes('stale census')));
  });
  test('scoped aliases do not taint wrapper callers, result data, or property names', () => {
    const text = [
      "import {spawn} from 'node:child_process';",
      'export function wrapper() { return spawn("node", []); }',
      'const result = wrapper();',
      'result.on("exit", () => {});',
      'const child = spawn("node", []);',
      'child.on("exit", () => {});',
      'function unrelated(spawn) { spawn("harmless"); }',
      'const object = {spawn: 1}; object.spawn;',
      'const direct = spawn;',
      'direct("node", []);',
    ].join('\n');
    const result = analyze(ts, 'entry.ts', text);
    assert.deepEqual([...new Set(result.capabilities.map(row => row.line))], [1, 2, 5, 9, 10]);
    assert.equal(result.exports.wrapper, undefined);
    assert.deepEqual(result.calls.map(row => row.line), [2, 5, 10]);
  });
  test('untyped calls with function-expression and object-method arguments use binding only', () => {
    const text = ["import {spawn} from 'node:child_process';", 'untyped(function callback(value) { const result = spawn("node", []); return value(result); });', 'untyped({method(value) { return value(() => spawn("node", [])); }});', 'untyped((spawn) => spawn("unrelated"));'].join('\n');
    const bindingOnly = new Proxy(ts, {get(target, name) { if (['createProgram', 'createTypeChecker'].includes(name)) throw new Error('type checking forbidden'); return target[name]; }});
    const result = analyze(bindingOnly, 'entry.ts', text);
    assert.deepEqual(result.calls.map(row => row.line), [2, 3]);
  });
  test('a per-file exception returns one typed failure and no partial census', () => {
    const data = audit(root, 'untyped(function (value) { return value; });');
    const broken = new Proxy(ts, {get(target, name) { if (name === 'bindSourceFile') return () => { throw new TypeError("Cannot read properties of undefined (reading 'flags')"); }; return target[name]; }});
    const result = validate(broken, root, data);
    assert.equal(result.ok, false);
    assert.equal(result.error.type, 'CensusFailure');
    assert.equal(result.error.path, 'entry.ts');
    assert.equal(result.error.phase, 'syntax-binding');
    assert.equal(result.capabilityGroups, undefined);
    assert.equal(result.edges, undefined);
  });
  test('real-source minimized untyped callback crash regression', () => {
    const text = 'import {createInterface} from "node:readline"; createInterface({input:process.stdin}).on("line", function(raw) { return JSON.parse(raw); });';
    const result = analyze(ts, 'entry.mjs', text);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.capabilities, []);
    assert.equal(result.edges[0].specifier, 'node:readline');
  });
  test('destructuring and assignment aliases remain direct capabilities', () => {
    const result = analyze(ts, 'entry.ts', "import * as cp from 'node:child_process';\nconst {spawn: launch} = cp;\nlet again; again = launch;\nagain('node', []);");
    assert(result.calls.some(row => row.line === 4 && row.module === 'node:child_process'));
    assert(result.capabilities.some(row => row.line === 2 && row.kind === 'binding'));
    assert(result.capabilities.some(row => row.line === 3 && row.kind === 'binding'));
  });
  test('object and array assignment patterns include nested defaults and rest', () => {
    const forms = [
      "let launch; ({spawn:launch}=cp);",
      "let launch; ({['spawn']:launch}=cp);",
      "let launch; ([launch]=[cp.spawn]);",
      "let launch; ({nested:{spawn:launch}}={nested:cp});",
      "let launch; ([[launch]]=[[cp.spawn]]);",
      "let launch; ({spawn:launch=cp.spawn}={});",
      "let launch; ([launch=cp.spawn]=[]);",
      "const {nested:{spawn:launch}=cp}={};",
      "const [launch=cp.spawn]=[];",
      "let rest; ([,...rest]=[0,cp.spawn]); const [launch]=rest;",
      "let rest; ({...rest}=cp); const {spawn:launch}=rest;",
      "let launch; ({nested:{spawn:launch}=cp}={});",
    ];
    for (const form of forms) {
      const result = analyze(ts, 'entry.ts', "import * as cp from 'node:child_process';\n" + form + "\nlaunch('ps',[]);");
      assert(result.calls.some(row => row.callee === 'launch' && row.executable === 'ps'), form);
      assert(result.capabilities.some(row => row.kind === 'binding' && row.line === 2), form);
    }
    const parameter = analyze(ts, 'entry.ts', "import * as cp from 'node:child_process'; function f({spawn:launch}=cp) {launch('ps',[]);}");
    assert(parameter.calls.some(row => row.callee === 'launch'));
  });
  test('nested assignment aliases retain createRequire loader capability', () => {
    const text = "import * as mod from 'node:module'; let cr; ({createRequire:cr}=mod); const req=cr(import.meta.url); req(variable);";
    assert(analyze(ts, 'entry.ts', text).edges.some(row => row.kind === 'require' && row.specifier === null));
    const coalesced = analyze(ts, 'entry.ts', "import {createRequire} from 'node:module'; const bridge=(custom ?? createRequire(import.meta.url))(artifactPath);");
    assert(coalesced.edges.some(row => row.kind === 'require' && row.specifier === null));
  });
  test('unsupported sensitive binding forms return typed failures', () => {
    for (const form of ["holder.launch=cp.spawn;", "let launch; ({[key]:launch}=cp);", "let launch; launch ||= cp.spawn;", "const launch=condition ? cp.spawn : cp.execFile;", "const holder={[key]:cp.spawn};", "({spawn:holder.launch}=cp);", "for(const launch of [cp.spawn]) launch('ps');"]) {
      const result = validate(ts, root, audit(root, "import * as cp from 'node:child_process';\n" + form));
      assert.equal(result.ok, false, form);
      assert.equal(result.error?.type, 'CensusFailure', form);
      assert.equal(result.error?.path, 'entry.ts', form);
      assert.equal(result.error?.phase, 'binding', form);
      assert.equal(result.capabilityGroups, undefined, form);
    }
  });
  test('local re-export aliases keep builtin origin and wrappers do not propagate', () => {
    writeFileSync(join(root, 'facade.ts'), "import {spawn} from 'node:child_process';\nconst launch = spawn;\nexport {launch};\nexport function wrapper() { spawn('node', []); }");
    const data = audit(root, "import {launch, wrapper} from './facade.ts';\nlaunch('node', []);\nwrapper();");
    data.files.push({path: 'facade.ts', siblingClosure: true});
    const result = validate(ts, root, data);
    assert(result.capabilityGroups.some(row => row.path === 'entry.ts' && row.line === 2 && row.module === 'node:child_process'));
    assert(!result.capabilityGroups.some(row => row.path === 'entry.ts' && row.line === 3));
  });
  test('explicit type-only AST flags erase edges; mixed and value imports remain', () => {
    for (const text of ["import type {Thing} from './dormant.ts';", "import {type Thing} from './dormant.ts';", "export type {Thing} from './dormant.ts';", "export {type Thing} from './dormant.ts';", "import type X = require('./dormant.ts');"]) {
      assert.deepEqual(analyze(ts, 'entry.ts', text).edges, []);
      const output = ts.transpileModule(text, {compilerOptions: {module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true}}).outputText;
      assert.equal(analyze(ts, 'entry.ts', text, {}, {verbatimModuleSyntax: true}).edges.length, output.includes('dormant') ? 1 : 0);
    }
    for (const text of ["import {type Thing, value} from './live.ts';", "import {Thing} from './live.ts';", "import './live.ts';"]) assert.equal(analyze(ts, 'entry.ts', text).edges.length, 1);
    assert.deepEqual(analyze(ts, 'entry.ts', "import type {spawn} from 'node:child_process';\nlet value: typeof spawn;").capabilities, []);
  });
  test('candidate tsconfig flags preserve empty value-import side effects', () => {
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({compilerOptions: {verbatimModuleSyntax: true}}));
    const data = audit(root, "import {type Thing} from './dormant.ts';");
    const result = validate(ts, root, data);
    assert(result.errors.some(value => value.includes('unpinned module edge')));
    assert.equal(result.compilerConfigPins.length, 1);
    rmSync(join(root, 'tsconfig.json'));
  });
  test('entry pins are required, exact, separate from capability citations', () => {
    const text = "const wrapper = {command: 'sandbox-exec'};\nconst reader = new URL('./reader.ts', import.meta.url);";
    const data = audit(root, text, {entryPins: [{path: 'entry.ts', line: 1, context: text.split('\n')[0], role: 'production-sandbox-exec'}, {path: 'entry.ts', line: 2, context: text.split('\n')[1], role: 'reader-entry'}]});
    let result = validate(ts, root, data);
    assert.equal(result.ok, true);
    assert.deepEqual(result.capabilityGroups, []);
    data.entryPins[0].context = 'changed';
    assert.equal(validate(ts, root, data).ok, false);
    data.entryPins = [];
    assert.equal(validate(ts, root, data).ok, false);
  });
  test('Node reader pin must equal the cited literal URL and closure hash', () => {
    const text = "const reader=new URL('./reader.mjs', import.meta.url);\nconst wrapper='sandbox-exec';";
    const data = audit(root, text, {entryPins: [{path: 'entry.ts', line: 1, context: text.split('\n')[0], role: 'reader-entry'}, {path: 'entry.ts', line: 2, context: text.split('\n')[1], role: 'production-sandbox-exec'}]});
    for (const [name, content] of [['entry.ts', text], ['reader.mjs', ''], ['host.ts', '']]) {
      writeFileSync(join(root, name), content);
      const pin = {path: name, siblingClosure: true, sha256: createHash('sha256').update(content).digest('hex')};
      if (name === 'entry.ts') data.files[0] = pin; else data.files.push(pin);
    }
    data.nodeEntries = [['test-runner', 'entry.ts'], ['reader', 'reader.mjs'], ['runner-host-main', 'host.ts']].map(([role, path]) => ({role, path, sha256: data.files.find(row => row.path === path).sha256}));
    assert.equal(validate(ts, root, data).ok, true);
    data.nodeEntries[1] = {...data.nodeEntries[1], path: 'host.ts'};
    assert.equal(validate(ts, root, data).ok, false);
    data.nodeEntries[1] = {role: 'reader', path: 'reader.mjs', sha256: '0'.repeat(64)};
    assert.equal(validate(ts, root, data).ok, false);
  });
  test('network modules and unshadowed network globals require citations', () => {
    const result = analyze(ts, 'network.ts', "import * as net from 'node:net';\nnet.connect(443);\nconst request=fetch;\nrequest('https://fixture.invalid');\nnew WebSocket('wss://fixture.invalid');\nglobalThis.fetch('https://fixture.invalid');");
    for (const module of ['node:net', 'global:fetch', 'global:WebSocket']) assert.ok(result.capabilities.some(row => row.module === module));
    const aliases = analyze(ts, 'global-aliases.ts', "const {fetch:request}=globalThis; request('https://fixture.invalid'); const g=global; new g.WebSocket('wss://fixture.invalid');");
    assert.ok(aliases.capabilities.some(row => row.module === 'global:fetch'));
    assert.ok(aliases.capabilities.some(row => row.module === 'global:WebSocket'));
    assert.equal(analyze(ts, 'shadow.ts', 'function fixture(fetch, WebSocket) { fetch(); new WebSocket(); }').capabilities.length, 0);
  });
  test('ESM conditional exports and legacy main match Node import resolution', () => {
    for (const name of ['ajv', 'jsonc-parser', 'smol-toml']) {
      const directory = join(root, 'node_modules', name);
      mkdirSync(join(directory, 'dist'), {recursive: true});
      mkdirSync(join(directory, 'lib/umd'), {recursive: true});
      writeFileSync(join(directory, 'dist/index.js'), 'export default 1;');
      writeFileSync(join(directory, 'dist/index.cjs'), 'module.exports=2;');
      writeFileSync(join(directory, 'dist/2020.js'), 'module.exports=3;');
      writeFileSync(join(directory, 'lib/umd/main.js'), 'module.exports=4;');
      const pkg = {name, version: '1.0.0', main: 'lib/umd/main.js', module: 'dist/index.js'};
      if (name === 'smol-toml') pkg.exports = {import: './dist/index.js', require: './dist/index.cjs'};
      writeFileSync(join(directory, 'package.json'), JSON.stringify(pkg));
    }
    const script = join(root, 'resolver.mjs');
    copyFileSync(fileURLToPath(new URL('./focused-packages.mjs', import.meta.url)), script);
    const rows = JSON.parse(execFileSync(process.execPath, [script], {cwd: root, env: {PATH: process.env.PATH, HOME: root, TMPDIR: root, LANG: 'C'}, encoding: 'utf8', timeout: 5000}));
    assert.equal(rows.find(row => row.specifier === 'smol-toml').path, 'node_modules/smol-toml/dist/index.js');
    assert.equal(rows.find(row => row.specifier === 'jsonc-parser').path, 'node_modules/jsonc-parser/lib/umd/main.js');
    assert.equal(rows.find(row => row.specifier === 'ajv/dist/2020.js').path, 'node_modules/ajv/dist/2020.js');
  });
} finally { rmSync(root, {recursive: true, force: true}); }
console.log('AST/ESM unit rows PASS ' + count);
