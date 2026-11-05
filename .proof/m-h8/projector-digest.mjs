#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at < 0 ? fallback : args[at + 1]; };
const root = resolve(option("--root", "."));
const out = resolve(option("--out", ".proof/m-h8/projector-digest.json"));
const corpora = args.filter((a, i) => a === "--corpus").map((_, k) => args[args.indexOf("--corpus", k === 0 ? 0 : args.indexOf("--corpus") + 1) + 1]);
const corpusDirs = [];
for (let i = 0; i < args.length; i++) if (args[i] === "--corpus") corpusDirs.push(resolve(args[i + 1]));
const manifestPath = option("--manifest", "");
const manifest = manifestPath ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
const { createTranscriptProjector, TRANSCRIPT_PARSERS, TRANSCRIPT_RENDERERS, renderTranscriptLines } = await import(pathToFileURL(join(root, "v2/driver-tmux/src/transcripts.ts")).href);
const { TRANSCRIPT_PROJECTION_VERSION } = await import(pathToFileURL(join(root, "v2/driver-tmux/src/transcript-projection.ts")).href);

function harnessOf(file) {
  const name = basename(file);
  if (manifest[name]) return manifest[name];
  if (name.startsWith("codex")) return "codex";
  if (name.startsWith("grok")) return "grok";
  if (name.startsWith("muse")) return "muse";
  if (name.startsWith("claude")) return "claude";
  if (name.startsWith("agy")) return "agy";
  if (name.startsWith("kimi")) return "kimi";
  return null;
}
const report = { root, projectionVersion: TRANSCRIPT_PROJECTION_VERSION, parsers: Object.keys(TRANSCRIPT_PARSERS).sort(), renderers: Object.keys(TRANSCRIPT_RENDERERS).sort(), files: {} };
for (const dir of corpusDirs) {
  for (const name of readdirSync(dir).sort()) {
    const file = join(dir, name);
    if (!statSync(file).isFile() || !name.endsWith(".jsonl")) continue;
    const harness = harnessOf(file);
    if (!harness) continue;
    const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.length > 0);
    const projector = createTranscriptProjector(harness);
    const events = [];
    for (const line of lines) events.push(...projector.pushLine(line));
    events.push(...projector.flush());
    const rendered = renderTranscriptLines(harness, lines);
    const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    report.files[name] = { harness, lines: lines.length, events: events.length, eventsDigest: digest(events), renderedTurns: rendered.length, renderedDigest: digest(rendered), checkpointDigest: digest(projector.checkpoint()) };
  }
}
writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ out, files: Object.keys(report.files).length, projectionVersion: report.projectionVersion }));
