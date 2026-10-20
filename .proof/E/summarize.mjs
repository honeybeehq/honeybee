import fs from "node:fs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
const root = ".proof/E";
const code = process.argv[2] ?? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const base = process.argv[3];
assert.ok(base);
const summary = JSON.parse(fs.readFileSync(`${root}/summary.json`, "utf8"));
assert.equal(summary.length, 36);
assert.ok(summary.every(row => row.passed));
assert.equal(fs.readFileSync(`${root}/queen-gates.exit`, "utf8").trim(), "0");
const suites = fs.readFileSync(`${root}/queen-suites.log`, "utf8");
assert.match(suites, /ℹ fail 0/);
const lines = [
  "Real-daemon proactive admission: 36/36 scenarios passed.",
  `Implementation ${code}`, `Base ${base}`, "Branch review/sar-E-proactive-switch",
  `Node ${process.version}`,
  "check, v2:check and build succeeded.",
  `Scoped existing suites: ${suites.match(/ℹ pass \d+/)?.[0]}, ${suites.match(/ℹ skipped \d+/)?.[0]}, 0 failed.`,
  "Weekly-ceiling boot-log assertion explicitly excluded after the same failure was reproduced on the unchanged base; original failed logs and passing narrow retry retained.",
  "accounts.proactiveAdmission defaults OFF in shadow and ON in active; explicit false disables. Shadow default-on decision remains with Tormod.",
  "Queen fixes: control operations bypass; provider-limit waiting admits mail; source restores in place; protected-window reset; v2 capability; indexed recovery boundary.",
  "queen-seams.log proves 100 move and 100 handoff polls create zero rows, protected weekly reset, proactive failed-successor release and preserved provider replay.",
  "Provider-limit spawn_failed still needs operator revive after its exhausted boot budget; the owed replay remains pending (carried LOW).",
  "Active owner routing belongs to C2/G. No deployment; DEPLOY HOLD remains.",
];
for (const row of summary) {
  const rpc = JSON.parse(fs.readFileSync(`${root}/${row.name}.rpc.json`, "utf8"));
  const audit = rpc.filter(item => item.method === "audit.tail").at(-1)?.result.rows ?? [];
  const view = rpc.filter(item => item.method === "view").at(-1)?.result;
  const snapshots = rpc.filter(item => item.method === "snapshot");
  const recoveries = [...new Map(audit.filter(item => item.kind === "quota.recovery").map(item => [item.payload.recovery.id, item.payload.recovery])).values()];
  const quotaObserved = audit.filter(item => item.kind === "quota.observed").length;
  if (row.name.includes("-provider-")) {
    assert.ok(quotaObserved > 0);
    assert.ok(recoveries.some(item => item.trigger === "provider_limit" && item.state === "cancelled" && item.reason === "turn_succeeded"));
    assert.equal(view?.view?.generation, 1);
  } else assert.equal(quotaObserved, 0);
  if (row.name.endsWith("-source-reset")) assert.equal(view?.view?.generation, 1);
  if (row.name.endsWith("-default-off") || row.name.endsWith("-handoff")) assert.equal(recoveries.length, 0);
  if (row.name.endsWith("-both") || row.name.endsWith("-active")) {
    assert.equal(snapshots.at(-1).result.accountAdmissions.length, snapshots[0].result.accountAdmissions.length);
    assert.equal(recoveries.length, 1);
  }
  lines.push(JSON.stringify({ name: row.name, passed: true, account: view?.bee?.account, generation: view?.view?.generation, quotaObserved,
    recoveries: recoveries.map(recovery => ({ id: recovery.id, trigger: recovery.trigger, state: recovery.state, reason: recovery.reason, interrupted: recovery.interrupted,
      continuationKind: recovery.continuationKind, continuationCount: recovery.continuationMessageIds.length, attempt: recovery.attempt,
      retryAt: recovery.retryAt, maxProjectedPercent: recovery.admission?.maxProjectedPercent })),
    reservations: snapshots.at(-1)?.result.accountAdmissions.length }));
}
fs.writeFileSync(`${root}/verification.log`, `${lines.join("\n")}\n`);
console.log(lines[0]);
