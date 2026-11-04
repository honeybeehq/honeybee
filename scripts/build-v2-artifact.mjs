#!/usr/bin/env node
import { createHash } from "node:crypto";
/**
 * Bundle the v2 CLI, cell provision worker, and dedicated runner host. The
 * runner host is intentionally its own tiny sibling: a daemon loaded from an
 * immutable release must spawn that release's host without re-entering the
 * full CLI bundle.
 */
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { collectBuildIdentity } from "../dist/release/buildIdentityProducer.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outDir = join(root, "dist", "v2");
const runnerHostOutput = join(outDir, "runner-host.js");
const CLI_CHUNK_RE = /^cli-chunk-[A-Z0-9]+\.js$/;
const runnerHostInputs = [
  "src/comb/canonical.ts",
  "v2/core/src/processIdentity.ts",
  "v2/driver-hsr/src/gated-runner-host.ts",
  "v2/driver-hsr/src/delivery-receipts.ts",
  "v2/harness/src/processIdentity.ts",
  "v2/harness/src/statePath.ts",
  "src/runtimeEnvironment.ts",
  "src/processScheduling.ts",
  "v2/driver-hsr/src/runner-host-main.ts",
  "v2/driver-hsr/src/runner-host.ts",
  "v2/driver-hsr/src/runner-exit.ts",
  "src/peercredReceipt.ts",
];
const runnerHostMaxBytes = 32 * 1024;
await mkdir(outDir, { recursive: true });
await writeFile(join(root, "dist", "build-identity.json"), `${JSON.stringify(collectBuildIdentity(root), null, 2)}\n`);
await build({
  entryPoints: [join(root, "src", "v2", "updateOwnerClient.mjs")],
  outfile: join(outDir, "updateOwnerClient.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "silent",
});
for (const stale of (await readdir(outDir)).filter((name) => CLI_CHUNK_RE.test(name))) await rm(join(outDir, stale));
const cliBuild = await build({
  metafile: true,
  absWorkingDir: root,
  entryPoints: { cli: join(root, "v2", "cli", "src", "main.ts") },
  outdir: outDir,
  entryNames: "[name]",
  chunkNames: "cli-chunk-[hash]",
  splitting: true,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: false,
  preserveSymlinks: true,
  logLevel: "silent",
  // jsonc-parser's package main is an AMD/CommonJS wrapper with dynamic
  // relative requires, which cannot execute inside this bundled ESM runtime.
  // Resolve this one dependency to its published ESM build explicitly.
  alias: {
    "jsonc-parser": join(root, "node_modules", "jsonc-parser", "lib", "esm", "main.js"),
  },
  // node-pty is a native optional dependency (the login worker's PTY
  // backend); it is resolved at runtime from node_modules, never bundled.
  external: ["node-pty"],
});
const cliFiles = {};
for (const [output, metadata] of Object.entries(cliBuild.metafile.outputs)) {
  const name = basename(output);
  if (name !== "cli.js" && !CLI_CHUNK_RE.test(name)) throw new Error(`Unexpected Cell CLI output: ${output}`);
  const imports = metadata.imports.filter(item => !item.external).map(item => basename(item.path));
  cliFiles[name] = { sha256: createHash("sha256").update(await readFile(resolve(root, output))).digest("hex"), imports };
}
for (const metadata of Object.values(cliFiles)) {
  for (const name of metadata.imports) if (!Object.hasOwn(cliFiles, name)) throw new Error(`Missing Cell CLI import: ${name}`);
}
await writeFile(join(outDir, "cell-cli-manifest.json"), JSON.stringify({ version: 1, entry: "cli.js", files: cliFiles }) + "\n");
await build({
  absWorkingDir: root,
  entryPoints: [join(root, "v2", "driver-cell", "src", "provisionWorker.ts")],
  outfile: join(outDir, "provision-worker.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: false,
  preserveSymlinks: true,
  logLevel: "silent",
});
await build({
  absWorkingDir: root,
  entryPoints: [join(root, "v2", "driver-cell", "src", "poolWorker.ts")],
  outfile: join(outDir, "pool-worker.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: false,
  preserveSymlinks: true,
  logLevel: "silent",
});
await build({
  absWorkingDir: root,
  entryPoints: [join(root, "v2", "daemon", "src", "transcriptSegmentWorker.ts")],
  outfile: join(outDir, "transcript-segment-worker.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: false,
  preserveSymlinks: true,
  logLevel: "silent",
});
await build({
  absWorkingDir: root,
  entryPoints: [join(root, "v2", "driver-cell", "src", "retentionWorker.ts")],
  outfile: join(outDir, "retention-worker.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: false,
  preserveSymlinks: true,
  logLevel: "silent",
});
await build({
  absWorkingDir: root,
  entryPoints: [join(root, "v2", "driver-cell", "src", "inodeWorker.ts")],
  outfile: join(outDir, "inode-worker.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: false,
  preserveSymlinks: true,
  logLevel: "silent",
});
const runnerHostBuild = await build({
  absWorkingDir: root,
  entryPoints: [join(root, "v2", "driver-hsr", "src", "runner-host-main.ts")],
  outfile: runnerHostOutput,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: false,
  preserveSymlinks: true,
  metafile: true,
  logLevel: "silent",
});

// Keep this artifact deep and narrow. Any non-host import (especially the CLI
// or daemon graph) turns each runtime into another full Honeybee process, so a
// graph drift or surprising size increase is a build failure, not a benchmark
// surprise discovered after deployment.
const actualRunnerHostInputs = Object.keys(runnerHostBuild.metafile.inputs)
  .map((input) => relative(root, resolve(root, input)).replaceAll("\\", "/"))
  .sort();
const missingRunnerHostInputs = runnerHostInputs.filter((input) => !actualRunnerHostInputs.includes(input));
const unexpectedRunnerHostInputs = actualRunnerHostInputs.filter((input) => !runnerHostInputs.includes(input));
if (missingRunnerHostInputs.length > 0 || unexpectedRunnerHostInputs.length > 0) {
  throw new Error(
    [
      "v2 runner-host artifact import graph changed",
      missingRunnerHostInputs.length > 0 ? `missing: ${missingRunnerHostInputs.join(", ")}` : "",
      unexpectedRunnerHostInputs.length > 0 ? `unexpected: ${unexpectedRunnerHostInputs.join(", ")}` : "",
    ].filter(Boolean).join("; "),
  );
}
const runnerHostBytes = (await stat(runnerHostOutput)).size;
if (runnerHostBytes > runnerHostMaxBytes) {
  throw new Error(
    `v2 runner-host artifact is ${runnerHostBytes} bytes; limit is ${runnerHostMaxBytes} bytes (inspect its import graph)`,
  );
}

process.stdout.write(
  `v2 artifacts staged at dist/v2/cli.js, dist/v2/provision-worker.js, dist/v2/pool-worker.js, dist/v2/retention-worker.js, dist/v2/transcript-segment-worker.js, and dist/v2/runner-host.js (${runnerHostBytes} bytes)\n`,
);
