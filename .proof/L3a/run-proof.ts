import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { makeDaemonDir, startDaemon, waitFor } from "../../v2/daemon/tests/helpers.ts";

const REF = process.argv[2] ?? "global/hive-naming-l3a-mock";
const FAKE_KEY = `sk-fake-l3a-${Math.random().toString(36).slice(2)}`;
const EXPECTED_SHA = createHash("sha256").update(FAKE_KEY).digest("hex");
const here = resolve(import.meta.dirname);
const hashes: string[] = [];
const server = createServer((req, res) => {
  const auth = String(req.headers.authorization ?? "");
  hashes.push(createHash("sha256").update(auth.replace(/^Bearer /, "")).digest("hex"));
  console.log(`stub: ${req.method} ${req.url} authorization=Bearer <sha256:${hashes.at(-1)!.slice(0, 16)}…> matchesExpected=${hashes.at(-1) === EXPECTED_SHA}`);
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json", "x-request-id": "req_l3a" });
    res.end(JSON.stringify({ id: "resp_l3a", output: [{ type: "message", content: [{ type: "output_text", text: "Hem Ref Naming Proof" }] }] }));
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const { dir, cleanup } = makeDaemonDir({ naming: { auto: true, backend: "openai-api", apiKeyRef: REF } } as never);
console.log(`dataDir=${dir}`);
console.log(`config.naming=${JSON.stringify(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).naming)}`);
const fakeHemDir = mkdtempSync(join(tmpdir(), "l3a-fake-hem-"));
symlinkSync(join(here, "fake-hem.mjs"), join(fakeHemDir, "hem"));
const daemonLog = () => readdirSync(dir).filter((f) => f.endsWith(".log") || f.endsWith(".jsonl")).map((f) => readFileSync(join(dir, f), "utf8")).join("\n") + daemon.output();
const daemon = await startDaemon(dir, {
  env: {
    L3A_OPENAI_STUB: `http://127.0.0.1:${port}`,
    NODE_OPTIONS: `--import=${join(here, "redirect-openai.mjs")}`,
    PATH: `${fakeHemDir}:${process.env.PATH ?? ""}`,
    L3A_FAKE_KEY: FAKE_KEY,
  },
});
let exitCode = 0;
try {
  const client = await daemon.client();
  const got = await client.request<{ naming: unknown }>("config.get", {});
  console.log(`config.get naming=${JSON.stringify(got.naming)}`);
  const { beeId } = await client.request<{ beeId: string }>("spawn", { name: "l3a", agent: "stub", cwd: "/tmp" });
  await client.request("send", { beeId, body: "Please refactor the billing reconciliation job" });
  await waitFor(async () => Boolean((await client.request<{ bee?: { title?: string | null } }>("view", { beeId })).bee?.title) || /autoTitle\.error/.test(daemonLog()), "auto title outcome", 30_000);
  const view = await client.request<{ bee?: { title?: string | null } }>("view", { beeId });
  console.log(`bee.title=${JSON.stringify(view.bee?.title)}`);
  const usage = await client.request<{ usage: { requests: number; succeeded: number } }>("naming.usage", {});
  console.log(`naming.usage requests=${usage.usage.requests} succeeded=${usage.usage.succeeded}`);
  client.close();
  const log = daemonLog().split("\n").filter((l) => /autoTitle|hem/.test(l));
  console.log("daemon log (autoTitle/hem lines):\n" + log.join("\n"));
  const secretInLog = daemonLog().includes(FAKE_KEY);
  console.log(`daemonOutputContainsKeyPrefix=${secretInLog}`);
  const expectFailure = process.env.L3A_EXPECT_FAILURE === "1";
  if (expectFailure ? hashes.length !== 0 || !/autoTitle\.error[^\n]*hem ref/.test(daemonLog()) : hashes.length === 0 || hashes.some((h) => h !== EXPECTED_SHA) || secretInLog) exitCode = 1;
} catch (error) {
  console.log(`error: ${error instanceof Error ? error.message : String(error)}`);
  console.log(daemonLog().split("\n").filter((l) => /autoTitle|hem/.test(l)).join("\n"));
  exitCode = 1;
} finally {
  await daemon.stop().catch(() => {});
  server.close();
  cleanup();
  rmSync(fakeHemDir, { recursive: true, force: true });
}
process.exit(exitCode);
