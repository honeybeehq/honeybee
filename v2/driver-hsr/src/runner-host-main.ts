// Direct source entry for tests and the dedicated dist/v2/runner-host.js
// artifact. The hidden `hive v2 runner-host` verb remains as compatibility
// plumbing, but HsrDriver does not route production starts through the CLI.
//   node --experimental-strip-types runner-host-main.ts <configPath>
import { runRunnerHost } from "./runner-host.ts";

const configPath = process.argv[2];
if (!configPath) {
  process.stderr.write("usage: runner-host <configPath>\n");
  process.exit(2);
}
runRunnerHost(configPath);
