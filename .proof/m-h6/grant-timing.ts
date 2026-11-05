// M-H6 timing: account.lease.grant and account.get latency on one scratch daemon (trust on).
//   node scripts/with-fixture-warden.mjs node --experimental-strip-types .proof/m-h6/grant-timing.ts [--derived]
// --derived omits shareId/epoch (only the H6 tree accepts that); without it the pre-H6 call shape is used on both trees.
import { createHmac } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RpcClient } from "../../v2/cli/src/client.ts";
import { localTrustMessage, type LocalTrustChallenge } from "../../v2/daemon/src/localRpcTrust.ts";
import { makeDaemonDir, startDaemon, forceStopTestDaemon } from "../../v2/daemon/tests/helpers.ts";

const derived = process.argv.includes("--derived");
const fakeJwt = (expSeconds: number): string => { const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url"); return `${b64({ alg: "none", typ: "JWT" })}.${b64({ exp: expSeconds, sub: "fixture" })}.FIXTURESIG`; };
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]!; };
const d = makeDaemonDir();
const cfg = JSON.parse(readFileSync(join(d.dir, "config.json"), "utf8")); cfg.rpcLocalTrust = { requireObservationCaller: true, registrationKeyFile: join(d.dir, "rpc-private", "registration.key") }; writeFileSync(join(d.dir, "config.json"), JSON.stringify(cfg));
const h = await startDaemon(d.dir, { stopTimeoutMs: 30_000 });
const c = await h.client();
try {
  const challenge = await c.request<LocalTrustChallenge>("rpc.localTrust.challenge");
  const key = readFileSync(join(d.dir, "rpc-private", "registration.key"));
  await c.request("rpc.localTrust.register", { pid: challenge.pid, challengeId: challenge.challengeId, token: createHmac("sha256", key).update(localTrustMessage(challenge)).digest("hex"), nodeId: "timing-node" });
  const exp = Math.floor(Date.now() / 1000) + 8 * 24 * 3600;
  for (let i = 0; i < 20; i++) {
    await c.request("account.add", { harness: "codex", label: `t${i}` });
    const vault = join(d.dir, "vault", "codex", `codex-t${i}`); mkdirSync(vault, { recursive: true });
    writeFileSync(join(vault, "auth.json"), JSON.stringify({ tokens: { id_token: "id", access_token: fakeJwt(exp), refresh_token: `R${i}`, account_id: "acct" } }));
  }
  const params = (i: number) => ({ id: `codex-t${i % 20}`, nodeId: "node-b", ...(derived ? {} : { shareId: `share-codex-t${i % 20}`, epoch: 1 }) });
  for (let i = 0; i < 20; i++) await c.request("account.lease.grant", params(i), 60_000);
  const grants: number[] = [], gets: number[] = [], lists: number[] = [];
  for (let i = 0; i < 100; i++) { const t = process.hrtime.bigint(); await c.request("account.lease.grant", params(i), 60_000); grants.push(Number(process.hrtime.bigint() - t) / 1e6); }
  for (let i = 0; i < 200; i++) { const t = process.hrtime.bigint(); await c.request("account.get", { id: `codex-t${i % 20}` }); gets.push(Number(process.hrtime.bigint() - t) / 1e6); }
  for (let i = 0; i < 100; i++) { const t = process.hrtime.bigint(); await c.request("account.list", {}); lists.push(Number(process.hrtime.bigint() - t) / 1e6); }
  console.log(JSON.stringify({ shape: derived ? "derived (no shareId/epoch)" : "explicit shareId/epoch", grantMs: { n: grants.length, p50: +pct(grants, 0.5).toFixed(2), p95: +pct(grants, 0.95).toFixed(2) }, accountGetMs: { n: gets.length, p50: +pct(gets, 0.5).toFixed(3), p95: +pct(gets, 0.95).toFixed(3) }, accountListMs: { n: lists.length, accounts: 20, p50: +pct(lists, 0.5).toFixed(3), p95: +pct(lists, 0.95).toFixed(3) } }));
} finally { c.close(); await forceStopTestDaemon(h); d.cleanup(); }
