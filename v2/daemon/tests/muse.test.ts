import { test } from "node:test";
import assert from "node:assert/strict";
import { composeSpawn } from "../src/daemon.ts";
import { BUILTIN_AGENTS } from "../src/config.ts";
import type { HarnessAdapter } from "../../adapters/src/index.ts";

const GATEWAY = { name: "apiary", command: "/usr/bin/node", args: ["shim.mjs"], env: [{ name: "HONEYBEE_GATEWAY", value: "apiary" }] };

function setupRequest(adapter: HarnessAdapter | null): { method: string; params: Record<string, unknown> } {
  assert.ok(adapter);
  const signals = adapter.parseLine(JSON.stringify({ id: JSON.parse(adapter.bootLines()[0]!).id, jsonrpc: "2.0", result: {} }));
  if (signals[0]?.kind !== "respond") assert.fail();
  return JSON.parse(signals[0].lines[1]!);
}

test("Muse serves MSP with yolo, model and effort lifted off argv and gateways in session/start", () => {
  const spec = BUILTIN_AGENTS.muse;
  assert.ok(spec, "Muse must be a built-in agent");
  const plan = composeSpawn(spec, "muse", {
    cwd: "/work",
    args: ["--yolo", "--model", "muse-spark-1.2", "--effort", "low", "--model", "muse-spark-1.3", "--provider", "echo"],
    providerSessionId: null,
  }, [GATEWAY]);
  assert.deepEqual(plan.args, [
    "serve", "-c", "context.foreign_personal_rules=false", "-c", "context.foreign_personal_skills=false",
    "--provider", "echo", "--disable-sandbox", "--trust-workspace",
  ]);
  assert.equal(plan.model, "muse-spark-1.3");
  const start = setupRequest(plan.adapter);
  assert.equal(start.method, "session/start");
  assert.equal(start.params.workspaceRoot, "/work");
  assert.equal(start.params.approvalMode, "allowAll");
  assert.equal(start.params.modelId, "muse-spark-1.3");
  assert.deepEqual(Object.keys((start.params.config as { mcpServers: object }).mcpServers), ["apiary"]);
  const turn = JSON.parse(plan.adapter!.encodeMessage("hi", { sessionId: "s", messageId: 1, turnActive: false, turnId: null })!);
  assert.equal(turn.params.reasoningEffort, "low");
});

test("Muse revives through session/resume on the recorded provider session", () => {
  const spec = BUILTIN_AGENTS.muse;
  assert.ok(spec);
  const plan = composeSpawn(spec, "muse", { cwd: "/work", args: null, providerSessionId: "01a133e2-6725-7481-a1f9-1b611f7748be" }, [GATEWAY]);
  assert.equal(plan.args.includes("--resume"), false);
  const resume = setupRequest(plan.adapter);
  assert.equal(resume.method, "session/resume");
  assert.equal(resume.params.sessionId, "01a133e2-6725-7481-a1f9-1b611f7748be");
  assert.deepEqual(Object.keys((resume.params.config as { mcpServers: object }).mcpServers), ["apiary"]);
});
