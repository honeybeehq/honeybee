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
