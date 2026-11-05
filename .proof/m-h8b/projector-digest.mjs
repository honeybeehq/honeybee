#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at < 0 ? fallback : args[at + 1]; };
const root = resolve(option("--root", "."));
const out = resolve(option("--out", ".proof/m-h8b/projector-digest.json"));
const registryModule = option("--registry", "v2/adapters/src/transcripts.ts");
const versionModule = option("--version-module", "v2/adapters/src/transcript.ts");
const corpusDirs = [];
for (let i = 0; i < args.length; i++) if (args[i] === "--corpus") corpusDirs.push(resolve(args[i + 1]));
const registry = await import(pathToFileURL(join(root, registryModule)).href);
const { TRANSCRIPT_PROJECTION_VERSION } = await import(pathToFileURL(join(root, versionModule)).href);
const { createTranscriptProjector, restoreTranscriptProjector, renderTranscriptLines } = registry;

function harnessOf(dir, name) {
  const manifestPath = join(dir, "manifest.json");
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
  if (manifest[name]) return manifest[name];
  for (const harness of ["codex", "grok", "muse", "claude", "agy", "kimi", "stub"]) if (name.startsWith(harness)) return harness;
  return null;
}
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const report = { root, registryModule, projectionVersion: TRANSCRIPT_PROJECTION_VERSION, files: {} };
for (const dir of corpusDirs) {
  for (const name of readdirSync(dir).sort()) {
    const file = join(dir, name);
    if (!statSync(file).isFile() || !name.endsWith(".jsonl")) continue;
    const harness = harnessOf(dir, name);
    if (!harness) continue;
    const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.length > 0);
    const projector = createTranscriptProjector(harness);
    const events = [];
    const checkpoints = [];
    const resumedEvents = [];
    let resumed = createTranscriptProjector(harness);
    for (const line of lines) {
      events.push(...projector.pushLine(line));
      resumedEvents.push(...resumed.pushLine(line));
      const checkpoint = resumed.checkpoint();
      checkpoints.push(checkpoint);
      const restored = restoreTranscriptProjector(harness, JSON.parse(JSON.stringify(checkpoint)));
      if (!restored.ok) throw new Error(`${name}: restore failed ${restored.reason}`);
      resumed = restored.projector;
    }
    events.push(...projector.flush());
    resumedEvents.push(...resumed.flush());
    const rendered = renderTranscriptLines(harness, lines);
    const unknownFallback = harness === "claude" ? renderTranscriptLines("some-unknown-harness", lines) : null;
    report.files[`${basename(dir)}/${name}`] = {
      harness, lines: lines.length, events: events.length,
      eventsDigest: digest(events),
      resumedEventsDigest: digest(resumedEvents),
      checkpointsDigest: digest(checkpoints),
      renderedTurns: rendered.length, renderedDigest: digest(rendered),
      ...(unknownFallback ? { unknownHarnessFallbackDigest: digest(unknownFallback) } : {}),
    };
  }
}
writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ out, files: Object.keys(report.files).length, projectionVersion: report.projectionVersion }));
