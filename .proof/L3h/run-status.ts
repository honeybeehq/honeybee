import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { makeDaemonDir, startDaemon } from "../../v2/daemon/tests/helpers.ts";

const cli = resolve(import.meta.dirname, "../../v2/cli/src/bin.ts");
const cases = [
  { label: "valid naming", naming: { auto: true }, expect: "naming: ok" },
  { label: "naming turned off", naming: { auto: false }, expect: "naming: off" },
  { label: "invalid apiKeyRef", naming: { auto: true, backend: "openai-api", apiKeyRef: "global/openai-prod" }, expect: "naming: disabled (config: naming.apiKeyRef must be a hem secret ref" },
];
let ok = true;
for (const c of cases) {
  const { dir, cleanup } = makeDaemonDir({ naming: c.naming } as never);
  const daemon = await startDaemon(dir);
  try {
    console.log(`== ${c.label}: config.naming=${JSON.stringify(c.naming)}`);
    for (const args of [["daemon", "status"], ["health"], ["health", "--json"]]) {
      const out = execFileSync(process.execPath, [cli, ...args, "--data-dir", dir], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
      const shown = args.includes("--json") ? `naming=${JSON.stringify(JSON.parse(out).naming)}` : out.trim();
      console.log(`$ hive ${args.join(" ")} --data-dir <tmp>  (exit 0)\n${shown}`);
      if (!args.includes("--json") && !out.includes(c.expect)) ok = false;
    }
  } catch (error) {
    ok = false;
    console.log(`error: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await daemon.stop().catch(() => {});
    cleanup();
  }
}
console.log(`result=${ok ? "PASS" : "FAIL"}`);
process.exit(ok ? 0 : 1);
