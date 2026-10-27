import assert from "node:assert/strict";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
type Consumer = {file: string; line: number; scope: string; call: string; typedArguments: number[]};
type Send = {file: string; line: number; scope: string; argument: string; initializer: string | null};
export function questionEgressCensus(patches: ReadonlyMap<string, (source: string) => string> = new Map()) {
  const files = ts.sys.readDirectory(resolve(root, "v2"), [".ts"], ["**/tests/**"], ["**/src/**/*.ts"]);
  const options: ts.CompilerOptions = {target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, skipLibCheck: true, allowImportingTsExtensions: true};
  const host = ts.createCompilerHost(options), read = host.readFile.bind(host);
  host.readFile = path => {const source = read(path); return source === undefined ? source : patches.get(resolve(path))?.(source) ?? source;};
  const program = ts.createProgram(files, options, host), checker = program.getTypeChecker();
  const targets = new Set(["QuestionRow", "MirrorQuestionRow", "QuestionDismissedEvent", "AuditRow", "MirrorSnapshot"]);
  const types = program.getSourceFile(resolve(root, "v2/core/src/types.ts"))!;
  const questionSymbol = checker.getExportsOfModule(checker.getSymbolAtLocation(types)!).find(symbol => symbol.name === "QuestionRow")!;
  const questionType = checker.getDeclaredTypeOfSymbol(questionSymbol);
  function contains(type: ts.Type, seen = new Set<ts.Type>()): boolean {
    if (seen.has(type)) return false;
    if ([type.aliasSymbol?.name, type.symbol?.name].some(name => name !== undefined && targets.has(name))) return true;
    if (type.flags & ts.TypeFlags.Object && ["id", "beeId", "status", "askedAt"].every(name => checker.getPropertyOfType(type, name)) && checker.isTypeAssignableTo(type, questionType)) return true;
    const next = new Set(seen); next.add(type);
    if (type.isUnionOrIntersection()) return type.types.some(item => contains(item, next));
    if (checker.isArrayType(type) || checker.isTupleType(type)) {const item = checker.getIndexTypeOfType(type, ts.IndexKind.Number); return item ? contains(item, next) : false;}
    if (type.flags & ts.TypeFlags.Object) return checker.getPropertiesOfType(type).some(property => {
      const declaration = property.valueDeclaration ?? property.declarations?.[0];
      return declaration !== undefined && declaration.getSourceFile().fileName.startsWith(resolve(root, "v2")) && contains(checker.getTypeOfSymbolAtLocation(property, declaration), next);
    }) || [ts.IndexKind.String, ts.IndexKind.Number].some(kind => {const indexed = checker.getIndexTypeOfType(type, kind); return indexed ? contains(indexed, next) : false;});
    return false;
  }
  function scope(node: ts.Node): string {
    for (let parent = node.parent; parent; parent = parent.parent) if (ts.isFunctionLike(parent)) {
      if (parent.name) return parent.name.getText();
      if (ts.isVariableDeclaration(parent.parent)) return parent.parent.name.getText();
    }
    return "<module>";
  }
  const consumers: Consumer[] = [], sends: Send[] = [], mirrorReferences: {file: string; line: number; scope: string}[] = [];
  for (const file of program.getSourceFiles()) {
    if (!files.includes(file.fileName) || file.isDeclarationFile) continue;
    const path = relative(root, file.fileName);
    function visit(node: ts.Node): void {
      const location = {file: path, line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1, scope: scope(node)};
      if (ts.isTypeReferenceNode(node) && node.typeName.getText() === "MirrorSnapshot") mirrorReferences.push(location);
      if (ts.isCallExpression(node)) {
        const call = node.expression.getText(), typedArguments = node.arguments.flatMap((argument, index) => contains(checker.getTypeAtLocation(argument)) ? [index] : []);
        if (typedArguments.length) consumers.push({...location, call, typedArguments});
        if (path === "v2/daemon/src/rpc.ts" && call === "conn.send") {
          const argument = node.arguments[0], declaration = argument && ts.isIdentifier(argument) ? checker.getSymbolAtLocation(argument)?.valueDeclaration : undefined;
          const initializer = declaration && ts.isVariableDeclaration(declaration) ? declaration.initializer?.getText() ?? null : null;
          sends.push({...location, argument: argument?.getText() ?? "", initializer});
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
  }
  return {productionFiles: files.length, consumers, sends, mirrorReferences};
}
const policy: Readonly<Record<string, string>> = {
 'v2/core/src/audit.ts:replayAudit:questions.set':'canonical internal replay map, not external serialization',
 'v2/core/src/store.ts:askQuestion:this.audit':'canonical audit',
 'v2/core/src/store.ts:withdrawQuestionWithKey:JSON.stringify':'canonical private SQLite receipt',
 'v2/core/src/store.ts:dismissQuestionWithKey:this.audit':'canonical audit',
 'v2/core/src/store.ts:dismissQuestionWithKey:JSON.stringify':'canonical private SQLite receipt',
 'v2/core/src/store.ts:reportAction:finish':'canonical internal result; RPC dispatch census covers egress',
 'v2/daemon/src/loops.ts:buildHandoffContext:buildExtractiveHandoffContext':'text-only handoff; no question-row serialization',
 'v2/daemon/src/rpc.ts:writeWatchPass:JSON.stringify':'already projected watch row/header serialization',
 'v2/daemon/src/rpc.ts:writeWatchPass:conn.send':'already projected watch frame',
 'v2/daemon/src/rpc.ts:writeWatchPass:byCursor.set':'canonical private cursor batch',
 'v2/daemon/src/rpc.ts:writeWatchPass:projectAnswerTriggerDelta':'outer question projector before send',
 'v2/daemon/src/rpc.ts:writeWatchPass:projectMailDeliveryDelta':'delivery capability projection before outer question projector',
 'v2/daemon/src/daemon.ts:flushWatchers:this.mirrorAuditRows':'canonical audit batch; RPC delta projection next',
 'v2/daemon/src/daemon.ts:mirrorAuditRows:mirrorBeeAuditRow':'canonical audit redaction; RPC delta projection next',
 'v2/daemon/src/daemon.ts:mirrorAuditRows:this.publicConfirmationAudit':'delivery-confirmation redaction; RPC question delta projection next',
 'v2/daemon/src/daemon.ts:rpcAuditTail:this.publicConfirmationAudit':'delivery-confirmation redaction; RPC question result projection next',
 'v2/daemon/src/daemon.ts:dispatch:this.envRedacted':'canonical RPC dispatch; sync/async projection next',
 'v2/daemon/src/daemon.ts:rpcActionReportIdempotent:store.recordRpcResult':'canonical private SQLite receipt; result projection next',
 'v2/cli/src/client.ts:onFrame:this.onEvent':'already projected owner frame',
 'v2/cli/src/main.ts:cmdAction:emit':'current CLI advertises new reader capability; projected RPC result',
 'v2/cli/src/main.ts:cmdAsk:emit':'current CLI advertises new reader capability; projected RPC result',
 'v2/cli/src/main.ts:cmdQuestion:questionLine':'feature-aware CLI text',
 'v2/cli/src/main.ts:cmdQuestion:emit':'current CLI projected RPC or feature-aware stale local row',
 'v2/cli/src/main.ts:cmdAnswer:emit':'current CLI advertises new reader capability; projected RPC result',
 'v2/cli/src/main.ts:cmdWatch:printSnapshot':'view-only text; no question rows emitted',
 'v2/cli/src/main.ts:readRows:envOutput':'current CLI projected RPC or feature-aware stale local audit',
 'v2/cli/src/main.ts:cmdEvents:emit':'current CLI projected RPC or feature-aware stale local audit',
 'v2/cli/src/main.ts:cmdEvents:auditLine':'feature-aware CLI text',
 'v2/cli/src/main.ts:cmdEvents:withDaemonTarget':'feature-aware CLI JSON follow; projected RPC or stale local audit',
 'v2/harness/src/invariants.ts:checkStep:this.checkModel':'in-process harness invariant',
 'v2/harness/src/invariants.ts:checkStep:this.checkI1':'in-process harness invariant',
 'v2/harness/src/invariants.ts:checkStep:this.checkQueue':'in-process harness invariant',
 'v2/harness/src/invariants.ts:checkReplay:replayAudit':'in-process harness invariant',
 'v2/harness/src/invariants.ts:checkReplay:isDeepStrictEqual':'in-process harness invariant',
};
export function assertQuestionEgress(census: ReturnType<typeof questionEgressCensus>) {
  const consumers = census.consumers.map(row => {
    const key = `${row.file}:${row.scope}:${row.call}`;
    assert.ok(policy[key], `Uncovered typed question consumer ${key}`);
    return {...row, policy: policy[key]};
  });
  assert.equal(census.mirrorReferences.length, 0, "New direct MirrorSnapshot consumer needs egress coverage");
  const boundaries = census.sends.map(row => {
    const argument = row.argument.trim(); let coverage: string;
    if (argument.startsWith("projectQuestionDismissalDelta(") || row.initializer?.startsWith("projectQuestionDismissalDelta(")) coverage = "projected delta";
    else if (argument.startsWith("{") && /ok:\s*true/.test(argument)) {assert.match(argument, /result:\s*projectQuestionDismissalResult\(/); coverage = "projected RPC result";}
    else if (argument.startsWith("{") && /ok:\s*false/.test(argument)) {
      if (/error:\s*projectQuestionDismissalError\(/.test(argument)) coverage = "projected RPC error";
      else {assert.match(argument, /error:\s*\{\s*code:\s*"(?:invalid_request|protocol_mismatch)"/); coverage = "literal request validation error";}
    }
    else if (argument.includes("satisfies HelloFrame")) coverage = "hello, no question rows";
    else if (argument === "frame" && row.scope === "writeWatchPass") {assert.match(row.initializer ?? "", /type:\s*"gap"/); assert.doesNotMatch(row.initializer ?? "", /events|questions/); coverage = "gap, no question rows";}
    else assert.fail(`Uncovered RPC send boundary ${row.scope}`);
    return {file: row.file, line: row.line, scope: row.scope, coverage};
  });
  assert.equal(boundaries.filter(row => row.coverage === "projected RPC result").length, 2);
  assert.equal(boundaries.filter(row => row.coverage === "projected delta").length, 1);
  assert.equal(boundaries.filter(row => row.coverage === "projected RPC error").length, 2);
  return {productionFiles: census.productionFiles, consumers, boundaries};
}
