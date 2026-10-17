import { readFileSync, realpathSync, statSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const sensitive = new Set(['child_process', 'worker_threads', 'cluster', 'module']);
const builtins = new Set(builtinModules.map(value => value.replace(/^node:/, '')));
const normalize = value => value.replace(/^node:/, '');

export function analyze(ts, path, text, imported = {}) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const edges = [], capabilities = [], calls = [], errors = [];
  const aliases = new Map(), factories = new Set(), requires = new Set(['require']), constants = new Map(), assignments = new Set(), processAliases = new Set(['process']), declarations = new Map();
  const line = node => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const literal = node => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
  const walk = (node, action) => { action(node); ts.forEachChild(node, child => walk(child, action)); };
  const names = node => ts.isIdentifier(node) ? [node.text] : node?.elements ? node.elements.flatMap(item => item.name ? names(item.name) : []) : [];
  const member = node => ts.isPropertyAccessExpression(node) ? node.name.text : ts.isElementAccessExpression(node) ? literal(node.argumentExpression) : null;
  const object = node => ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) ? node.expression : null;
  const unwrap = node => node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isAwaitExpression(node)) ? unwrap(node.expression) : node;
  const factory = value => { const node = unwrap(value); return !!node && (ts.isIdentifier(node) && factories.has(node.text) || object(node) && member(node) === 'createRequire' && ts.isIdentifier(object(node)) && (object(node).text === 'module' || normalize(aliases.get(object(node).text) ?? '') === 'module')); };
  const loader = value => { const node = unwrap(value); return !!node && (ts.isIdentifier(node) && requires.has(node.text) || ts.isCallExpression(node) && factory(node.expression) || object(node) && member(node) === 'require' && ts.isIdentifier(object(node)) && object(node).text === 'module'); };
  const edge = (node, specifier, kind = 'import') => edges.push({line: line(node), kind, specifier: literal(specifier), expression: specifier?.getText(source) ?? ''});
  walk(source, node => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isImportSpecifier(node) || ts.isNamespaceImport(node) || ts.isFunctionDeclaration(node)) for (const name of node.name ? names(node.name) : []) declarations.set(name, (declarations.get(name) ?? 0) + 1);
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) && node.moduleSpecifier) {
      edge(node, node.moduleSpecifier);
      const specifier = literal(node.moduleSpecifier);
      if (ts.isImportDeclaration(node) && node.importClause && imported[specifier]) {
        const clause = node.importClause;
        if (clause.name && imported[specifier].default) aliases.set(clause.name.text, specifier);
        if (clause.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings) && Object.keys(imported[specifier]).length) aliases.set(clause.namedBindings.name.text, specifier);
          else if (ts.isNamedImports(clause.namedBindings)) for (const item of clause.namedBindings.elements) {
            const origin = imported[specifier][(item.propertyName ?? item.name).text];
            if (origin) aliases.set(item.name.text, specifier);
            if (origin === 'factory') factories.add(item.name.text);
            if (origin === 'loader') requires.add(item.name.text);
          }
        }
      }
      if (specifier && sensitive.has(normalize(specifier))) {
        capabilities.push({line: line(node), module: specifier, kind: 'import'});
        if (ts.isImportDeclaration(node) && node.importClause) {
          const clause = node.importClause;
          if (clause.name) aliases.set(clause.name.text, specifier);
          if (clause.namedBindings) {
            if (ts.isNamespaceImport(clause.namedBindings)) aliases.set(clause.namedBindings.name.text, specifier);
            else for (const item of clause.namedBindings.elements) {
              if (normalize(specifier) !== 'module' || (item.propertyName ?? item.name).text === 'createRequire') aliases.set(item.name.text, specifier);
              if (normalize(specifier) === 'module' && (item.propertyName ?? item.name).text === 'createRequire') factories.add(item.name.text);
            }
          }
        }
      }
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      edge(node, node.moduleReference.expression);
      const specifier = literal(node.moduleReference.expression);
      if (specifier && sensitive.has(normalize(specifier))) aliases.set(node.name.text, specifier);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isVariableDeclarationList(node.parent) && node.parent.flags & ts.NodeFlags.Const) {
      if (constants.has(node.name.text)) constants.set(node.name.text, null);
      else constants.set(node.name.text, node.initializer);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && ts.isIdentifier(node.left)) assignments.add(node.left.text);
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && ts.isIdentifier(node.operand)) assignments.add(node.operand.text);
  });
  for (const [name, count] of declarations) if (count > 1) constants.set(name, null);
  for (let turn = 0; turn <= text.length; turn++) {
    let changed = false;
    walk(source, node => {
      if (ts.isFunctionDeclaration(node) && node.name && node.body) {
        let origin;
        walk(node.body, child => { if (ts.isIdentifier(child) && aliases.has(child.text)) origin ??= aliases.get(child.text); });
        if (origin && !aliases.has(node.name.text)) { aliases.set(node.name.text, origin); changed = true; }
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
        let origin;
        walk(node.right, child => { if (ts.isIdentifier(child) && aliases.has(child.text)) origin ??= aliases.get(child.text); });
        if (origin && !aliases.has(node.left.text)) { aliases.set(node.left.text, origin); changed = true; }
        if (ts.isIdentifier(node.right) && requires.has(node.right.text) && !requires.has(node.left.text)) { requires.add(node.left.text); changed = true; }
        if (ts.isIdentifier(node.right) && processAliases.has(node.right.text) && !processAliases.has(node.left.text)) { processAliases.add(node.left.text); changed = true; }
      }
      if (!ts.isVariableDeclaration(node) || !node.initializer) return;
      let origin;
      walk(node.initializer, child => {
        if (ts.isIdentifier(child) && aliases.has(child.text)) origin ??= aliases.get(child.text);
        if (object(child) && processAliases.has(object(child).getText(source)) && ['binding', 'dlopen'].includes(member(child))) origin ??= 'node:process';
        if (ts.isCallExpression(child) && (loader(child.expression) || child.expression.kind === ts.SyntaxKind.ImportKeyword)) {
          const specifier = literal(child.arguments[0]);
          if (specifier && sensitive.has(normalize(specifier))) origin ??= specifier;
        }
      });
      for (const name of names(node.name)) {
        if (ts.isIdentifier(node.initializer) && node.initializer.text === 'module' && !aliases.has(name)) { aliases.set(name, 'node:module'); changed = true; }
        if (origin && !aliases.has(name)) { aliases.set(name, origin); changed = true; }
        if (ts.isIdentifier(node.initializer) && requires.has(node.initializer.text) && !requires.has(name)) { requires.add(name); changed = true; }
        const initializer = unwrap(node.initializer);
        if (ts.isCallExpression(initializer) && factory(initializer.expression) && !requires.has(name)) { requires.add(name); changed = true; }
        if (factory(node.initializer) && !factories.has(name)) { factories.add(name); changed = true; }
        if (ts.isIdentifier(node.initializer) && processAliases.has(node.initializer.text) && !processAliases.has(name)) { processAliases.add(name); changed = true; }
        if (origin && normalize(origin) === 'module' && ts.isObjectBindingPattern(node.name)) {
          for (const item of node.name.elements) if ((item.propertyName ?? item.name).getText(source) === 'createRequire' && ts.isIdentifier(item.name) && !factories.has(item.name.text)) { factories.add(item.name.text); changed = true; }
        }
        if (ts.isIdentifier(node.initializer) && processAliases.has(node.initializer.text) && ts.isObjectBindingPattern(node.name)) for (const item of node.name.elements) if (['binding', 'dlopen'].includes((item.propertyName ?? item.name).getText(source)) && ts.isIdentifier(item.name) && !aliases.has(item.name.text)) { aliases.set(item.name.text, 'node:process'); changed = true; }
      }
    });
    if (!changed) break;
    if (turn === text.length) errors.push('alias closure did not converge');
  }
  const executable = (node, seen = new Set()) => {
    const value = literal(node);
    if (value !== null) return value;
    if (ts.isPropertyAccessExpression(node) && node.expression.getText(source) === 'process' && node.name.text === 'execPath' && !declarations.has('process')) return '$pinned-node';
    if (ts.isIdentifier(node) && constants.get(node.text) && !assignments.has(node.text) && !seen.has(node.text)) return executable(constants.get(node.text), new Set([...seen, node.text]));
    return null;
  };
  walk(source, node => {
    if (ts.isIdentifier(node) && aliases.has(node.text)) {
      const parent = node.parent;
      const kind = ts.isImportSpecifier(parent) || ts.isNamespaceImport(parent) || ts.isImportClause(parent) || ts.isImportEqualsDeclaration(parent) ? 'import' : ts.isVariableDeclaration(parent) && parent.name === node ? 'binding' : 'reference';
      capabilities.push({line: line(node), module: aliases.get(node.text), kind});
    }
    if (object(node) && processAliases.has(object(node).getText(source)) && (['binding', 'dlopen'].includes(member(node)) || ts.isElementAccessExpression(node) && member(node) === null)) capabilities.push({line: line(node), module: 'node:process', kind: 'reference'});
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const args = node.arguments ?? [];
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || loader(node.expression))) {
        edge(node, args[0], node.expression.kind === ts.SyntaxKind.ImportKeyword ? 'import' : 'require');
        const specifier = literal(args[0]);
        if (specifier && sensitive.has(normalize(specifier))) capabilities.push({line: line(node), module: specifier, kind: 'import'});
      }
      if (ts.isIdentifier(node.expression) && ['eval', 'Function'].includes(node.expression.text)) errors.push('dynamic code generation at ' + line(node));
      let origin;
      walk(node.expression, child => { if (ts.isIdentifier(child) && aliases.has(child.text)) origin ??= aliases.get(child.text); });
      if (origin || factory(node.expression) || object(node.expression) && processAliases.has(object(node.expression).getText(source)) && ['binding', 'dlopen'].includes(member(node.expression))) {
        origin ??= factory(node.expression) ? 'node:module' : 'node:process';
        const first = args[0];
        calls.push({line: line(node), module: origin, callee: node.expression.getText(source), expression: first?.getText(source) ?? '', executable: first ? executable(first) : null});
        capabilities.push({line: line(node), module: origin, kind: 'reference'});
      }
    }
  });
  const exports = {};
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      const specifier = statement.moduleSpecifier && literal(statement.moduleSpecifier);
      const direct = Object.fromEntries(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork', 'Worker', 'default'].map(name => [name, true]));
      direct.createRequire = 'factory';
      const available = specifier ? sensitive.has(normalize(specifier)) ? direct : imported[specifier] ?? {} : Object.fromEntries([...aliases].map(([name]) => [name, factories.has(name) ? 'factory' : requires.has(name) ? 'loader' : true]));
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const item of statement.exportClause.elements) if (available[(item.propertyName ?? item.name).text]) exports[item.name.text] = available[(item.propertyName ?? item.name).text];
      } else if (!statement.exportClause && specifier) Object.assign(exports, available);
    }
    if (ts.isVariableStatement(statement) && statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) for (const declaration of statement.declarationList.declarations) for (const name of names(declaration.name)) if (aliases.has(name)) exports[name] = factories.has(name) ? 'factory' : requires.has(name) ? 'loader' : true;
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) && aliases.has(statement.name.text)) exports[statement.name.text] = true;
  }
  for (const diagnostic of source.parseDiagnostics) errors.push('parse error ' + diagnostic.code);
  return {edges, capabilities: [...new Map(capabilities.map(row => [JSON.stringify(row), row])).values()], calls, exports, errors};
}

export function validate(ts, root, audit) {
  const errors = [], files = new Map(audit.files.map(row => [row.path, row])), groups = [], edges = [];
  const packageNames = new Set(audit.packages.map(row => row.specifier));
  const spawns = audit.spawns, references = audit.capabilityReferences, natives = audit.nativeEdges;
  const used = new Set();
  const resolveRelative = (specifier, absolute) => {
    const host = {
      fileExists: path => { const full = resolve(path); if (!full.startsWith(root + sep)) return false; try { return statSync(full).isFile(); } catch { return false; } },
      readFile: path => { const full = resolve(path); return full.startsWith(root + sep) ? readFileSync(full, 'utf8') : undefined; },
    };
    const resolved = ts.resolveModuleName(specifier, absolute, {moduleResolution: ts.ModuleResolutionKind.NodeNext}, host).resolvedModule;
    return resolved && relative(root, resolve(resolved.resolvedFileName));
  };
  const results = new Map();
  for (let pass = 0; pass <= audit.files.length; pass++) {
    let changed = false;
    for (const pin of audit.files.filter(row => row.siblingClosure)) {
      const absolute = resolve(root, pin.path), text = readFileSync(absolute, 'utf8');
      const source = ts.createSourceFile(pin.path, text, ts.ScriptTarget.Latest, true), imported = {};
      for (const statement of source.statements) if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text.startsWith('.')) {
        const target = resolveRelative(statement.moduleSpecifier.text, absolute);
        if (target && results.has(target)) imported[statement.moduleSpecifier.text] = results.get(target).exports;
      }
      const result = analyze(ts, pin.path, text, imported);
      if (JSON.stringify(result.exports) !== JSON.stringify(results.get(pin.path)?.exports)) changed = true;
      results.set(pin.path, result);
    }
    if (!changed) break;
    if (pass === audit.files.length) errors.push('export capability closure did not converge');
  }
  for (const pin of audit.files.filter(row => row.siblingClosure)) {
    const absolute = resolve(root, pin.path);
    if (realpathSync(absolute) !== absolute || !absolute.startsWith(root + sep)) { errors.push('redirected source ' + pin.path); continue; }
    const result = results.get(pin.path);
    errors.push(...result.errors.map(error => pin.path + ': ' + error));
    for (const edge of result.edges) {
      if (edge.specifier === null) {
        const matches = natives.filter(row => row.path === pin.path && row.line === edge.line && edge.kind === 'require');
        if (matches.length !== 1) errors.push('uncited nonliteral module edge ' + pin.path + ':' + edge.line);
        else used.add(matches[0]);
      } else if (builtins.has(normalize(edge.specifier))) {
      } else if (packageNames.has(edge.specifier)) {
      } else if (edge.specifier.startsWith('.')) {
        const destination = resolveRelative(edge.specifier, absolute);
        if (!destination || !files.get(destination)?.siblingClosure) errors.push('unpinned module edge ' + pin.path + ':' + edge.line + ' -> ' + edge.specifier);
        else edge.resolved = destination;
      } else errors.push('unresolved bare module edge ' + pin.path + ':' + edge.line + ' -> ' + edge.specifier);
      edges.push({path: pin.path, ...edge});
    }
    const grouped = new Map();
    for (const ref of result.capabilities) {
      const key = ref.line + ':' + ref.module + ':' + ref.kind;
      grouped.set(key, {...ref, path: pin.path});
    }
    for (const ref of grouped.values()) {
      const spawnEntries = spawns.filter(row => row.path === pin.path && row.line === ref.line);
      const referenceEntries = references.filter(row => row.path === pin.path && row.line === ref.line && row.module === ref.module && (row.kind === ref.kind || row.kind === 'unreachable-callsite' && ref.kind === 'reference'));
      if (spawnEntries.length + referenceEntries.length !== 1) errors.push('capability must have exactly one citation ' + pin.path + ':' + ref.line + ':' + ref.module + ':' + ref.kind);
      else used.add([...spawnEntries, ...referenceEntries][0]);
      if (spawnEntries.length === 1 && ref.kind !== 'reference' && !spawnEntries[0].manualReview) errors.push('import or binding citation requires manual review ' + pin.path + ':' + ref.line);
      groups.push(ref);
    }
    for (const call of result.calls) {
      const spawn = spawns.find(row => row.path === pin.path && row.line === call.line);
      const unreachable = references.find(row => row.path === pin.path && row.line === call.line && row.kind === 'unreachable-callsite');
      if (unreachable) {
        if (call.callee !== unreachable.callee || call.executable !== unreachable.executable) errors.push('unreachable callsite AST drift ' + pin.path + ':' + call.line);
        continue;
      }
      if (!spawn) continue;
      if (normalize(call.module) === 'child_process' && call.executable !== null) {
        const label = call.executable === '$pinned-node' || call.executable === 'node' ? 'node' : call.executable === '/usr/bin/sandbox-exec' ? 'production-sandbox-exec' : null;
        if (spawn.executable !== 'build-refused-prebuilt-only' && label !== spawn.executable) errors.push('literal executable does not match admitted label ' + pin.path + ':' + call.line);
      } else if (!spawn.manualReview) errors.push('manual executable/receiver review required ' + pin.path + ':' + call.line);
    }
    for (const spawn of spawns.filter(row => row.path === pin.path)) if (!spawn.manualReview && !result.calls.some(call => call.line === spawn.line)) errors.push('non-call citation requires manual review ' + pin.path + ':' + spawn.line);
  }
  for (const entry of [...spawns, ...references, ...natives]) if (!used.has(entry)) errors.push('stale census citation ' + entry.path + ':' + entry.line);
  return {ok: errors.length === 0, errors, edges, capabilityGroups: groups, convention: 'One spawn citation covers all sensitive references on its exact file:line. Otherwise one capabilityReferences citation covers each file:line:module:kind group; duplicate matches and unused entries fail. An unreachable-callsite substitutes only for the reference kind at its exact literal callsite.', manualClosureReviewRequired: true};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = realpathSync(process.cwd());
  const parser = resolve(root, 'node_modules/typescript/lib/typescript.js');
  if (realpathSync(parser) !== parser || createHash('sha256').update(readFileSync(parser)).digest('hex') !== '569177652966bd528c319171c7dd22860dbf72bde116cbc4f644f1d02bb12e39') throw new Error('TypeScript 6.0.3 parser pin mismatch');
  const ts = createRequire(import.meta.url)(parser);
  const audit = JSON.parse(readFileSync(resolve(root, 'scripts/gates/darwin/focused-sibling-audit.json'), 'utf8'));
  const result = validate(ts, root, audit);
  process.stdout.write(JSON.stringify(result) + '\n');
  if (!result.ok) process.exitCode = 95;
}
