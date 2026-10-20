import fs from "node:fs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
const root = ".proof/E";
const code = process.argv[2] ?? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const base = process.argv[3];
assert.ok(base);
const summary = JSON.parse(fs.readFileSync(`${root}/summary.json`, "utf8"));
assert.equal(summary.length, 28);
assert.ok(summary.every(row => row.passed));
assert.equal(fs.readFileSync(`${root}/gates.exit`, "utf8").trim(), "0");
const suites = fs.readFileSync(`${root}/suites.log`, "utf8");
assert.match(suites, /ℹ fail 0/);
const lines = [
  "Real-daemon proactive admission: 28/28 scenarios passed.",
  `Implementation ${code}`, `Base ${base}`, "Branch review/sar-E-proactive-switch",
  `Node ${process.version}`,
  "check, v2:check and build succeeded.",
  `Scoped existing suites: ${suites.match(/ℹ pass \d+/)?.[0]}, ${suites.match(/ℹ skipped \d+/)?.[0]}, 0 failed.`,
  "Weekly-ceiling boot-log assertion explicitly excluded after the same failure was reproduced on the unchanged base; original failed logs and passing narrow retry retained.",
  "Active owner routing belongs to C2/G. No deployment; DEPLOY HOLD remains.",
];
for (const row of summary) {
  const rpc = JSON.parse(fs.readFileSync(`${root}/${row.name}.rpc.json`, "utf8"));
  const audit = rpc.filter(item => item.method === "audit.tail").at(-1)?.result.rows ?? [];
  const view = rpc.filter(item => item.method === "view").at(-1)?.result;
  const snapshots = rpc.filter(item => item.method === "snapshot");
  const recoveries = snapshots.at(-1)?.result.quotaRecoveries ?? [];
  assert.equal(audit.filter(item => item.kind === "quota.observed").length, 0);
  if (row.name.endsWith("-both") || row.name.endsWith("-active")) {
    assert.equal(snapshots.at(-1).result.accountAdmissions.length, snapshots[0].result.accountAdmissions.length);
    assert.equal(recoveries.length, 1);
  }
  lines.push(JSON.stringify({ name: row.name, passed: true, account: view?.bee?.account, generation: view?.view?.generation, quotaObserved: 0,
    recoveries: recoveries.map(recovery => ({ id: recovery.id, trigger: recovery.trigger, state: recovery.state, reason: recovery.reason, interrupted: recovery.interrupted,
      continuationKind: recovery.continuationKind, continuationCount: recovery.continuationMessageIds.length, attempt: recovery.attempt,
      retryAt: recovery.retryAt, maxProjectedPercent: recovery.admission?.maxProjectedPercent })),
    reservations: snapshots.at(-1)?.result.accountAdmissions.length }));
}
fs.writeFileSync(`${root}/verification.log`, `${lines.join("\n")}\n`);
console.log(lines[0]);
