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
        const boundary = config.consumers.find(c => c.method === method && new RegExp(c.receiver).test(receiver))
        if (boundary) {
          const segments = boundary.operationArgs.map(i => literalValues(node.arguments[i]))
          const dynamic = segments.some(s => s === null)
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
            request: request ? { expression: print(request), shape: shape(checker.getTypeAtLocation(request)) } : null,
            response: shape(checker.getTypeAtLocation(node)), handling: reference(context), call: print(node),
            coverage: dynamic ? 'unknown' : 'extracted' })
          if (dynamic) gap(path, 'dynamic operation name; caller coverage remains unverified', print(node))
        } else if (config.consumers.some(c => c.method === method)) {
          gap(path, 'unclassified boundary candidate; receiver is ' + receiver, print(node))
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
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
