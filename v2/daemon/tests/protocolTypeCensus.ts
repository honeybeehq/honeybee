import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const protocolPath = resolve(root, "v2/daemon/src/protocol.ts");
const storePath = resolve(root, "v2/core/src/store.ts");
const daemonPath = resolve(root, "v2/daemon/src/daemon.ts");
export type CensusPaths = { values: string[]; audits: string[] };
const empty = (): CensusPaths => ({ values: [], audits: [] });
const sorted = (paths: { values: readonly string[]; audits: readonly string[] }): CensusPaths => ({ values: [...new Set(paths.values)].sort(), audits: [...new Set(paths.audits)].sort() });

export function protocolTypeCensus(valueTypes: readonly string[], patches: ReadonlyMap<string, (source: string) => string> = new Map()) {
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
  function paths(type: ts.Type, seen = new Set<ts.Type>(), prefix = ""): CensusPaths {
    if (seen.has(type)) return empty();
    const names = [type.aliasSymbol?.name, type.symbol?.name];
    if (names.some(name => name !== undefined && valueTypes.includes(name))) return { values: [prefix], audits: [] };
    if (names.includes("AuditRow")) return { values: [], audits: [prefix] };
    const next = new Set(seen); next.add(type);
    let children: CensusPaths[];
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
    return sorted({ values: children.flatMap((child) => child.values), audits: children.flatMap((child) => child.audits) });
  }
  const protocol = program.getSourceFile(protocolPath)!;
  const results: Record<string, CensusPaths> = {};
  for (const symbol of checker.getExportsOfModule(checker.getSymbolAtLocation(protocol)!)) {
    const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    const found = paths(checker.getDeclaredTypeOfSymbol(target));
    if (found.values.length || found.audits.length) results[symbol.name] = found;
  }
  const audits: Record<string, string[]> = {};
  function auditCalls(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "audit" && node.arguments.length >= 3) {
      const found = paths(checker.getTypeAtLocation(node.arguments[2]!));
      if (found.values.length || found.audits.length) {
        assert.ok(ts.isStringLiteral(node.arguments[0]!), "Trigger-bearing audit needs a statically known kind");
        assert.equal(found.audits.length, 0, "Nested opaque audit payload needs explicit projection");
        const kind = (node.arguments[0] as ts.StringLiteral).text;
        audits[kind] = [...new Set([...(audits[kind] ?? []), ...found.values])].sort();
      }
    }
    ts.forEachChild(node, auditCalls);
  }
  for (const file of program.getSourceFiles()) if (!file.isDeclarationFile && file.fileName.startsWith(resolve(root, "v2"))) auditCalls(file);
  const dispatch: Record<string, CensusPaths> = {};
  function returns(node: ts.Node, found: CensusPaths): void {
    if (ts.isReturnStatement(node) && node.expression) {
      const type = checker.getAwaitedType(checker.getTypeAtLocation(node.expression));
      const value = paths(type ?? checker.getTypeAtLocation(node.expression));
      found.values.push(...value.values); found.audits.push(...value.audits);
    } else if (!ts.isFunctionLike(node)) ts.forEachChild(node, (child) => returns(child, found));
  }
  function methods(node: ts.Node): void {
    if (ts.isMethodDeclaration(node) && node.name.getText() === "dispatch") {
      function cases(child: ts.Node): void {
        if (ts.isCaseClause(child) && ts.isStringLiteral(child.expression)) {
          const found = empty(); child.statements.forEach((statement) => returns(statement, found));
          if (found.values.length || found.audits.length) dispatch[child.expression.text] = sorted(found);
        } else ts.forEachChild(child, cases);
      }
      ts.forEachChild(node, cases);
    } else ts.forEachChild(node, methods);
  }
  methods(program.getSourceFile(daemonPath)!);
  return { results, audits, dispatch };
}

