#!/usr/bin/env node
/** Direct daemon executable (used by tests; production goes through `hive v2 daemon run`). */
import { VaultRootRequiredError } from "./config.ts";
import { runDaemon } from "./main.ts";
import { RpcError } from "./protocol.ts";

process.exitCode = await runDaemon(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof RpcError || err instanceof VaultRootRequiredError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err));
  return 1;
});
