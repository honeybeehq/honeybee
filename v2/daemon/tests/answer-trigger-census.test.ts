import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { ANSWER_TRIGGER_AUDITS, ANSWER_TRIGGER_RESULTS } from "../src/answerTriggerProjection.ts";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const protocolPath = resolve(root, "v2/daemon/src/protocol.ts");
const storePath = resolve(root, "v2/core/src/store.ts");
const daemonPath = resolve(root, "v2/daemon/src/daemon.ts");
type Paths = { triggers: string[]; audits: string[] };
const empty = (): Paths => ({ triggers: [], audits: [] });
const sorted = (paths: { triggers: readonly string[]; audits: readonly string[] }): Paths => ({ triggers: [...new Set(paths.triggers)].sort(), audits: [...new Set(paths.audits)].sort() });

function census(patches: ReadonlyMap<string, (source: string) => string> = new Map()) {
  const configPath = resolve(root, "v2/daemon/tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const options = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve(root, "v2/daemon"));
  const host = ts.createCompilerHost(options.options);
  const read = host.readFile.bind(host);
  host.readFile = (path) => {
    const source = read(path);
    return source === undefined ? undefined : (patches.get(resolve(path))?.(source) ?? source);
  };
  const program = ts.createProgram(options.fileNames, options.options, host);
  const checker = program.getTypeChecker();
  function paths(type: ts.Type, seen = new Set<ts.Type>(), prefix = ""): Paths {
    if (seen.has(type)) return empty();
    const names = [type.aliasSymbol?.name, type.symbol?.name];
    if (names.includes("TurnTrigger") || names.includes("TurnTriggerSource")) return { triggers: [prefix], audits: [] };
    if (names.includes("AuditRow")) return { triggers: [], audits: [prefix] };
    const next = new Set(seen); next.add(type);
    let children: Paths[];
    if (type.isUnionOrIntersection()) children = type.types.map((item) => paths(item, next, prefix));
    else if (checker.isArrayType(type) || checker.isTupleType(type)) {
      const element = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
      children = element ? [paths(element, next, `${prefix}[]`)] : [];
    }
    else if (type.flags & ts.TypeFlags.Object) children = checker.getPropertiesOfType(type).flatMap((property) => {
      const declaration = property.valueDeclaration ?? property.declarations?.[0];
      if (!declaration) return [];
      const child = checker.getTypeOfSymbolAtLocation(property, declaration);
      return child.getCallSignatures().length ? [] : [paths(child, next, prefix ? `${prefix}.${property.name}` : property.name)];
    }).concat((() => {
      const indexed = checker.getIndexTypeOfType(type, ts.IndexKind.String);
      return indexed ? [paths(indexed, next, prefix ? `${prefix}.*` : "*")] : [];
    })());
    else return empty();
    return sorted({ triggers: children.flatMap((child) => child.triggers), audits: children.flatMap((child) => child.audits) });
  }
  const protocol = program.getSourceFile(protocolPath)!;
  const results: Record<string, Paths> = {};
  for (const symbol of checker.getExportsOfModule(checker.getSymbolAtLocation(protocol)!)) {
    const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    const found = paths(checker.getDeclaredTypeOfSymbol(target));
    if (found.triggers.length || found.audits.length) results[symbol.name] = found;
  }
  const audits: Record<string, string[]> = {};
  function auditCalls(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "audit" && node.arguments.length >= 3) {
      const found = paths(checker.getTypeAtLocation(node.arguments[2]!));
      if (found.triggers.length || found.audits.length) {
        assert.ok(ts.isStringLiteral(node.arguments[0]!), "Trigger-bearing audit needs a statically known kind");
        assert.equal(found.audits.length, 0, "Nested opaque audit payload needs explicit projection");
        const kind = (node.arguments[0] as ts.StringLiteral).text;
        audits[kind] = [...new Set([...(audits[kind] ?? []), ...found.triggers])].sort();
      }
    }
    ts.forEachChild(node, auditCalls);
  }
  for (const file of program.getSourceFiles()) if (!file.isDeclarationFile && file.fileName.startsWith(resolve(root, "v2"))) auditCalls(file);
  const dispatch: Record<string, Paths> = {};
  function returns(node: ts.Node, found: Paths): void {
    if (ts.isReturnStatement(node) && node.expression) {
      const type = checker.getAwaitedType(checker.getTypeAtLocation(node.expression));
      const value = paths(type ?? checker.getTypeAtLocation(node.expression));
      found.triggers.push(...value.triggers); found.audits.push(...value.audits);
    } else if (!ts.isFunctionLike(node)) ts.forEachChild(node, (child) => returns(child, found));
  }
  function methods(node: ts.Node): void {
    if (ts.isMethodDeclaration(node) && node.name.getText() === "dispatch") {
      function cases(child: ts.Node): void {
        if (ts.isCaseClause(child) && ts.isStringLiteral(child.expression)) {
          const found = empty(); child.statements.forEach((statement) => returns(statement, found));
          if (found.triggers.length || found.audits.length) dispatch[child.expression.text] = sorted(found);
        } else ts.forEachChild(child, cases);
      }
      ts.forEachChild(node, cases);
    } else ts.forEachChild(node, methods);
  }
  methods(program.getSourceFile(daemonPath)!);
  return { results, audits, dispatch };
}

function assertCovered(actual: ReturnType<typeof census>): void {
  const expected = Object.fromEntries(Object.entries(ANSWER_TRIGGER_RESULTS).map(([name, value]) => [name, sorted(value)]));
  assert.deepEqual(actual.results, expected, "Protocol trigger type census differs from egress coverage");
  assert.deepEqual(actual.audits, ANSWER_TRIGGER_AUDITS, "Audit trigger type census differs from egress coverage");
  const dispatch = Object.fromEntries(Object.values(ANSWER_TRIGGER_RESULTS).flatMap((value) => value.verbs.map((verb) => [verb, sorted(value)])));
  assert.deepEqual(actual.dispatch, dispatch, "Dispatch trigger type census differs from egress coverage");
}

test("answer trigger egress coverage enumerates all protocol, dispatch and inferred audit payload types", () => {
  const actual = census(); assertCovered(actual);
  console.log(JSON.stringify({ answerTriggerTypeCensus: actual }));
});

test("answer trigger census fails for a new result, dispatch path or audit carrying a trigger", () => {
  for (const patches of [
    new Map([[protocolPath, (source: string) => `${source}\nexport interface UncoveredResult { bee: BeeRow }\n`]]),
    new Map([[daemonPath, (source: string) => source.replace('case "snapshot": {', 'case "uncovered": return { nested: this.mustStore().getBee("probe") };\n      case "snapshot": {')]]),
    new Map([[storePath, (source: string) => `${source}\nfunction censusProbe(store: { audit: (...args: unknown[]) => void }, trigger: import("./types.ts").TurnTrigger) { store.audit("uncovered", null, { turnTrigger: trigger }); }\n`]]),
  ]) assert.throws(() => assertCovered(census(patches)), /census differs from egress coverage/);
});
