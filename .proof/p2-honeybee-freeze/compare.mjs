#!/usr/bin/env node
// Diff the before/ and after/ captures scenario by scenario. Raw bytes first;
// then with only run-specific noise masked: ISO timestamps, absence-receipt
// file names (epoch-pid), node warnings about the fixture's typeless package.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [beforeArg, afterArg, outArg] = process.argv.slice(2);
const before = resolve(beforeArg), after = resolve(afterArg), out = resolve(outArg);
const names = [...new Set([...readdirSync(before), ...readdirSync(after)])].filter((name) => name.endsWith(".stdout") || name.endsWith(".stderr")).sort();
const read = (dir, name) => { try { return readFileSync(join(dir, name), "utf8"); } catch { return null; } };
const mask = (text) => text === null ? null : text
  .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<ISO>")
  .replace(/\.store-absence\/\d+-\d+\.json/g, ".store-absence/<EPOCH-PID>.json")
  .split("\n").filter((line) => !/MODULE_TYPELESS_PACKAGE_JSON|Reparsing as ES module|To eliminate this warning|trace-warnings/.test(line)).join("\n");
const exits = (dir) => Object.fromEntries(JSON.parse(readFileSync(join(dir, "exit-codes.json"), "utf8")).map((row) => [row.name, row.code]));
const beforeExit = exits(before), afterExit = exits(after);
const rows = [];
const diffs = [];
for (const name of names) {
  const a = read(before, name), b = read(after, name);
  const raw = a === b;
  const masked = mask(a) === mask(b);
  const scenario = name.replace(/\.(stdout|stderr)$/, "");
  rows.push({ name, scenario, exitBefore: beforeExit[scenario], exitAfter: afterExit[scenario], raw, masked, bytesBefore: a?.length ?? null, bytesAfter: b?.length ?? null });
  if (!masked) diffs.push({ name, before: mask(a), after: mask(b) });
}
const lines = ["# deploy / rollback / completion: before vs after", "", `before: ${before}`, `after: ${after}`, "",
  "| scenario | file | exit before | exit after | raw identical | identical after masking timestamps and receipt names |", "|---|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.scenario} | ${r.name.split(".").pop()} | ${r.exitBefore ?? ""} | ${r.exitAfter ?? ""} | ${r.raw ? "yes" : "no"} | ${r.masked ? "yes" : "NO"} |`),
  "", "## Differences after masking", ""];
for (const d of diffs) lines.push(`### ${d.name}`, "", "before:", "```", d.before ?? "<missing>", "```", "after:", "```", d.after ?? "<missing>", "```", "");
if (diffs.length === 0) lines.push("none");
writeFileSync(out, `${lines.join("\n")}\n`);
console.log(JSON.stringify({ scenarios: rows.length, rawIdentical: rows.filter((r) => r.raw).length, maskedIdentical: rows.filter((r) => r.masked).length, differing: diffs.map((d) => d.name) }));
