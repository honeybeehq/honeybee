/** Build-time extraction. TypeScript is supplied by the target repository, never a runtime dependency. */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, relative, join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v)
const digest = value => `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`
const sorted = values => values.sort((a, b) => canonical(a).localeCompare(canonical(b), 'en'))

export function extractInventory({ root, config, typescript: ts }) {
  root = resolve(root)
  const paths = new Set()
  function scan(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (/^(node_modules|dist|out|build|tests?|fixtures|\.git|\.cache)$/.test(entry.name) || entry.name.startsWith('.')) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) scan(path)
      else if (/\.(ts|tsx|mts)$/.test(path) && !/(\.(test|spec|d)\.[cm]?tsx?$|\/test[^/]*\.[cm]?tsx?$)/i.test(path)) paths.add(path)
    }
  }
  for (const path of config.roots) scan(resolve(root, path))
  const files = [...paths].sort()
  let checker
  const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed })
  const print = node => printer.printNode(ts.EmitHint.Unspecified, node, node.getSourceFile())
  const rel = path => relative(root, path).split('\\').join('/')
  const gaps = [], providers = [], consumers = [], sources = [], declarations = [], capabilities = [], optionalFeatures = []
  const registrations = new Map()
  const evidence = new Map()
  const reference = text => { const id = digest(text); evidence.set(id, text); return id }
  const gap = (path, reason, evidence) => gaps.push({ path, reason, evidence })
  const compilerConfigurations = []
  const projects = (config.projects ?? []).map(path => {
    const fullPath = resolve(root, path)
    const loaded = ts.readConfigFile(fullPath, ts.sys.readFile)
    if (loaded.error) throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, '\n'))
    const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, dirname(fullPath))
    if (parsed.errors.length) throw new Error(parsed.errors.map(e => ts.flattenDiagnosticMessageText(e.messageText, '\n')).join('\n'))
    return { path, options: parsed.options, files: new Set(parsed.fileNames) }
  })
  const groups = new Map()
  for (const file of files) {
    const matches = projects.filter(p => p.files.has(file))
    const options = matches[0]?.options ?? { strict: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, skipLibCheck: true, jsx: ts.JsxEmit.ReactJSX }
    const normalized = JSON.parse(JSON.stringify(options).split(root).join('<root>'))
    const key = canonical(normalized)
    if (!matches.length) gap(rel(file), 'no configured compiler project; typed evidence remains unverified', '')
    if (matches.some(p => canonical(p.options) !== canonical(options))) gap(rel(file), 'multiple compiler contexts; first configured project used, other contexts remain unverified', matches.map(p => p.path).join(', '))
    compilerConfigurations.push({ path: rel(file), project: matches[0]?.path ?? null, options: normalized })
    if (!groups.has(key)) groups.set(key, { options, files: [] })
    groups.get(key).files.push(file)
  }
  function shape(type, depth = 0, seen = new Set()) {
    const name = checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation).split(root).join('<root>')
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return { type: name, coverage: 'unknown' }
    if (type.isUnion()) return { union: sorted(type.types.map(t => shape(t, depth, seen))) }
    if (!(type.flags & ts.TypeFlags.Object)) return { type: name }
    if (seen.has(type) || depth >= 5) return { type: name, coverage: 'unknown', reason: 'recursive or depth-limited shape' }
    const next = new Set(seen).add(type)
    if (checker.isArrayType(type)) return { array: shape(checker.getTypeArguments(type)[0], depth + 1, next) }
    const awaited = checker.getPromisedTypeOfPromise(type)
    if (awaited) return { promise: shape(awaited, depth + 1, next) }
    const properties = checker.getPropertiesOfType(type).map(p => {
      const declaration = p.valueDeclaration ?? p.declarations?.[0]
      return { name: p.name, optional: !!(p.flags & ts.SymbolFlags.Optional), shape: declaration ? shape(checker.getTypeOfSymbolAtLocation(p, declaration), depth + 1, next) : { coverage: 'unknown' } }
    })
    const indexes = checker.getIndexInfosOfType(type).map(i => ({ key: checker.typeToString(i.keyType), value: shape(i.type, depth + 1, next) }))
    return { type: name, properties: sorted(properties), ...(indexes.length ? { indexes, coverage: 'unknown' } : {}) }
  }
  function enclosing(node) {
    for (let n = node.parent; n; n = n.parent) if (ts.isFunctionLike(n) && n.body) return n
    return node
  }
  function literalValues(node) {
    if (!node) return null
    if (ts.isStringLiteralLike(node)) return [node.text]
    const type = checker.getTypeAtLocation(node)
    const types = type.isUnion() ? type.types : [type]
    return types.every(t => t.isStringLiteral()) ? [...new Set(types.map(t => t.value))].sort() : null
  }
  function responseEvidence(node) {
    const result = []
    function visit(n) {
      if (ts.isReturnStatement(n) && n.expression) {
        const expression = n.expression
        result.push({ expression: print(expression), shape: shape(checker.getTypeAtLocation(expression)) })
        if (ts.isCallExpression(expression)) {
          const declaration = checker.getResolvedSignature(expression)?.declaration
          if (declaration && paths.has(declaration.getSourceFile().fileName)) result.push({ implementation: reference(print(declaration)) })
        }
      }
      ts.forEachChild(n, visit)
    }
    visit(node)
    return result
  }
  // Declarations select a source boundary; the implementation proves the mapping.
  const provenance = node => ({ path: rel(node.getSourceFile().fileName), implementation: reference(print(node)) })
  function descendants(node, predicate) {
    const result = []
    const visit = n => { if (predicate(n)) result.push(n); ts.forEachChild(n, visit) }
    visit(node)
    return result
  }
  const receiverName = node => checker.typeToString(checker.getTypeAtLocation(node))
  function wrapperCall(node) {
    const method = node.expression.name.text
    const receiver = receiverName(node.expression.expression)
    const candidates = (config.wrappers ?? []).filter(w => w.method === method && w.receiver === receiver)
    if (!candidates.length) return null
    const declaration = checker.getResolvedSignature(node)?.declaration
    const wrapper = candidates[0]
    const targets = config.consumers.filter(c => c.method === wrapper.target.method && c.receiver === wrapper.target.receiver)
    const invalid = reason => ({ boundary: targets[0], reason, routing: { coverage: 'unknown', ...(declaration ? { wrapper: provenance(declaration) } : {}) } })
    if (candidates.length !== 1 || targets.length !== 1 || !declaration?.body || rel(declaration.getSourceFile().fileName) !== wrapper.path) return invalid('missing or ambiguous declared wrapper')
    const returns = descendants(declaration.body, ts.isReturnStatement)
    const calls = descendants(declaration.body, n => ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
      && n.expression.name.text === wrapper.target.method && new RegExp(wrapper.target.receiver).test(receiverName(n.expression.expression)))
    if (calls.length !== 1 || returns.length !== 1 || enclosing(calls[0]) !== declaration || enclosing(returns[0]) !== declaration) return invalid('unsupported or ambiguous wrapper forwarding')
    const call = calls[0]
    const returned = returns[0].expression
    if (returned !== call && !(returned && ts.isAwaitExpression(returned) && returned.expression === call)) return invalid('wrapper does not return the declared forwarding call')
    const parameters = declaration.parameters.map(p => checker.getSymbolAtLocation(p.name))
    const indexes = [...targets[0].operationArgs, targets[0].paramsArg]
    const argumentMap = indexes.map(i => {
      const arg = call.arguments[i]
      return arg && ts.isIdentifier(arg) ? parameters.indexOf(checker.getSymbolAtLocation(arg)) : -1
    })
    // No constant propagation through assignments, mutation, spreads or arbitrary expressions.
    const writes = descendants(declaration.body, n => (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment)
      || ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(n.operator)))
    const mappedSymbols = new Set(argumentMap.map(i => parameters[i]))
    const otherUses = descendants(declaration.body, n => ts.isIdentifier(n) && mappedSymbols.has(checker.getSymbolAtLocation(n)) && !indexes.some(i => call.arguments[i] === n))
    if (argumentMap.includes(-1) || writes.length || otherUses.length) return invalid('unsupported wrapper argument transformation')
    return { boundary: { ...targets[0], operationArgs: argumentMap.slice(0, -1), paramsArg: argumentMap.at(-1) },
      routing: { coverage: 'extracted', argumentMap, wrapper: provenance(declaration), forwarding: provenance(call) } }
  }
  const unwrap = node => {
    while (node && (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node))) node = node.expression
    return node
  }
  const propertyName = node => node && (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) ? node.text : null
  function objectProperties(node) {
    node = unwrap(node)
    if (!node || !ts.isObjectLiteralExpression(node) || node.properties.some(p => !p.name || propertyName(p.name) === null)) return null
    const names = node.properties.map(p => propertyName(p.name))
    return new Set(names).size === names.length ? new Map(node.properties.map(p => [propertyName(p.name), p])) : null
  }
  function declaredFunction(program, selector) {
    const source = program.getSourceFile(resolve(root, selector.path))
    if (!source) return null
    const matches = descendants(source, n => (ts.isFunctionLike(n) && n.body && n.name && propertyName(n.name) === selector.function
      && (!selector.receiver || (n.parent.name && propertyName(n.parent.name) === selector.receiver)))
      || (ts.isVariableDeclaration(n) && propertyName(n.name) === selector.function && n.initializer && ts.isFunctionLike(n.initializer)))
    return matches.length === 1 ? (ts.isVariableDeclaration(matches[0]) ? matches[0].initializer : matches[0]) : null
  }
  // All route segments use the same conservative binding and payload checks.
  function unchangedForwarding(owner, call, expected, protectedParameters = expected) {
    if (expected.length < 2 || expected.some(n => !n || !checker.getSymbolAtLocation(n))) return false
    const scope = ts.isFunctionLike(owner) ? owner : enclosing(owner)
    if (enclosing(call) !== scope) return false
    const symbols = new Set(protectedParameters.map(n => checker.getSymbolAtLocation(n)))
    const payload = checker.getSymbolAtLocation(expected.at(-1))
    function origin(node, seen = new Set()) {
      node = unwrap(node)
      if (!node) return null
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        && objectProperties(node.right)?.size === 0) return origin(node.left, seen)
      if (!ts.isIdentifier(node)) return null
      const symbol = checker.getSymbolAtLocation(node)
      if (symbols.has(symbol)) return symbol
      if (!symbol || seen.has(symbol)) return null
      const declaration = symbol.valueDeclaration
      return declaration && ts.isVariableDeclaration(declaration) && (declaration.parent.flags & ts.NodeFlags.Const)
        ? origin(declaration.initializer, new Set(seen).add(symbol)) : null
    }
    if (!expected.every((parameter, i) => origin(call.arguments[i]) === checker.getSymbolAtLocation(parameter))) return false
    const touches = node => descendants(node, n => ts.isIdentifier(n) && symbols.has(origin(n))).length > 0
    const mutations = descendants(owner, n => {
      if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return touches(n.left)
      if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(n.operator)) return touches(n.operand)
      if ((ts.isCallExpression(n) || ts.isNewExpression(n)) && n !== call && print(n.expression) !== 'Array.isArray') {
        return (n.arguments ?? []).some(arg => descendants(arg, a => ts.isIdentifier(a) && origin(a) === payload).length > 0)
          || descendants(n.expression, a => ts.isIdentifier(a) && origin(a) === payload).length > 0
      }
      return false
    })
    return !mutations.length
  }
  function namedBinding(owner, name) {
    const found = descendants(owner, n => (ts.isVariableDeclaration(n) || ts.isParameter(n)) && propertyName(n.name) === name)
    return found.length === 1 ? found[0].name : null
  }
  function transportEvidence(program, declaration, domain, verb) {
    const nodes = []
    let allowlisted = null
    const unknown = reason => ({ method: declaration.method, coverage: 'unknown', reason, allowlisted, evidence: nodes.map(provenance) })
    const source = program.getSourceFile(resolve(root, declaration.path))
    if (!source) return unknown('missing transport source')
    let handlers
    if (declaration.function) handlers = [declaredFunction(program, declaration)].filter(Boolean)
    else handlers = descendants(source, n => ts.isSwitchStatement(n) && print(n.expression) === declaration.switch)
      .flatMap(n => n.caseBlock.clauses.filter(c => ts.isCaseClause(c) && literalValues(c.expression)?.includes(declaration.operation)))
    if (handlers.length !== 1) return unknown('missing or ambiguous transport handler')
    const handler = handlers[0]
    nodes.push(handler, enclosing(handler))
    if (declaration.allowlist) {
      const allow = declaration.allowlist
      const allowSource = program.getSourceFile(resolve(root, allow.path))
      const registries = allowSource ? descendants(allowSource, n => ts.isVariableDeclaration(n) && propertyName(n.name) === allow.registry) : []
      if (registries.length !== 1) return unknown('missing or ambiguous transport allowlist')
      nodes.push(registries[0])
      if (allow.kind === 'verbs') {
        const domains = objectProperties(registries[0].initializer)
        const verbs = domains && domains.has(domain) ? objectProperties(domains.get(domain).initializer) : null
        allowlisted = domains && (!domains.has(domain) || verbs) ? !!verbs?.has(verb) : null
      } else if (allow.kind === 'domains') {
        const list = unwrap(registries[0].initializer)
        allowlisted = list && ts.isArrayLiteralExpression(list) && list.elements.every(ts.isStringLiteralLike) ? list.elements.some(e => e.text === domain) : null
      }
      if (allowlisted !== true) return { ...unknown(allowlisted === false ? 'route absent from transport allowlist' : 'dynamic or unsupported transport allowlist'), allowlisted }
    }
    const forwards = descendants(handler, n => ts.isCallExpression(n) && print(n.expression) === declaration.forward)
    const routeBindings = ['domain', 'verb', 'args'].map(name => namedBinding(handler, name) ?? namedBinding(enclosing(handler), name))
    if (forwards.length !== 1 || !unchangedForwarding(handler, forwards[0], routeBindings)) return unknown('missing or unsupported transport forwarding')
    const dispatch = declaredFunction(program, declaration.dispatch)
    if (!dispatch) return unknown('missing or ambiguous registration dispatcher')
    nodes.push(dispatch)
    for (const step of declaration.via ?? []) {
      const fn = declaredFunction(program, step)
      if (!fn) return unknown('missing or ambiguous intermediate route')
      nodes.push(fn)
      const forwarded = descendants(fn.body, n => ts.isCallExpression(n) && print(n.expression) === step.forward)
      if (forwarded.length !== 1 || !unchangedForwarding(fn, forwarded[0], fn.parameters.slice(0, 3).map(p => p.name))) return unknown('unsupported intermediate argument forwarding')
    }
    const lookup = descendants(dispatch.body, n => ts.isVariableDeclaration(n) && n.initializer && ts.isCallExpression(n.initializer)
      && ts.isPropertyAccessExpression(n.initializer.expression) && n.initializer.expression.name.text === 'find'
      && print(n.initializer.expression.expression) === declaration.dispatch.collection)
    if (lookup.length !== 1) return unknown('missing or ambiguous registration lookup')
    const predicate = lookup[0].initializer.arguments[0]
    const condition = predicate && ts.isArrowFunction(predicate) ? predicate.body : null
    const nameAccess = condition && ts.isBinaryExpression(condition) ? condition.left : null
    if (!condition || !ts.isBinaryExpression(condition) || condition.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken
      || !ts.isPropertyAccessExpression(nameAccess) || nameAccess.name.text !== 'name'
      || checker.getSymbolAtLocation(nameAccess.expression) !== checker.getSymbolAtLocation(predicate.parameters[0]?.name)
      || checker.getSymbolAtLocation(condition.right) !== checker.getSymbolAtLocation(dispatch.parameters[0]?.name)) return unknown('unsupported registration name selection')
    const calls = descendants(dispatch.body, n => ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
      && n.expression.name.text === declaration.method && checker.getSymbolAtLocation(n.expression.expression) === checker.getSymbolAtLocation(lookup[0].name))
    if (calls.length !== 1 || !unchangedForwarding(dispatch, calls[0], dispatch.parameters.slice(1, 3).map(p => p.name), dispatch.parameters.slice(0, 3).map(p => p.name))) return unknown('unsupported registration verb or args forwarding')
    // DI and alternative branches are retained for evaluation, never asserted as a proven call graph.
    const directlyBound = checker.getResolvedSignature(forwards[0])?.declaration === dispatch
    return { method: declaration.method, coverage: directlyBound ? 'extracted' : 'unknown', allowlisted,
      ...(!directlyBound ? { reason: 'transport-to-dispatch binding requires semantic evaluation' } : {}), evidence: nodes.map(provenance) }
  }
  function domainProviders(program, source, path) {
    for (const boundary of config.domainRoutes ?? []) {
      if (!new RegExp(boundary.pathPattern).test(path)) continue
      for (const registration of descendants(source, ts.isObjectLiteralExpression)) {
        const type = checker.getContextualType(registration) ?? checker.getTypeAtLocation(registration)
        if (type.aliasSymbol?.name !== boundary.registrationType && type.symbol?.name !== boundary.registrationType) continue
        const properties = objectProperties(registration)
        const names = properties?.get('name')?.initializer
        const domain = names && ts.isStringLiteralLike(unwrap(names)) ? unwrap(names).text : null
        if (!domain) { gap(path, 'dynamic or unsupported domain registration', print(registration)); continue }
        const registrationKey = `${boundary.protocol}:${domain}`
        if (!registrations.has(registrationKey)) registrations.set(registrationKey, new Set())
        // Source positions are internal identity only; they never enter fingerprints.
        registrations.get(registrationKey).add(`${path}:${registration.pos}`)
        for (const method of ['read', 'command']) {
          const property = properties.get(method)
          const handler = property && (ts.isMethodDeclaration(property) ? property : unwrap(property.initializer))
          if (!handler) continue
          if (!ts.isFunctionLike(handler) || !handler.body) { gap(path, 'unsupported domain handler', print(property)); continue }
          const switches = descendants(handler.body, n => ts.isSwitchStatement(n)
            && checker.getSymbolAtLocation(n.expression) === checker.getSymbolAtLocation(handler.parameters[0]?.name))
          const cases = switches.flatMap(dispatch => dispatch.caseBlock.clauses.flatMap((clause, i, clauses) => {
            if (!ts.isCaseClause(clause)) return []
            let body = clause
            for (let j = i + 1; !body.statements.length && j < clauses.length; j++) body = clauses[j]
            return [{ expression: clause.expression, body, guarded: false }]
          }))
          for (const branch of descendants(handler.body, ts.isIfStatement)) {
            const condition = branch.expression
            if (!ts.isBinaryExpression(condition) || ![ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(condition.operatorToken.kind)) continue
            if (checker.getSymbolAtLocation(condition.left) !== checker.getSymbolAtLocation(handler.parameters[0]?.name)) continue
            cases.push({ expression: condition.right, body: handler, guarded: true })
          }
          if (!cases.length) { gap(path, 'domain handler has no statically supported verb dispatch', print(handler)); continue }
          for (const {expression, body, guarded} of cases) {
            const verbs = literalValues(expression)
            if (!verbs || verbs.length !== 1) { gap(path, 'dynamic domain verb', print(expression)); continue }
            const verb = verbs[0]
            const transports = boundary.transports.filter(t => t.method === method).map(t => transportEvidence(program, t, domain, verb))
            const routing = { domain, verb, method, registration: provenance(registration), transports }
            const implementation = reference([print(registration), ...transports.flatMap(t => t.evidence.map(e => evidence.get(e.implementation)))].join('\n'))
            const incomplete = guarded || !transports.length || transports.every(t => t.coverage === 'unknown')
            providers.push({ protocol: boundary.protocol, operation: `${domain}.${verb}`, path, scope: method, routing,
              request: handler.parameters.map(p => ({ name: print(p.name), shape: shape(checker.getTypeAtLocation(p)) })),
              response: responseEvidence(body), implementation, coverage: incomplete ? 'unknown' : 'extracted' })
            gap(path, 'domain route validation, registration lifecycle and conditional dispatch require semantic evaluation', `${domain}.${verb} (${method})`)
            for (const transport of transports) if (transport.coverage === 'unknown') gap(path, transport.reason, `${domain}.${verb} (${method})`)
          }
        }
      }
    }
  }
  for (const group of groups.values()) {
  const program = ts.createProgram(group.files, group.options)
  checker = program.getTypeChecker()
  for (const file of group.files) {
    const source = program.getSourceFile(file), path = rel(file)
    sources.push({ path, fingerprint: digest(print(source)) })
    const boundaries = config.providers.filter(p => p.path === path || (p.pathPattern && new RegExp(p.pathPattern).test(path)))
    function visit(node) {
      // Include named wire types as readable evidence, not merely unresolved aliases.
      if ((ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && boundaries.length) declarations.push({ path, name: node.name.text, definition: print(node) })
      for (const boundary of boundaries) {
        if (ts.isSwitchStatement(node) && print(node.expression) === boundary.switch) {
          const fn = enclosing(node)
          const request = fn.parameters?.map(p => ({ name: print(p.name), shape: shape(checker.getTypeAtLocation(p)) })) ?? []
          for (let i = 0; i < node.caseBlock.clauses.length; i++) {
            const clause = node.caseBlock.clauses[i]
            if (!ts.isCaseClause(clause)) continue
            const operations = literalValues(clause.expression)
            if (!operations) { gap(path, 'dynamic provider case', print(clause)); continue }
            let body = clause
            for (let j = i + 1; body.statements.length === 0 && j < node.caseBlock.clauses.length; j++) body = node.caseBlock.clauses[j]
            for (const operation of operations) providers.push({ protocol: boundary.protocol, operation, path, scope: fn.name ? print(fn.name) : 'anonymous', request, response: responseEvidence(body), implementation: reference(print(body)) })
          }
          gap(path, 'runtime request validation and dynamic dispatch require semantic evaluation', print(node.expression))
        }
        if (boundary.registry && ts.isVariableDeclaration(node) && print(node.name) === boundary.registry) {
          const strings = []
          const collect = n => { if (ts.isStringLiteralLike(n)) strings.push(n.text); ts.forEachChild(n, collect) }
          if (node.initializer) collect(node.initializer)
          for (const operation of [...new Set(strings)].sort()) (boundary.capabilities ? capabilities : providers).push({ protocol: boundary.protocol, operation, path, registry: boundary.registry, declaration: reference(print(node)), coverage: 'unknown', reason: 'registry membership; see dispatch evidence for shapes' })
        }
      }
      for (const boundary of boundaries) {
        if (!boundary.switch || !ts.isIfStatement(node)) continue
        let dispatchCondition = false
        const comparisons = []
        function inspect(condition) {
          if (print(condition) === boundary.switch) dispatchCondition = true
          if (ts.isBinaryExpression(condition)) {
            const left = print(condition.left) === boundary.switch
            const right = print(condition.right) === boundary.switch
            const operator = condition.operatorToken.kind
            if ((left || right) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(operator)) {
              const operations = literalValues(left ? condition.right : condition.left)
              if (operations) comparisons.push({ operations, negated: operator === ts.SyntaxKind.ExclamationEqualsEqualsToken })
            }
          }
          ts.forEachChild(condition, inspect)
        }
        inspect(node.expression)
        if (!dispatchCondition) continue
        const fn = enclosing(node)
        for (const comparison of comparisons) for (const operation of comparison.operations) providers.push({ protocol: boundary.protocol, operation, path,
          scope: fn.name ? print(fn.name) : 'anonymous',
          request: { coverage: 'unknown', reason: 'runtime validation; inspect branch and enclosing handler' },
          response: responseEvidence(comparison.negated ? fn : node.thenStatement), implementation: reference(print(fn)) })
        gap(path, 'provider condition requires semantic evaluation, including guard fallthrough and compound dispatch', print(node.expression))
      }
      if (ts.isIfStatement(node)
        && (node.elseStatement || (ts.isBlock(node.thenStatement) && ts.isReturnStatement(node.thenStatement.statements.at(-1) ?? node)))
        && ts.isCallExpression(node.expression)
        && ts.isPropertyAccessExpression(node.expression.expression)
        && node.expression.expression.name.text === 'includes'
        && print(node.expression.expression.expression).includes('capabilities')) {
        const values = literalValues(node.expression.arguments[0])
        if (values) for (const capability of values) optionalFeatures.push({ path, capability, required: false,
          owner: print(node.expression.expression.expression), enabled: reference(print(node.thenStatement)), fallback: reference(print(node.elseStatement ?? enclosing(node))) })
        else gap(path, 'dynamic capability gate', print(node.expression))
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text
        const receiver = checker.typeToString(checker.getTypeAtLocation(node.expression.expression))
        const wrapper = wrapperCall(node)
        const boundary = wrapper?.boundary ?? config.consumers.find(c => c.method === method && new RegExp(c.receiver).test(receiver))
        if (boundary) {
          const segments = boundary.operationArgs.map(i => literalValues(node.arguments[i]))
          const dynamic = !!wrapper?.reason || segments.some(s => s === null) || (!!wrapper && segments.some(s => s.length !== 1))
          const operations = dynamic ? [null] : segments.reduce((a, b) => a.flatMap(x => b.map(y => x ? `${x}.${y}` : y)), [''])
          const fn = enclosing(node)
          const context = print(fn)
          // Explicit declarations supplement extraction when control-flow alone cannot
          // prove that a capability is optional. The call itself remains mechanical.
          const annotation = ts.getJSDocTags(fn).find(t => t.tagName.text === 'releaseOptional')
          const capability = typeof annotation?.comment === 'string' ? annotation.comment.trim() : null
          const request = node.arguments[boundary.paramsArg]
          for (const operation of operations) consumers.push({ protocol: boundary.protocol, operation, path, receiver, method,
            required: !capability, ...(capability ? { capability } : {}),
            ...(wrapper ? { routing: wrapper.routing } : {}),
            request: request ? { expression: print(request), shape: shape(checker.getTypeAtLocation(request)) } : null,
            response: shape(checker.getTypeAtLocation(node)), handling: reference(context), call: print(node),
            coverage: dynamic ? 'unknown' : 'extracted' })
          if (dynamic) gap(path, wrapper?.reason ?? 'dynamic operation name; caller coverage remains unverified', print(node))
        } else if (config.consumers.some(c => c.method === method)) {
          gap(path, 'unclassified boundary candidate; receiver is ' + receiver, print(node))
        }
      }
      ts.forEachChild(node, visit)
    }
    domainProviders(program, source, path)
    visit(source)
  }
  }
  for (const provider of providers.filter(p => p.routing)) {
    if (registrations.get(`${provider.protocol}:${provider.routing.domain}`).size > 1) {
      provider.coverage = 'unknown'
      provider.routing.reason = 'ambiguous domain registration'
      gap(provider.path, 'ambiguous domain registration', provider.routing.domain)
    }
  }
  for (const boundary of config.providers) if (boundary.path && !sources.some(s => s.path === boundary.path)) throw new Error(`Missing provider source: ${boundary.path}`)
  const coverage = { complete: gaps.length === 0, gaps: sorted(gaps), scope: config.roots, policy: 'Unknown coverage must remain unverified. Extracted types and source are evidence, never a compatibility verdict.' }
  const body = { schemaVersion: 1, extractorVersion: 1, typescriptVersion: ts.version, component: config.component, config, compilerConfigurations: sorted(compilerConfigurations), capabilities: sorted(capabilities), optionalFeatures: sorted(optionalFeatures), evidence: Object.fromEntries([...evidence].sort()), providers: sorted(providers), consumers: sorted(consumers), declarations: sorted(declarations), sources: sorted(sources), coverage }
  return { ...body, fingerprint: digest(body), providerFingerprint: digest({ operations: body.providers, declarations: body.declarations, sources: body.sources, capabilities: body.capabilities, config, coverage, compilerConfigurations, typescriptVersion: ts.version }), consumerFingerprint: digest({ operations: body.consumers, sources: body.sources, optionalFeatures: body.optionalFeatures, config, coverage, compilerConfigurations, typescriptVersion: ts.version }) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(process.argv[2] ?? '.')
  const config = JSON.parse(readFileSync(resolve(root, process.argv[3] ?? 'contracts/release/inventory.config.json'), 'utf8'))
  const ts = createRequire(resolve(root, 'package.json'))('typescript')
  process.stdout.write(`${JSON.stringify(extractInventory({ root, config, typescript: ts }), null, 2)}\n`)
}
