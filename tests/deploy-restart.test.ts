import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { restartDeployedDaemon } from "../src/commands/deploy.js";

test("fresh verified activation executes installed current v2 CLI with scoped data directory", { skip: process.platform !== "darwin" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "hon8-restart-"));
  try {
    const root = join(dir, "runtime"), calls = join(dir, "calls.jsonl");
    await mkdir(join(root, "current", "dist"), { recursive: true });
    await writeFile(join(root, "current", "dist", "cli.js"), `require('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2))+'\\n');`);
    await restartDeployedDaemon({ root, installedDir: join(root, "current"), sha: "a".repeat(40), runtime: "v2", log() {} });
    assert.deepEqual((await readFile(calls, "utf8")).trim().split("\n").map(line => JSON.parse(line)),
      ["install", "stop", "start"].map(verb => ["v2", "daemon", verb, "--data-dir", join(dir, "v2")]));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const absent of [false, true]) {
  test(`restart after stop failure ${absent ? "requires confirmed absence" : "refuses a still-loaded service"}`, { skip: process.platform !== "darwin" }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "hon8-stop-"));
    try {
      const root = join(dir, "runtime"), calls = join(dir, "calls.jsonl");
      await mkdir(join(root, "current", "dist"), { recursive: true });
      await writeFile(join(root, "current", "dist", "cli.js"), `
        require('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2))+'\\n');
        if (process.argv[4] === 'stop') process.exit(1);
        if (process.argv[4] === 'status') console.log(${JSON.stringify(JSON.stringify({ running: !absent, service: { installed: !absent, running: !absent } }))});
      `);
      const result = restartDeployedDaemon({ root, installedDir: join(root, "current"), sha: "a".repeat(40), runtime: "v2", log() {} });
      if (absent) await result;
      else await assert.rejects(result, /exited/);
      const verbs = (await readFile(calls, "utf8")).trim().split("\n").map(line => JSON.parse(line)[2]);
      assert.deepEqual(verbs, absent ? ["install", "stop", "status", "start"] : ["install", "stop", "status"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

import { RUNTIME_MODE_CONFIG } from "../src/cliRoute.js";

test("persisted v2 config selects the v2 service for an ordinary source restart", { skip: process.platform !== "darwin" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "hon8-config-restart-"));
  try {
    const root = join(dir, "runtime"), calls = join(dir, "calls.jsonl");
    await mkdir(join(root, "current", "dist"), { recursive: true });
    await writeFile(join(root, RUNTIME_MODE_CONFIG), JSON.stringify({ schemaVersion: 1, runtime: "v2" }));
    await writeFile(join(root, "current", "dist", "cli.js"), `require('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2))+'\\n');`);
    await restartDeployedDaemon({ root, installedDir: join(root, "current"), sha: "b".repeat(40), log() {} });
    assert.deepEqual((await readFile(calls, "utf8")).trim().split("\n").map(line => JSON.parse(line)),
      ["install", "stop", "start"].map(verb => ["v2", "daemon", verb, "--data-dir", join(dir, "v2")]));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
