import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { makeDaemonDir, startDaemon, waitFor } from "../../v2/daemon/tests/helpers.ts";

const MODE = process.argv[2] ?? "success";
const REFS: Record<string, string> = {
  success: "global/hive-naming-l3a-mock",
  rejected: "global/hive-naming-l3a-mock",
  missing: "global/hive-naming-l3a-missing",
  pending: "global/hive-naming-l3a-pending",
};
const REF = REFS[MODE];
if (!REF) throw new Error(`unknown mode ${MODE}`);
const FAKE_KEY = `sk-fake-l3a-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
const KEY_TAIL = FAKE_KEY.slice(-6);
const EXPECTED_SHA = createHash("sha256").update(FAKE_KEY).digest("hex");
const here = resolve(import.meta.dirname);
const hashes: string[] = [];
const server = createServer((req, res) => {
  const auth = String(req.headers.authorization ?? "");
  hashes.push(createHash("sha256").update(auth.replace(/^Bearer /, "")).digest("hex"));
  console.log(`stub: ${req.method} ${req.url} authorization=Bearer <sha256:${hashes.at(-1)!.slice(0, 16)}…> matchesExpected=${hashes.at(-1) === EXPECTED_SHA}`);
  req.resume();
  req.on("end", () => {
    if (MODE === "rejected") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `Incorrect API key provided: sk-fake***${KEY_TAIL}`, type: "invalid_request_error" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json", "x-request-id": "req_l3a" });
    res.end(JSON.stringify({ id: "resp_l3a", output: [{ type: "message", content: [{ type: "output_text", text: "Hem Ref Naming Proof" }] }] }));
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const { dir, cleanup } = makeDaemonDir({ naming: { auto: true, backend: "openai-api", apiKeyRef: REF } } as never);
console.log(`mode=${MODE}`);
console.log(`config.naming=${JSON.stringify(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).naming)}`);
const fakeHemDir = mkdtempSync(join(tmpdir(), "l3a-fake-hem-"));
symlinkSync(join(here, "fake-hem.mjs"), join(fakeHemDir, "hem"));
writeFileSync(join(fakeHemDir, "key"), FAKE_KEY, { mode: 0o600 });
const hemCallsPath = join(fakeHemDir, "calls.log");
const hemCalls = () => (existsSync(hemCallsPath) ? readFileSync(hemCallsPath, "utf8").split("\n").filter(Boolean).length : 0);
const daemonLog = () =>
  readdirSync(dir).filter((f) => f.endsWith(".log") || f.endsWith(".jsonl")).map((f) => readFileSync(join(dir, f), "utf8")).join("\n") + daemon.output();
const storeBytes = () => readdirSync(dir).filter((f) => f.startsWith("core.sqlite3")).map((f) => readFileSync(join(dir, f)).toString("latin1")).join("");
const errorCount = () => (daemonLog().match(/autoTitle\.error/g) ?? []).length;
const daemon = await startDaemon(dir, {
  env: {
    L3A_OPENAI_STUB: `http://127.0.0.1:${port}`,
    NODE_OPTIONS: `--import=${join(here, "redirect-openai.mjs")}`,
    PATH: `${fakeHemDir}:${process.env.PATH ?? ""}`,
  },
});
let ok = false;
try {
  const client = await daemon.client();
  const got = await client.request<{ naming: unknown }>("config.get", {});
  console.log(`config.get naming=${JSON.stringify(got.naming)}`);
  const { beeId } = await client.request<{ beeId: string }>("spawn", { name: "l3a", agent: "stub", cwd: "/tmp" });
  await client.request("send", { beeId, body: "Please refactor the billing reconciliation job" });
  const attemptsWanted = MODE === "pending" ? 2 : 1;
  await waitFor(
    async () => Boolean((await client.request<{ bee?: { title?: string | null } }>("view", { beeId })).bee?.title) || errorCount() >= attemptsWanted,
    "auto title outcome",
    60_000,
  );
  const view = await client.request<{ bee?: { title?: string | null } }>("view", { beeId });
  const usage = await client.request<{ usage: { requests: number; succeeded: number; failed: number } }>("naming.usage", {});
  client.close();
  console.log(`bee.title=${JSON.stringify(view.bee?.title)}`);
  console.log(`naming.usage requests=${usage.usage.requests} succeeded=${usage.usage.succeeded} failed=${usage.usage.failed}`);
  console.log(`hem invocations=${hemCalls()} openai requests=${hashes.length}`);
  if (existsSync(hemCallsPath)) console.log(`hem calls:\n${readFileSync(hemCallsPath, "utf8").trim()}`);
  const log = daemonLog();
  console.log("daemon log (autoTitle lines):\n" + log.split("\n").filter((l) => /autoTitle/.test(l)).join("\n"));
  const leaked = [log, storeBytes()].some((text) => text.includes(FAKE_KEY) || text.includes(KEY_TAIL) || text.includes("Incorrect API key"));
  console.log(`key, key tail or provider key text in daemon log or store=${leaked}`);
  const checks: Record<string, () => boolean> = {
    success: () => view.bee?.title === "Hem Ref Naming Proof" && hashes.length === 1 && hashes[0] === EXPECTED_SHA,
    rejected: () => hashes.length >= 1 && hashes.every((h) => h === EXPECTED_SHA) && /OpenAI API naming failed \(401\): the API key was rejected/.test(log),
    missing: () => hashes.length === 0 && /hem ref \\"global\/hive-naming-l3a-missing\\" could not be read: secret not found/.test(log),
    pending: () => hashes.length === 0 && hemCalls() === 1 && errorCount() >= 2 && /waiting for approval in hem/.test(log),
  };
  ok = !leaked && checks[MODE]!();
} catch (error) {
  console.log(`error: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await daemon.stop().catch(() => {});
  server.close();
  cleanup();
  rmSync(fakeHemDir, { recursive: true, force: true });
}
console.log(`result=${ok ? "PASS" : "FAIL"}`);
process.exit(ok ? 0 : 1);
