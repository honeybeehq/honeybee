import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { isTestDaemonEnv, refuseNonLoopbackFetch } from "../src/testNetworkGuard.ts";

test("test network guard: a test daemon env refuses real provider hosts and allows loopback", async (t) => {
  assert.equal(isTestDaemonEnv({ HIVE_TEST_REAP_RUNTIMES_ON_SHUTDOWN: "1" }), true);
  assert.equal(isTestDaemonEnv({ HIVE_V2_DATA_DIR: "/x" }), false);
  const realFetch = globalThis.fetch;
  const marker = globalThis as { __hiveMetaLoopback?: boolean };
  const savedMarker = marker.__hiveMetaLoopback;
  const savedMeta = process.env.HIVE_TEST_META_URL;
  t.after(() => {
    globalThis.fetch = realFetch;
    marker.__hiveMetaLoopback = savedMarker;
    if (savedMeta === undefined) delete process.env.HIVE_TEST_META_URL;
    else process.env.HIVE_TEST_META_URL = savedMeta;
  });
  const server = createServer((req, res) => {
    if (req.url === "/redirect") { res.writeHead(302, { Location: "https://platform.claude.com/v1/oauth/token" }); res.end(); }
    else res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const refused: string[] = [];
  refuseNonLoopbackFetch((op) => refused.push(op));
  delete process.env.HIVE_TEST_META_URL;

  for (const url of ["https://platform.claude.com/v1/oauth/token", "https://api.anthropic.com/api/oauth/usage", "https://auth.openai.com/oauth/token", "https://auth.meta.com/x"]) {
    await assert.rejects(fetch(url, { method: "POST" }), /test daemon refused a non-loopback request/, url);
  }
  assert.deepEqual(refused, ["test.network.refused host=platform.claude.com", "test.network.refused host=api.anthropic.com", "test.network.refused host=auth.openai.com", "test.network.refused host=auth.meta.com"]);
  process.env.HIVE_TEST_META_URL = "http://127.0.0.1:9";
  await assert.rejects(fetch("https://auth.meta.com/oauth/token"), /test daemon refused/, "the env var alone, without the meta preload, never opens Meta");
  const local = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  assert.equal(await local.text(), "ok");
  const redirectUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/redirect`;
  await assert.rejects(fetch(redirectUrl), /fetch failed/, "a loopback redirect cannot reach a provider");
  marker.__hiveMetaLoopback = true;
  process.env.HIVE_TEST_META_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const variant of ["https://AUTH.META.COM", "https://auth.meta.com:443/oauth/token", "https://auth.meta.com"]) {
    assert.equal(await (await fetch(variant)).text(), "ok", "guard rewrites normalized Meta variants itself");
  }
  const manual = await fetch(redirectUrl, { redirect: "manual" });
  assert.equal(manual.status, 302);
});
