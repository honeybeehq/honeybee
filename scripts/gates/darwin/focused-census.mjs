import { readFileSync, realpathSync, statSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const sensitive = new Set(['child_process', 'worker_threads', 'cluster', 'module', 'net', 'http', 'https', 'tls', 'dgram', 'dns', 'http2']);
const sensitiveExports = {
  worker_threads: new Set(['Worker']),
  cluster: new Set(['fork', 'setupPrimary', 'setupMaster', 'Worker']),
  module: new Set(['createRequire', 'register', '_load', '_resolveFilename', 'syncBuiltinESMExports', '_extensions', 'require']),
};
const dataExports = {
  worker_threads: new Set(['workerData', 'parentPort', 'isMainThread', 'threadId', 'MessageChannel', 'MessagePort', 'BroadcastChannel', 'receiveMessageOnPort', 'markAsUntransferable', 'resourceLimits', 'SHARE_ENV', 'getEnvironmentData', 'setEnvironmentData']),
  cluster: new Set(['isPrimary', 'isWorker', 'worker']),
  module: new Set(),
};
const builtins = new Set(builtinModules.map(value => value.replace(/^node:/, '')));
const normalize = value => typeof value === 'string' ? value.replace(/^node:/, '') : value?.builtin ? normalize(value.builtin) : '';

export function analyze(ts, path, text, imported = {}, compilerOptions = {}) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  ts.bindSourceFile(source, {target: ts.ScriptTarget.Latest});
  const symbols = new Map();
  const lexicalSymbol = node => {
    if (!node || !ts.isIdentifier(node)) return null;
    const parent = node.parent;
    if (parent?.name === node && parent.symbol && !ts.isPropertyAccessExpression(parent) && !ts.isExportSpecifier(parent) && !ts.isShorthandPropertyAssignment(parent)) return parent.symbol;
    if (ts.isPropertyAccessExpression(parent) && parent.name === node || ts.isBindingElement(parent) && parent.propertyName === node || ts.isImportSpecifier(parent) && parent.propertyName === node || ts.isPropertyAssignment(parent) && parent.name === node) return null;
    const name = ts.escapeLeadingUnderscores(node.text);
    for (let scope = parent; scope; scope = scope.parent) {
      const symbol = scope.locals?.get(name);
      if (symbol) return symbol;
    }
    return null;
  };
  const key = node => {
    if (!node || !ts.isIdentifier(node)) return null;
    const symbol = lexicalSymbol(node);
    if (!symbol) return '$global:' + node.text;
    if (!symbols.has(symbol)) symbols.set(symbol, '$local:' + symbols.size);
    return symbols.get(symbol);
  };
  const edges = [], capabilities = [], calls = [], errors = [];
  const bindingNodes = new Set();
  const aliases = new Map(), factories = new Set(), requires = new Set(['require']), constants = new Map(), assignments = new Set(), processAliases = new Set(['process']), declarations = new Map();
  const line = node => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const literal = node => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
  const exportInfo = (specifier, name, node) => {
    const module = normalize(specifier);
    if (name === null) throw new CensusFailure(path, 'binding', 'unknown sensitive namespace access at ' + line(node));
    if (name === 'default' || module === 'module' && ['Module', 'prototype'].includes(name)) return {module: {builtin: specifier}};
    if (!sensitiveExports[module] || sensitiveExports[module].has(name)) return {module: specifier, factory: module === 'module' && name === 'createRequire', loader: module === 'module' && ['_load', 'require'].includes(name)};
    if (dataExports[module].has(name)) return {};
    throw new CensusFailure(path, 'binding', 'unknown ' + module + ' export ' + name + ' at ' + line(node));
  };
  const importedInfo = (available, name, node) => available?.[name] ?? (available?.['*']?.module?.builtin ? exportInfo(available['*'].module.builtin, name, node) : null);
  const walk = (node, action) => {
    if (ts.isTypeNode(node) || erased(node) || ts.isImportSpecifier(node) && node.isTypeOnly || ts.isExportSpecifier(node) && node.isTypeOnly) return;
    action(node); ts.forEachChild(node, child => walk(child, action));
  };
  const names = node => ts.isIdentifier(node) ? [key(node)] : node?.elements ? node.elements.flatMap(item => item.name ? names(item.name) : []) : [];
  const member = node => ts.isPropertyAccessExpression(node) ? node.name.text : ts.isElementAccessExpression(node) ? literal(node.argumentExpression) : null;
  const object = node => ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) ? node.expression : null;
  const unwrap = node => node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isAwaitExpression(node)) ? unwrap(node.expression) : node;
  requires.clear(); requires.add('$global:require');
  processAliases.clear(); processAliases.add('$global:process');
  const choice = (node, predicate) => ts.isConditionalExpression(node) ? predicate(node.whenTrue) || predicate(node.whenFalse) : ts.isBinaryExpression(node) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(node.operatorToken.kind) && (predicate(node.left) || predicate(node.right));
  const memberInfo = node => { const parent = object(node) && originOf(object(node)); return parent?.builtin ? exportInfo(parent.builtin, member(node), node) : importedInfo(parent?.namespace, member(node), node); };
  const factory = value => { const node = unwrap(value); return !!node && (ts.isIdentifier(node) && factories.has(key(node)) || object(node) && memberInfo(node)?.factory || choice(node, factory)); };
  const loader = value => { const node = unwrap(value); return !!node && (ts.isIdentifier(node) && requires.has(key(node)) || ts.isCallExpression(node) && factory(node.expression) || object(node) && (memberInfo(node)?.loader || member(node) === 'require' && key(object(node)) === '$global:module') || choice(node, loader)); };
  const keepsEmptyImports = compilerOptions.verbatimModuleSyntax || compilerOptions.preserveValueImports || compilerOptions.importsNotUsedAsValues === 1;
  const erased = node => node.isTypeOnly || ts.isImportDeclaration(node) && node.importClause && (node.importClause.isTypeOnly || !keepsEmptyImports && !node.importClause.name && ts.isNamedImports(node.importClause.namedBindings) && node.importClause.namedBindings.elements.length > 0 && node.importClause.namedBindings.elements.every(item => item.isTypeOnly)) || !keepsEmptyImports && ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length > 0 && node.exportClause.elements.every(item => item.isTypeOnly);
  const networkGlobal = node => ts.isIdentifier(node) && ['$global:fetch', '$global:WebSocket'].includes(key(node)) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) && !(ts.isPropertyAssignment(node.parent) && node.parent.name === node);
  const edge = (node, specifier, kind = 'import') => edges.push({line: line(node), kind, specifier: literal(specifier), expression: specifier?.getText(source) ?? ''});
  walk(source, node => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isImportSpecifier(node) || ts.isNamespaceImport(node) || ts.isFunctionDeclaration(node)) for (const name of node.name ? names(node.name) : []) declarations.set(name, (declarations.get(name) ?? 0) + 1);
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) && node.moduleSpecifier) {
      if (erased(node)) return;
      edge(node, node.moduleSpecifier);
      const specifier = literal(node.moduleSpecifier);
      if (ts.isImportDeclaration(node) && node.importClause && imported[specifier]) {
        const clause = node.importClause;
        if (clause.name) {
          const origin = importedInfo(imported[specifier], 'default', clause.name);
          if (origin?.module) aliases.set(key(clause.name), origin.module);
          if (origin?.factory) factories.add(key(clause.name));
          if (origin?.loader) requires.add(key(clause.name));
        }
        if (clause.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings) && Object.keys(imported[specifier]).length) aliases.set(key(clause.namedBindings.name), {namespace: imported[specifier]});
          else if (ts.isNamedImports(clause.namedBindings)) for (const item of clause.namedBindings.elements) {
            if (item.isTypeOnly) continue;
            const origin = importedInfo(imported[specifier], (item.propertyName ?? item.name).text, item);
            if (origin?.module) aliases.set(key(item.name), origin.module);
            if (origin?.factory) factories.add(key(item.name));
            if (origin?.loader) requires.add(key(item.name));
          }
        }
      }
      if (specifier && sensitive.has(normalize(specifier))) {
        capabilities.push({line: line(node), module: specifier, kind: 'import'});
        if (ts.isImportDeclaration(node) && node.importClause) {
          const clause = node.importClause;
          if (clause.name) aliases.set(key(clause.name), {builtin: specifier});
          if (clause.namedBindings) {
            if (ts.isNamespaceImport(clause.namedBindings)) aliases.set(key(clause.namedBindings.name), {builtin: specifier});
            else for (const item of clause.namedBindings.elements) {
              if (item.isTypeOnly) continue;
              const info = exportInfo(specifier, (item.propertyName ?? item.name).text, item);
              if (info.module) aliases.set(key(item.name), info.module);
              if (info.factory) factories.add(key(item.name));
              if (info.loader) requires.add(key(item.name));
            }
          }
        }
      }
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      if (node.isTypeOnly) return;
      edge(node, node.moduleReference.expression);
      const specifier = literal(node.moduleReference.expression);
      if (specifier && sensitive.has(normalize(specifier))) aliases.set(key(node.name), {builtin: specifier});
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isVariableDeclarationList(node.parent) && node.parent.flags & ts.NodeFlags.Const) {
      if (constants.has(key(node.name))) constants.set(key(node.name), null);
      else constants.set(key(node.name), node.initializer);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && ts.isIdentifier(node.left)) assignments.add(key(node.left));
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && ts.isIdentifier(node.operand)) assignments.add(key(node.operand));
  });
  for (const [name, count] of declarations) if (count > 1) constants.set(name, null);
  const originOf = value => {
    const node = unwrap(value);
    if (!node) return null;
    if (ts.isIdentifier(node)) return aliases.get(key(node)) ?? (networkGlobal(node) ? 'global:' + node.text : ['$global:globalThis', '$global:global'].includes(key(node)) ? {namespace: {fetch: {module: 'global:fetch'}, WebSocket: {module: 'global:WebSocket'}}} : null);
    if (object(node)) {
      if (key(object(node)) === '$global:globalThis' && ['fetch', 'WebSocket'].includes(member(node))) return 'global:' + member(node);
      if (processAliases.has(key(object(node))) && (['binding', 'dlopen'].includes(member(node)) || member(node) === null)) return 'node:process';
      const parent = originOf(object(node));
      if (parent?.builtin) return exportInfo(parent.builtin, member(node), node).module ?? null;
      if (parent?.namespace) {
        if (member(node) === null) throw new CensusFailure(path, 'binding', 'unknown sensitive namespace access at ' + line(node));
        return importedInfo(parent.namespace, member(node), node)?.module ?? null;
      }
      return parent;
    }
    if (ts.isCallExpression(node) && (loader(node.expression) || node.expression.kind === ts.SyntaxKind.ImportKeyword)) {
      const specifier = literal(node.arguments[0]);
      if (specifier && sensitive.has(normalize(specifier))) return {builtin: specifier};
    }
    if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)) {
      const namespace = {};
      const items = ts.isObjectLiteralExpression(node) ? node.properties : node.elements;
      for (const [index, item] of items.entries()) {
        if (ts.isOmittedExpression(item)) continue;
        if (ts.isSpreadAssignment(item) || ts.isSpreadElement(item)) {
          if (hasSensitive(descriptor(item.expression))) throw new CensusFailure(path, 'binding', 'unsupported sensitive container spread at ' + line(item));
          continue;
        }
        const name = ts.isObjectLiteralExpression(node) ? item.name && (ts.isIdentifier(item.name) ? item.name.text : literal(item.name)) : String(index);
        const value = ts.isPropertyAssignment(item) ? item.initializer : ts.isShorthandPropertyAssignment(item) ? item.name : ts.isArrayLiteralExpression(node) ? item : null;
        if (!value) continue;
        const info = descriptor(value);
        if (hasSensitive(info)) {
          if (name === null || name === undefined) throw new CensusFailure(path, 'binding', 'unsupported computed sensitive container at ' + line(item));
          namespace[name] = info;
        }
      }
      return Object.keys(namespace).length ? {namespace} : null;
    }
    if (ts.isConditionalExpression(node) || ts.isBinaryExpression(node)) {
      if (factory(node) || loader(node)) return 'node:module';
      const branches = ts.isConditionalExpression(node) ? [node.whenTrue, node.whenFalse] : [node.left, node.right];
      if (branches.some(branch => hasSensitive(descriptor(branch)))) throw new CensusFailure(path, 'binding', 'unsupported sensitive expression at ' + line(node));
    }
    return null;
  };
  const descriptor = value => ({module: originOf(value), factory: factory(value), loader: loader(value), process: processAliases.has(key(unwrap(value)))});
  const hasSensitive = info => !!(info.module || info.factory || info.loader || info.process);
  const propertyInfo = (info, property, node) => {
    if (info.module?.builtin) return exportInfo(info.module.builtin, property, node);
    if (info.module?.namespace) return importedInfo(info.module.namespace, property, node) ?? {};
    if (info.process) return ['binding', 'dlopen'].includes(property) ? {module: 'node:process'} : {};
    if (normalize(info.module) === 'module') return property === 'createRequire' ? {module: info.module, factory: true} : {};
    return info.module ? {module: info.module} : {};
  };
  for (let turn = 0; turn <= text.length; turn++) {
    let changed = false;
    walk(source, node => {
      if ((ts.isForOfStatement(node) || ts.isForInStatement(node)) && hasSensitive(descriptor(node.expression))) throw new CensusFailure(path, 'binding', 'unsupported sensitive iteration binding at ' + line(node));
      const declaration = (ts.isVariableDeclaration(node) || ts.isParameter(node)) && node.initializer;
      const assignment = ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
      if (!declaration && !assignment) return;
      const target = declaration ? node.name : node.left;
      const initializer = unwrap(declaration ? node.initializer : node.right);
      const info = descriptor(initializer);
      if (assignment && node.operatorToken.kind !== ts.SyntaxKind.EqualsToken && hasSensitive(info)) throw new CensusFailure(path, 'binding', 'unsupported sensitive assignment operator at ' + line(node));
      const bind = (value, selected) => {
        const targetNode = unwrap(value);
        if (ts.isBinaryExpression(targetNode) && targetNode.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          const fallback = descriptor(targetNode.right);
          bind(targetNode.left, hasSensitive(selected) ? selected : fallback);
          if (hasSensitive(selected) && hasSensitive(fallback) && JSON.stringify(selected) !== JSON.stringify(fallback)) bind(targetNode.left, fallback);
          return;
        }
        const objectPattern = ts.isObjectBindingPattern(targetNode) || ts.isObjectLiteralExpression(targetNode);
        const arrayPattern = ts.isArrayBindingPattern(targetNode) || ts.isArrayLiteralExpression(targetNode);
        if (objectPattern || arrayPattern) {
          const elements = objectPattern ? targetNode.elements ?? targetNode.properties : targetNode.elements;
          for (const [index, item] of elements.entries()) {
            if (ts.isOmittedExpression(item)) continue;
            const rest = item.dotDotDotToken || ts.isSpreadAssignment(item) || ts.isSpreadElement(item);
            let nested, name, fallback;
            if (ts.isBindingElement(item)) { nested = item.name; name = item.propertyName ?? item.name; fallback = item.initializer; }
            else if (ts.isPropertyAssignment(item)) { nested = item.initializer; name = item.name; }
            else if (ts.isShorthandPropertyAssignment(item)) { nested = item.name; name = item.name; fallback = item.objectAssignmentInitializer; }
            else if (rest) nested = item.expression;
            else if (arrayPattern) nested = item;
            else { if (hasSensitive(selected)) throw new CensusFailure(path, 'binding', 'unsupported sensitive object pattern at ' + line(item)); continue; }
            const property = rest ? null : objectPattern ? name && ts.isIdentifier(name) ? name.text : name && ts.isComputedPropertyName(name) ? literal(name.expression) : literal(name) : String(index);
            if (!rest && property === null && hasSensitive(selected)) throw new CensusFailure(path, 'binding', 'unsupported computed sensitive pattern at ' + line(item));
            let next = rest ? selected : propertyInfo(selected, property, item);
            if (rest && arrayPattern && selected.module?.namespace) {
              const namespace = Object.fromEntries(Object.entries(selected.module.namespace).filter(([key]) => /^\d+$/.test(key) && Number(key) >= index).map(([key, value]) => [String(Number(key) - index), value]));
              next = {module: {namespace}};
            }
            if (fallback && !hasSensitive(next)) next = descriptor(fallback);
            bind(nested, next);
          }
          return;
        }
        if (!hasSensitive(selected)) return;
        if (!ts.isIdentifier(targetNode)) throw new CensusFailure(path, 'binding', 'unsupported sensitive binding target at ' + line(targetNode));
        bindingNodes.add(targetNode);
        const name = key(targetNode);
        const origin = selected.module ?? (selected.factory || selected.loader ? 'node:module' : null);
        if (origin && aliases.has(name) && JSON.stringify(aliases.get(name)) !== JSON.stringify(origin)) throw new CensusFailure(path, 'binding', 'conflicting sensitive alias origins at ' + line(targetNode));
        if (origin && !aliases.has(name)) { aliases.set(name, origin); changed = true; }
        if (selected.loader && !requires.has(name)) { requires.add(name); changed = true; }
        if (selected.factory && !factories.has(name)) { factories.add(name); changed = true; }
        if (selected.process && !processAliases.has(name)) { processAliases.add(name); changed = true; }
      };
      bind(target, info);
    });
    if (!changed) break;
    if (turn === text.length) errors.push('alias closure did not converge');
  }
  const executable = (node, seen = new Set()) => {
    const value = literal(node);
    if (value !== null) return value;
    if (ts.isPropertyAccessExpression(node) && key(node.expression) === '$global:process' && node.name.text === 'execPath') return '$pinned-node';
    if (ts.isIdentifier(node) && constants.get(key(node)) && !assignments.has(key(node)) && !seen.has(key(node))) return executable(constants.get(key(node)), new Set([...seen, key(node)]));
    return null;
  };
  const origins = origin => typeof origin === 'string' ? [origin] : origin?.builtin ? [origin.builtin] : Object.values(origin?.namespace ?? {}).flatMap(value => origins(value.module));
  walk(source, node => {
    if (ts.isIdentifier(node) && ['$global:globalThis', '$global:global'].includes(key(node))) {
      const target = object(node.parent) === node ? originOf(node.parent) : originOf(node);
      for (const module of new Set(origins(target))) capabilities.push({line: line(node), module, kind: 'reference'});
    }
    if (networkGlobal(node)) capabilities.push({line: line(node), module: 'global:' + node.text, kind: 'reference'});
    if (object(node) && key(object(node)) === '$global:globalThis' && ['fetch', 'WebSocket'].includes(member(node))) capabilities.push({line: line(node), module: 'global:' + member(node), kind: 'reference'});
    if (ts.isIdentifier(node) && aliases.has(key(node))) {
      const parent = node.parent;
      if (object(parent) === node && originOf(parent) === null) return;
      const kind = ts.isImportSpecifier(parent) || ts.isNamespaceImport(parent) || ts.isImportClause(parent) || ts.isImportEqualsDeclaration(parent) ? 'import' : bindingNodes.has(node) ? 'binding' : 'reference';
      const origin = aliases.get(key(node));
      for (const module of new Set(origins(origin))) capabilities.push({line: line(node), module, kind});
    }
    if (object(node) && processAliases.has(key(object(node))) && (['binding', 'dlopen'].includes(member(node)) || ts.isElementAccessExpression(node) && member(node) === null)) capabilities.push({line: line(node), module: 'node:process', kind: 'reference'});
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const args = node.arguments ?? [];
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || loader(node.expression))) {
        edge(node, args[0], node.expression.kind === ts.SyntaxKind.ImportKeyword ? 'import' : 'require');
        const specifier = literal(args[0]);
        if (specifier && sensitive.has(normalize(specifier))) capabilities.push({line: line(node), module: specifier, kind: 'import'});
      }
      if (ts.isIdentifier(node.expression) && ['eval', 'Function'].includes(node.expression.text)) errors.push('dynamic code generation at ' + line(node));
      let origin = originOf(node.expression);
      if (origin || factory(node.expression)) {
        origin ??= factory(node.expression) ? 'node:module' : 'node:process';
        if (typeof origin !== 'string') { errors.push('unresolved sensitive namespace call at ' + line(node)); return; }
        const first = args[0];
        calls.push({line: line(node), module: origin, callee: node.expression.getText(source), expression: first?.getText(source) ?? '', executable: first ? executable(first) : null});
        capabilities.push({line: line(node), module: origin, kind: 'reference'});
      }
    }
  });
  const exports = {};
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (erased(statement)) continue;
      const specifier = statement.moduleSpecifier && literal(statement.moduleSpecifier);
      const builtin = specifier && sensitive.has(normalize(specifier));
      const available = specifier ? builtin ? {'*': {module: {builtin: specifier}}} : imported[specifier] ?? {} : null;
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const item of statement.exportClause.elements) {
          if (item.isTypeOnly) continue;
          const binding = item.propertyName ?? item.name;
          const symbol = lexicalSymbol(binding);
          const local = symbol && symbols.get(symbol);
          const origin = available ? importedInfo(available, binding.text, item) : aliases.has(local) ? {module: aliases.get(local), factory: factories.has(local), loader: requires.has(local)} : null;
          if (origin?.module) exports[item.name.text] = origin;
        }
      } else if (statement.exportClause && ts.isNamespaceExport(statement.exportClause)) {
        exports[statement.exportClause.name.text] = {module: builtin ? {builtin: specifier} : {namespace: available}};
      } else if (!statement.exportClause && specifier) Object.assign(exports, available);
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const origin = originOf(statement.expression);
      if (origin) exports.default = {module: origin, factory: factory(statement.expression), loader: loader(statement.expression)};
    }
    if (ts.isVariableStatement(statement) && statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) for (const declaration of statement.declarationList.declarations) {
      const visit = name => { if (ts.isIdentifier(name) && aliases.has(key(name))) exports[name.text] = {module: aliases.get(key(name)), factory: factories.has(key(name)), loader: requires.has(key(name))}; else if (name.elements) for (const item of name.elements) if (item.name) visit(item.name); };
      visit(declaration.name);
    }
  }
  for (const diagnostic of source.parseDiagnostics) errors.push('parse error ' + diagnostic.code);
  return {edges, capabilities: [...new Map(capabilities.map(row => [JSON.stringify(row), row])).values()], calls, exports, errors};
}

class CensusFailure extends Error {
  constructor(path, phase, cause) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'CensusFailure'; this.path = path; this.phase = phase;
  }
}
const inFile = (path, phase, run) => {
  try { return run(); } catch (error) { if (error instanceof CensusFailure) throw error; throw new CensusFailure(path, phase, error); }
};
const failure = error => ({ok: false, error: {type: 'CensusFailure', path: error.path ?? '<audit>', phase: error.phase ?? 'validation', message: error.message ?? String(error)}, errors: ['CensusFailure: ' + (error.path ?? '<audit>') + ': ' + (error.message ?? String(error))]});
export function validate(ts, root, audit) {
  try { return validateFiles(ts, root, audit); } catch (error) { return failure(error); }
}

function validateFiles(ts, root, audit) {
  const errors = [], files = new Map(audit.files.map(row => [row.path, row])), groups = [], edges = [];
  if (Object.hasOwn(audit, 'readerLifetimeBarrierRequired') && typeof audit.readerLifetimeBarrierRequired !== 'boolean') errors.push('reader lifetime barrier requirement must be boolean');
  const packageNames = new Set(audit.packages.map(row => row.specifier));
  const spawns = audit.spawns, references = audit.capabilityReferences, natives = audit.nativeEdges;
  const used = new Set();
  const configPins = new Map(), optionsByDirectory = new Map();
  const compilerOptionsFor = absolute => {
    const directory = dirname(absolute);
    if (optionsByDirectory.has(directory)) return optionsByDirectory.get(directory);
    let current = directory, config;
    while (current === root || current.startsWith(root + sep)) {
      const candidate = resolve(current, 'tsconfig.json');
      try { if (statSync(candidate).isFile()) { config = candidate; break; } } catch {}
      if (current === root) break;
      current = dirname(current);
    }
    let options = {};
    if (config) {
      const readConfig = path => {
        const full = resolve(path);
        if (!full.startsWith(root + sep) || realpathSync(full) !== full) throw new Error('tsconfig outside candidate root or redirected');
        const bytes = readFileSync(full);
        configPins.set(relative(root, full), createHash('sha256').update(bytes).digest('hex'));
        return bytes.toString('utf8');
      };
      const host = {useCaseSensitiveFileNames: true, getCurrentDirectory: () => root, readDirectory: () => [], readFile: readConfig, fileExists: path => { const full = resolve(path); if (!full.startsWith(root + sep)) return false; try { return statSync(full).isFile(); } catch { return false; } }, onUnRecoverableConfigFileDiagnostic: diagnostic => { throw new Error('tsconfig error ' + diagnostic.code); }};
      const parsed = ts.getParsedCommandLineOfConfigFile(config, {}, host);
      if (!parsed || parsed.errors.some(error => ![18002, 18003].includes(error.code))) throw new Error('unresolved candidate tsconfig');
      options = parsed.options;
    }
    optionsByDirectory.set(directory, options);
    return options;
  };
  const entryRoles = new Set();
  if (audit.nodeEntries) {
    const roles = new Set();
    if (!Array.isArray(audit.nodeEntries) || audit.nodeEntries.length !== 3) errors.push('exactly three Node entries required');
    for (const row of audit.nodeEntries) {
      if (!['reader', 'test-runner', 'runner-host-main'].includes(row.role) || roles.has(row.role) || !files.get(row.path)?.siblingClosure || files.get(row.path)?.sha256 !== row.sha256) errors.push('invalid Node entry pin');
      roles.add(row.role);
    }
    const pin = audit.entryPins?.find(row => row.role === 'reader-entry');
    const reader = audit.nodeEntries.find(row => row.role === 'reader');
    if (pin && reader) {
      const parsed = ts.createSourceFile(pin.path, pin.context, ts.ScriptTarget.Latest, true);
      const targets = [];
      const visit = node => {
        if (ts.isNewExpression(node) && node.expression.getText(parsed) === 'URL' && node.arguments?.length === 2 && ts.isStringLiteral(node.arguments[0]) && node.arguments[1].getText(parsed) === 'import.meta.url') targets.push(relative(root, resolve(root, dirname(pin.path), node.arguments[0].text)).split(sep).join('/'));
        ts.forEachChild(node, visit);
      };
      visit(parsed);
      if (targets.length !== 1 || targets[0] !== reader.path) errors.push('reader entry does not match reviewed literal URL');
    } else errors.push('reader entry declaration missing');
  }
  for (const pin of audit.entryPins ?? []) {
    const file = files.get(pin.path);
    const validPath = file?.siblingClosure && resolve(root, pin.path).startsWith(root + sep) && inFile(pin.path, 'entry-pin', () => realpathSync(resolve(root, pin.path))) === resolve(root, pin.path);
    if (Object.keys(pin).sort().join(',') !== 'context,line,path,role' || !['production-sandbox-exec', 'reader-entry'].includes(pin.role) || entryRoles.has(pin.role) || !validPath || !Number.isInteger(pin.line) || pin.line < 1 || inFile(pin.path, 'entry-pin', () => readFileSync(resolve(root, pin.path), 'utf8')).split(/\r?\n/)[pin.line - 1] !== pin.context) errors.push('entry pin missing, duplicate, or context drift: ' + pin.role);
    entryRoles.add(pin.role);
  }
  for (const role of ['production-sandbox-exec', 'reader-entry']) if (!entryRoles.has(role)) errors.push('missing entry pin ' + role);
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
      const absolute = resolve(root, pin.path), text = inFile(pin.path, 'read', () => readFileSync(absolute, 'utf8'));
      const source = inFile(pin.path, 'parse', () => ts.createSourceFile(pin.path, text, ts.ScriptTarget.Latest, true)), imported = {};
      for (const statement of source.statements) if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text.startsWith('.')) {
        const target = resolveRelative(statement.moduleSpecifier.text, absolute);
        if (target && results.has(target)) imported[statement.moduleSpecifier.text] = results.get(target).exports;
      }
      const result = inFile(pin.path, 'syntax-binding', () => analyze(ts, pin.path, text, imported, compilerOptionsFor(absolute)));
      if (JSON.stringify(result.exports) !== JSON.stringify(results.get(pin.path)?.exports)) changed = true;
      results.set(pin.path, result);
    }
    if (!changed) break;
    if (pass === audit.files.length) errors.push('export capability closure did not converge');
  }
  for (const pin of audit.files.filter(row => row.siblingClosure)) {
    const absolute = resolve(root, pin.path);
    if (inFile(pin.path, 'canonical-path', () => realpathSync(absolute)) !== absolute || !absolute.startsWith(root + sep)) { errors.push('redirected source ' + pin.path); continue; }
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
  const counts = {byKind: {}, byDirectory: {}, byModule: {}, topFiles: []}, byFile = {};
  for (const group of groups) {
    const directory = group.path.startsWith('v2/') ? 'v2/' : group.path.startsWith('tests/') ? 'tests/' : group.path.startsWith('node_modules/') ? 'node_modules/' : 'other';
    for (const [table, value] of [[counts.byKind, group.kind], [counts.byDirectory, directory], [counts.byModule, group.module], [byFile, group.path]]) table[value] = (table[value] ?? 0) + 1;
  }
  counts.topFiles = Object.entries(byFile).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10).map(([path, count]) => ({path, count}));
  return {ok: errors.length === 0, errors, edges, capabilityGroups: groups, capabilityCounts: counts, entryPins: audit.entryPins, compilerConfigPins: [...configPins].map(([path, sha256]) => ({path, sha256})), convention: 'One spawn citation covers all sensitive references on its exact file:line. Otherwise one capabilityReferences citation covers each file:line:module:kind group, preserving the sensitive builtin origin across re-exports; duplicate matches and unused entries fail. An unreachable-callsite substitutes only for the reference kind at its exact literal callsite. entryPins are checked separately and never count as capability groups.', manualClosureReviewRequired: true};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let result;
  try {
    const root = realpathSync(process.cwd());
    const parser = resolve(root, 'node_modules/typescript/lib/typescript.js');
    if (realpathSync(parser) !== parser || createHash('sha256').update(readFileSync(parser)).digest('hex') !== '569177652966bd528c319171c7dd22860dbf72bde116cbc4f644f1d02bb12e39') throw new CensusFailure('node_modules/typescript/lib/typescript.js', 'parser-pin', 'TypeScript 6.0.3 parser pin mismatch');
    const ts = createRequire(import.meta.url)(parser);
    const auditPath = 'scripts/gates/darwin/focused-sibling-audit.json';
    const audit = inFile(auditPath, 'audit-read', () => JSON.parse(readFileSync(resolve(root, auditPath), 'utf8')));
    result = validate(ts, root, audit);
  } catch (error) { result = failure(error); }
  process.stdout.write(JSON.stringify(result) + '\n');
  if (!result.ok) process.exitCode = 95;
}
