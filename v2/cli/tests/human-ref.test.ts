import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveBeeIn } from "../src/main.ts";
import type { ViewResult } from "../../daemon/src/protocol.ts";

const views = [
  { bee: { id: "a-uuid", name: "alpha", handle: "CO.9652", human_ref: "CO.9652.k7", issuing_namespace: "k7" } },
  { bee: { id: "b-uuid", name: "beta", handle: "CO.9652", human_ref: "CO.9652.k8", issuing_namespace: "k8" } },
] as ViewResult[];

test("human-ref resolution: UUID and qualified spelling win; ambiguous legacy handle refuses with both candidates", () => {
  assert.equal(resolveBeeIn(views, "a-uuid"), "a-uuid");
  assert.equal(resolveBeeIn(views, "co.9652.K8"), "b-uuid");
  assert.equal(resolveBeeIn(views, "beta"), "b-uuid");
  assert.throws(() => resolveBeeIn(views, "CO.9652"), /ambiguous.*CO\.9652\.k7.*CO\.9652\.k8/);
  assert.throws(() => resolveBeeIn(views, "CO.9652.k"), /ambiguous.*CO\.9652\.k7.*CO\.9652\.k8/);
  assert.equal(resolveBeeIn([views[0]!], "co.9652"), "a-uuid");
});

test("human-ref resolution: corrupt duplicate qualified refs refuse instead of picking the first", () => {
  const duplicate = { bee: { ...views[1]!.bee!, human_ref: views[0]!.bee!.human_ref } } as ViewResult;
  assert.throws(() => resolveBeeIn([views[0]!, duplicate], "CO.9652.k7"), /ambiguous.*a-uuid.*b-uuid/);
});

test("human-ref resolution: historical pretty IDs cannot bypass alias ambiguity", () => {
  const legacy = { bee: { ...views[0]!.bee!, id: "CO.9652" } } as ViewResult;
  assert.throws(() => resolveBeeIn([legacy, views[1]!], "CO.9652"), /ambiguous.*CO\.9652\.k7.*CO\.9652\.k8/);
});

test("human-ref resolution: pretty canonical ID with a different handle still participates in alias ambiguity", () => {
  const legacy = { bee: { id: "CO.9652", name: "legacy", handle: "CO.9653", human_ref: "CO.9653.k7" } } as ViewResult;
  assert.throws(() => resolveBeeIn([legacy, views[1]!], "CO.9652"), /ambiguous.*CO\.9653\.k7.*CO\.9652\.k8/);
  assert.throws(() => resolveBeeIn([legacy, views[1]!], "co.9652"), /ambiguous/);
});

test("resolution over the reference candidates equals resolution over the whole roster", async () => {
  const { beeRefCandidate } = await import("../../core/src/index.ts");
  const bee = (id: string, name: string, handle: string | null, human_ref: string | null) => ({ bee: { id, name, handle, human_ref, issuing_namespace: null } }) as unknown as ViewResult;
  const roster = [
    bee("0a11aaaa-0000-4000-8000-000000000001", "alpha", "CO.9652", "CO.9652.k7"),
    bee("0a11aaaa-0000-4000-8000-000000000002", "beta", "CO.9652", "CO.9652.k8"),
    bee("0a11bbbb-0000-4000-8000-000000000003", "alpha", "CL.1a2", null),
    bee("CL.1a2", "legacy-pretty", "CL.9zz", "CL.9zz.k7"),
    bee("cl.1a2b", "CL.1a2", null, null),
    bee("9c22cccc-0000-4000-8000-000000000004", "Ærlig", "ÆR.77", "ÆR.77.k7"),
    bee("9c22dddd-0000-4000-8000-000000000005", "alphabet", "GR.0f0", "GR.0f0.K9"),
    bee("9c22eeee-0000-4000-8000-000000000006", "0a11", "IN.abc", null),
    bee("worker", "9c22", "WO.123", "WO.123.k7"),
  ].sort((a, b) => (a.bee!.id < b.bee!.id ? -1 : 1));
  const outcome = (views: ViewResult[], ref: string): string => {
    try { return `id:${resolveBeeIn(views, ref)}`; } catch (error) { return `error:${(error as Error).message}`; }
  };
  const refs = new Set<string>(["", "x", "zz", "nobody", "0a11", "9c22", "CO", "co.", "al", "alp"]);
  for (const view of roster) {
    for (const value of [view.bee!.id, view.bee!.name, view.bee!.handle, view.bee!.human_ref]) {
      if (!value) continue;
      for (const spelling of [value, value.toLowerCase(), value.toUpperCase()]) {
        refs.add(spelling);
        for (let length = 1; length < spelling.length; length++) refs.add(spelling.slice(0, length));
      }
    }
  }
  let resolved = 0, ambiguous = 0;
  for (const ref of refs) {
    const whole = outcome(roster, ref);
    assert.equal(outcome(roster.filter(view => beeRefCandidate(view.bee!, ref)), ref), whole, JSON.stringify(ref));
    assert.equal(outcome(roster.filter(view => [ref, "alpha", "CL.1a2"].some(other => beeRefCandidate(view.bee!, other))), ref), whole, JSON.stringify(ref));
    if (whole.startsWith("id:")) resolved += 1;
    else if (whole.includes("ambiguous")) ambiguous += 1;
  }
  assert.ok(refs.size > 300);
  assert.ok(resolved > 50);
  assert.ok(ambiguous > 20);
});
