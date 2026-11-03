#!/usr/bin/env node
/**
 * Dependency-light installed entrypoint.
 *
 * A frozen node runs v2 for almost every command. Loading the complete legacy
 * command graph before making that decision adds seconds to every `hive ls`,
 * `hive --version`, and RPC command, so choose the graph first and import only
 * the selected implementation.
 */
import { v2IsDefault } from "./cliRoute.js";
import { honeybeeBuildIdentity } from "./release/buildIdentity.js";

type V2Module = {
  runV2Cli(argv: string[]): Promise<number>;
};

type LegacyModule = {
  legacyCliCompletion: Promise<void>;
};

async function loadV2(): Promise<V2Module> {
  const specifier = new URL("./v2/cli.js", import.meta.url).href;
  return (await import(specifier)) as V2Module;
}

function printsPlainVersion(argv: string[]): boolean {
  return argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v" || argv[0] === "version");
}

async function runV2(argv: string[]): Promise<void> {
  if (printsPlainVersion(argv)) {
    process.stdout.write(`honeybee ${honeybeeBuildIdentity().version}\n`);
    return;
  }
  process.exitCode = await (await loadV2()).runV2Cli(argv);
}

async function main(argv: string[]): Promise<void> {
  if (argv[0] === "v2") {
    await runV2(argv.slice(1));
    return;
  }
  if (v2IsDefault(argv[0])) {
    await runV2(argv);
    return;
  }

  // build-cli-entry.mjs preserves tsc's full dispatcher under this name.
  const specifier = new URL("./cli-legacy.js", import.meta.url).href;
  const legacy = (await import(specifier)) as LegacyModule;
  await legacy.legacyCliCompletion;
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`hive: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
