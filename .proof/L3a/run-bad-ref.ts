import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeDaemonDir, startDaemon } from "../../v2/daemon/tests/helpers.ts";

const cli = resolve(import.meta.dirname, "../../v2/cli/src/bin.ts");
const { dir, cleanup } = makeDaemonDir({ naming: { auto: true, backend: "openai-api", apiKeyRef: "global/openai-prod" } } as never);
console.log(`config.naming=${JSON.stringify(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).naming)}`);
let ok = false;
const daemon = await startDaemon(dir);
try {
  const client = await daemon.client();
  const got = await client.request<{ naming: { auto: boolean; disabledReason?: string } }>("config.get", {});
  console.log(`config.get naming=${JSON.stringify(got.naming)}`);
  await client.request("spawn", { name: "bad-ref-probe", agent: "stub", cwd: "/tmp" });
  client.close();
  const env = { ...process.env, HIVE_V2_DATA_DIR: dir };
  const list = execFileSync(process.execPath, [cli, "list", "--data-dir", dir], { env, encoding: "utf8" });
  console.log(`$ hive list --data-dir <tmp>  (exit 0)\n${list.trim()}`);
  const disabledLines = readFileSync(join(dir, "hived.log"), "utf8").split("\n").filter((l) => l.includes("naming.disabled"));
  console.log(`daemon log:\n${disabledLines.join("\n")}`);
  ok = got.naming.auto === false && /apiKeyRef must be a hem secret ref/.test(got.naming.disabledReason ?? "") &&
    list.includes("bad-ref-probe") && disabledLines.length === 1;
} catch (error) {
  console.log(`error: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await daemon.stop().catch(() => {});
  cleanup();
}
console.log(`result=${ok ? "PASS" : "FAIL"}`);
process.exit(ok ? 0 : 1);
