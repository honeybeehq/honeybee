import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readAccessOnlyCodex } from "../v2/driver-cell/src/codexAccess.ts";

const args = process.argv.slice(2);
const flags = new Map();
for (let index = 0; index < args.length; index += 2) {
  if (!["--data-dir", "--authority-node"].includes(args[index]) || !args[index + 1] || flags.has(args[index])) process.exit(1);
  flags.set(args[index], args[index + 1]);
}
const dataDir = flags.get("--data-dir"), authority = flags.get("--authority-node");
if (process.env.HIVE_CELL === "1" || !dataDir || !isAbsolute(dataDir) || !authority || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(authority)) process.exit(1);
const cli = fileURLToPath(new URL("../v2/cli/src/bin.ts", import.meta.url));
const response = spawnSync(process.execPath, [cli, "account", "list", "--harness", "codex", "--json", "--data-dir", dataDir], { encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
if (response.status !== 0) process.exit(1);
let accounts;
try { accounts = JSON.parse(response.stdout).accounts; } catch { process.exit(1); }
if (!Array.isArray(accounts)) process.exit(1);
let failed = false;
for (const account of accounts) {
  const id = typeof account?.id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._@-]{0,199}$/.test(account.id) ? account.id : "invalid-account";
  const source = account?.source === "leased" ? "leased" : account?.source === "local" ? "local" : "unknown";
  let pass = id !== "invalid-account" && account.harness === "codex" && account.status === "ok" && source === "leased" && account.leasedFrom?.authorityNodeId === authority && account.leasedFrom?.materialPublished === true && account.leasedFrom?.revokedAt === null && Number.isFinite(account.leasedFrom?.expiresAt) && account.leasedFrom.expiresAt * 1000 > Date.now();
  try {
    if (!pass || typeof account.homePath !== "string" || !isAbsolute(account.homePath)) throw new Error();
    const home = lstatSync(account.homePath);
    if (!home.isDirectory() || home.isSymbolicLink()) throw new Error();
    readAccessOnlyCodex(join(account.homePath, "auth.json"));
    const legacy = lstatSync(join(account.homePath, ".codex"), { throwIfNoEntry: false });
    if (legacy) {
      if (!legacy.isDirectory() || legacy.isSymbolicLink()) throw new Error();
      const mirror = join(account.homePath, ".codex", "auth.json");
      if (lstatSync(mirror, { throwIfNoEntry: false })) readAccessOnlyCodex(mirror);
    }
  } catch { pass = false; }
  process.stdout.write(JSON.stringify({ id, source, result: pass ? "PASS" : "FAIL" }) + "\n");
  if (!pass) failed = true;
}
process.exit(failed ? 1 : 0);
