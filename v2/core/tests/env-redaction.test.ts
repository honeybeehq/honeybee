import { test } from "node:test";
import assert from "node:assert/strict";
import { isSecretEnvKey, redactEnv, redactEnvRecords, REDACTED_ENV_VALUE } from "../src/index.ts";

test("isSecretEnvKey matches token/secret/key/password/credential names case-insensitively", () => {
  for (const key of ["APIARY_AGENT_TOKEN", "github_token", "AWS_SECRET_ACCESS_KEY", "OPENAI_API_KEY", "apikey", "DB_PASSWORD", "Password", "GOOGLE_APPLICATION_CREDENTIALS", "credential"]) {
    assert.equal(isSecretEnvKey(key), true, key);
  }
  for (const key of ["HOME", "PATH", "HIVE_BEE_ID", "CLAUDE_CONFIG_DIR", "APIARY_SESSION_ID", "LANG"]) {
    assert.equal(isSecretEnvKey(key), false, key);
  }
});

test("redactEnv keeps every key name and replaces only secret values", () => {
  assert.equal(REDACTED_ENV_VALUE, "<redacted>");
  assert.deepEqual(redactEnv({ APIARY_AGENT_TOKEN: "tok-123", HOME: "/home/bee", Db_Password: "pw" }), {
    APIARY_AGENT_TOKEN: "<redacted>",
    HOME: "/home/bee",
    Db_Password: "<redacted>",
  });
});

test("redactEnvRecords redacts env, previousEnv, targetEnv and env_set previous without mutating the input", () => {
  const view = { view: { beeId: "b" }, bee: { id: "b", name: "n", env: { APIARY_AGENT_TOKEN: "tok-1", HOME: "/h" }, args: ["--key", "k"] } };
  const audit = {
    rows: [
      { seq: 1, kind: "bee.env_set", payload: { beeId: "b", env: { MY_SECRET: "s2" }, previous: { MY_SECRET: "s1", HOME: "/h" } } },
      { seq: 2, kind: "bee.handoff_switched", payload: { env: { X_TOKEN: "t2" }, previousEnv: { X_TOKEN: "t1" }, previous: "agent" } },
      { seq: 3, kind: "bee.handoff_admitted", payload: { handoff: { targetEnv: { API_KEY: "k" }, previous: { API_KEY: "kept" } } } },
    ],
  };
  const original = JSON.stringify({ view, audit });
  const redactedView = redactEnvRecords(view);
  assert.deepEqual(redactedView.bee.env, { APIARY_AGENT_TOKEN: "<redacted>", HOME: "/h" });
  assert.deepEqual(redactedView.bee.args, ["--key", "k"]);
  const rows = redactEnvRecords(audit).rows;
  assert.deepEqual(rows[0]?.payload, { beeId: "b", env: { MY_SECRET: "<redacted>" }, previous: { MY_SECRET: "<redacted>", HOME: "/h" } });
  assert.deepEqual(rows[1]?.payload, { env: { X_TOKEN: "<redacted>" }, previousEnv: { X_TOKEN: "<redacted>" }, previous: "agent" });
  assert.deepEqual(rows[2]?.payload, { handoff: { targetEnv: { API_KEY: "<redacted>" }, previous: { API_KEY: "kept" } } });
  assert.equal(JSON.stringify({ view, audit }), original);
  assert.equal(redactEnvRecords(null), null);
  assert.equal(redactEnvRecords("APIARY_AGENT_TOKEN"), "APIARY_AGENT_TOKEN");
});
