import assert from 'node:assert/strict';
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
  test('re-exported primitive alias reaches caller census', () => {
    writeFileSync(join(root, 'facade.ts'), "export {spawn as launch} from 'node:child_process';");
    const data = audit(root, "import {launch as go} from './facade.ts'; go('ps', []);");
    data.files.push({path: 'facade.ts', siblingClosure: true});
    const result = validate(ts, root, data);
    assert.equal(result.ok, false);
    assert(result.capabilityGroups.some(row => row.path === 'entry.ts' && row.module === './facade.ts'));
  });
  test('stale citations fail', () => {
    const data = audit(root, 'const harmless = 1;', {capabilityReferences: [{path: 'entry.ts', line: 1, module: 'node:child_process', kind: 'reference'}]});
    assert(validate(ts, root, data).errors.some(value => value.includes('stale census')));
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
