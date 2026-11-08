import {test} from "node:test";
import assert from "node:assert/strict";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {assertQuestionEgress, questionEgressCensus} from "./questionEgressCensus.ts";
const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const rpc = resolve(root, "v2/daemon/src/rpc.ts");

test("question egress census classifies all typed consumers and RPC serialization boundaries", () => {
  console.log(JSON.stringify({questionEgressCensus: assertQuestionEgress(questionEgressCensus())}));
});
test("question egress root reuse preserves cyclic reachability and negative cycles", () => {
  const source = `
interface CensusCycleA { b: CensusCycleB; question: import("../../core/src/types.ts").QuestionRow }
interface CensusCycleB { a: CensusCycleA }
interface CensusEmptyCycle { next: CensusEmptyCycle }
function censusCycleAProbe(value: CensusCycleA) { JSON.stringify(value); }
function censusCycleBProbe(value: CensusCycleB) { JSON.stringify(value); JSON.stringify(value); }
function censusEmptyCycleProbe(value: CensusEmptyCycle) { JSON.stringify(value); JSON.stringify(value); }
`;
  const result = questionEgressCensus(new Map([[rpc, text => text + source]]));
  assert.deepEqual(result.consumers.filter(row => /^census(?:Cycle|EmptyCycle)/.test(row.scope)).map(row => ({scope: row.scope, call: row.call, typedArguments: row.typedArguments})), [
    {scope: "censusCycleAProbe", call: "JSON.stringify", typedArguments: [0]},
    {scope: "censusCycleBProbe", call: "JSON.stringify", typedArguments: [0]},
    {scope: "censusCycleBProbe", call: "JSON.stringify", typedArguments: [0]},
  ]);
});
test("question egress census rejects raw mirror row/snapshot serializers and unprojected RPC replies", () => {
  for (const source of [
    '\nfunction uncoveredMirror(value: import("../../core/src/mirror.ts").MirrorSnapshot) {return JSON.stringify(value);}\n',
    '\nfunction uncoveredRows(value: import("../../core/src/mirror.ts").MirrorQuestionRow[]) {return JSON.stringify(value);}\n',
    '\nfunction uncoveredCopy(value: import("../../core/src/mirror.ts").MirrorQuestionRow) {return JSON.stringify({...value});}\n',
    '\nfunction uncoveredIndex(value: Record<string, import("../../core/src/mirror.ts").MirrorQuestionRow>) {return JSON.stringify(value);}\n',
  ]) assert.throws(() => assertQuestionEgress(questionEgressCensus(new Map([[rpc, text => text + source]]))), /Uncovered typed question consumer/);
  assert.throws(() => assertQuestionEgress(questionEgressCensus(new Map([[rpc, text => text.replace('projectQuestionDismissalResult(verb, projectAnswerTriggerResult(verb, projectMailDeliveryResult(verb, value, conn.clientCapabilities), conn.clientCapabilities), conn.clientCapabilities)', 'value')]]))));
  assert.throws(() => assertQuestionEgress(questionEgressCensus(new Map([[rpc, text => text.replace('projectQuestionDismissalError(toRpcError(err), conn.clientCapabilities)', 'toRpcError(err)')]]))));
  assert.throws(() => assertQuestionEgress(questionEgressCensus(new Map([[rpc, text => text + '\nfunction uncoveredError(conn: RpcConn) { conn.send({id: 1, ok: false, error: {code: "question_dismissed", message: "dismissed"}}); }\n']]))));
});
