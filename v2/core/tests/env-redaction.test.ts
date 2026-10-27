import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { publicEnvRecords } from "../src/index.ts";

test("public env projection removes every value from nested bee, command, move and handoff metadata", () => {
  const canary = `harmless-${randomUUID()}`;
  const env = { SETTING: canary, CODEX_HOME: canary, CLAUDE_CONFIG_DIR: canary, GROK_HOME: canary, API_KEY: canary };
  const keys = Object.keys(env).sort();
  const input = {
    bee: { id: "b", env, args: ["--model", "fixture"] },
    rows: [
      { kind: "bee.env_set", payload: { env, previous: env } },
      { kind: "bee.move", payload: { move: { previousEnv: env } } },
      { kind: "bee.handoff", payload: { handoff: { targetEnv: env }, previous: "admitted" } },
      { kind: "command.put", payload: { command: { payload: { spec: { env } } } } },
    ],
  };
  const before = JSON.stringify(input);
  const output = publicEnvRecords(input);
  assert.equal(JSON.stringify(output).includes(canary), false);
  assert.deepEqual(output, {
    bee: { id: "b", envKeys: keys, args: ["--model", "fixture"] },
    rows: [
      { kind: "bee.env_set", payload: { envKeys: keys, previousEnvKeys: keys } },
      { kind: "bee.move", payload: { move: { previousEnvKeys: keys } } },
      { kind: "bee.handoff", payload: { handoff: { targetEnvKeys: keys }, previous: "admitted" } },
      { kind: "command.put", payload: { command: { payload: { spec: { envKeys: keys } } } } },
    ],
  });
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(publicEnvRecords(output), output);
});

test("public env projection preserves non-env state and handles empty env", () => {
  assert.deepEqual(publicEnvRecords({ env: {}, previous: {}, previousPhase: "running" }), { envKeys: [], previousEnvKeys: [], previousPhase: "running" });
  for (const value of [null, undefined, "plain", 42]) assert.equal(publicEnvRecords(value), value);
  assert.deepEqual(publicEnvRecords({ previous: "old", args: ["--resume", "fixture"] }), { previous: "old", args: ["--resume", "fixture"] });
});

test("operator-only paths are a closed validated shape and are absent from public output", async () => {
  const { operatorLocalHomesOf } = await import("../src/envRedaction.ts");
  assert.deepEqual(operatorLocalHomesOf({ CODEX_HOME: "harmless-nonpath", CLAUDE_CONFIG_DIR: "/tmp/fixture\ninvalid", GROK_HOME: "/tmp/grok", SETTING: "/tmp/never-exposed" }), { codexHome: null, claudeConfigDir: null, grokHome: "/tmp/grok" });
  const privateInput = { operatorLocalHomes: { codexHome: "/tmp/codex", claudeConfigDir: null, grokHome: null, unrelated: "harmless-value" } };
  assert.deepEqual(publicEnvRecords(privateInput), {});
  assert.deepEqual(publicEnvRecords(privateInput, true), { operatorLocalHomes: { codexHome: "/tmp/codex", claudeConfigDir: null, grokHome: null } });
});
