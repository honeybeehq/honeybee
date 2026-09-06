#!/usr/bin/env node
/**
 * Bundle the v2 CLI, cell provision worker, and dedicated runner host. The
 * runner host is intentionally its own tiny sibling: a daemon loaded from an
 * immutable release must spawn that release's host without re-entering the
 * full CLI bundle.
 */
import { mkdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outDir = join(root, "dist", "v2");
const runnerHostOutput = join(outDir, "runner-host.js");
const runnerHostInputs = [
  "v2/driver-hsr/src/runner-host-main.ts",
  "v2/driver-hsr/src/runner-host.ts",
];
const runnerHostMaxBytes = 32 * 1024;
await mkdir(outDir, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: [join(root, "v2", "cli", "src", "main.ts")],
  outfile: join(outDir, "cli.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: false,
  preserveSymlinks: true,
  logLevel: "silent",
  // node-pty is a native optional dependency (the login worker's PTY
  // backend); it is resolved at runtime from node_modules, never bundled.
  external: ["node-pty"],
});
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
  `v2 artifacts staged at dist/v2/cli.js, dist/v2/provision-worker.js, and dist/v2/runner-host.js (${runnerHostBytes} bytes)\n`,
);
