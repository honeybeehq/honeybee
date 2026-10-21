import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ANSWER_TRIGGER_AUDITS, ANSWER_TRIGGER_RESULTS } from "../src/answerTriggerProjection.ts";
import { protocolTypeCensus } from "./protocolTypeCensus.ts";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const protocolPath = resolve(root, "v2/daemon/src/protocol.ts");
const storePath = resolve(root, "v2/core/src/store.ts");
const daemonPath = resolve(root, "v2/daemon/src/daemon.ts");
const census = (patches: ReadonlyMap<string, (source: string) => string> = new Map()) => protocolTypeCensus(["TurnTrigger", "TurnTriggerSource", "UnansweredHumanMessage"], patches);
const sorted = (paths: { triggers: readonly string[]; audits: readonly string[] }) => ({ values: [...new Set(paths.triggers)].sort(), audits: [...new Set(paths.audits)].sort() });

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
    new Map([[protocolPath, (source: string) => `${source}\nexport interface UncoveredPending { pending: import("../../core/src/humanOutputTypes.ts").UnansweredHumanMessage }\n`]]),
    new Map([[daemonPath, (source: string) => source.replace('case "snapshot": {', 'case "uncovered": return { nested: this.mustStore().getBee("probe") };\n      case "snapshot": {')]]),
    new Map([[storePath, (source: string) => `${source}\nfunction censusProbe(store: { audit: (...args: unknown[]) => void }, trigger: import("./types.ts").TurnTrigger) { store.audit("uncovered", null, { turnTrigger: trigger }); }\n`]]),
  ]) assert.throws(() => assertCovered(census(patches)), /census differs from egress coverage/);
});
