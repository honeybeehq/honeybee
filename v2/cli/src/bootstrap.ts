#!/usr/bin/env node
import { readFileSync } from "node:fs";

/** Installed `hive` entry: answer a plain version from the build facts, otherwise load the v2 CLI bundle beside this file. */
function printsPlainVersion(argv: string[]): boolean {
  return argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v" || argv[0] === "version");
}

async function main(argv: string[]): Promise<void> {
  if (argv[0] === "v2") argv = argv.slice(1);
  if (printsPlainVersion(argv)) {
    try {
      const identity = JSON.parse(readFileSync(new URL("./build-identity.json", import.meta.url), "utf8"));
      if (identity?.component === "honeybee" && typeof identity.version === "string") {
        process.stdout.write(`honeybee ${identity.version}\n`);
        return;
      }
    } catch {}
  }
  const cli = (await import(new URL("./v2/cli.js", import.meta.url).href)) as { runV2Cli(argv: string[]): Promise<number> };
  process.exitCode = await cli.runV2Cli(argv);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`hive: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
