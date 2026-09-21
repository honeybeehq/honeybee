import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { GitHubReleaseStore, notifyHoneybeeRelease } from "../src/release/github.js";

test("production publisher rejects execution outside the owning repository's Actions lock", () => {
  for (const context of [{ GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "honeybeehq/apiary" }, { GITHUB_ACTIONS: "false", GITHUB_REPOSITORY: "honeybeehq/honeybee" }]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/publish-honeybee-release.mjs"], {
      encoding: "utf8", env: { ...process.env, ...context, HONEYBEE_SOURCE_REVISION: "invalid" },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Dispatch release.yml in honeybeehq\/honeybee/);
  }
});

// HTTP is the external system boundary. No credentials or network calls enter these tests.
function githubFixture() {
  let draft = true;
  const files = new Map<string, { id: number; bytes: Uint8Array; state?: string }>();
  const writes: string[] = [];
  let immutable = true;
  const release = () => ({ id: 7, tag_name: "honeybee-v0.1.0-darwin-arm64", draft, immutable: !draft && immutable });
  const json = (value: unknown) => new Response(JSON.stringify(value));
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? "GET";
    if (method !== "GET") writes.push(`${method} ${url.pathname}`);
    if (url.pathname.endsWith("/immutable-releases")) return json({ enabled: immutable });
    if (url.pathname.endsWith("/releases") && method === "GET") return json([release()]);
    if (url.hostname === "uploads.github.com") {
      const name = url.searchParams.get("name")!;
      if (!draft || files.has(name)) return new Response("conflict", { status: 422 });
      files.set(name, { id: files.size + 1, bytes: new Uint8Array(init?.body as Uint8Array) });
      return json({});
    }
    if (url.pathname.endsWith("/releases/7/assets")) return json([...files].map(([name, file]) => ({ name, id: file.id, state: file.state ?? "uploaded", size: file.bytes.length })));
    if (url.pathname.includes("/releases/assets/")) {
      const [name, file] = [...files].find(([, a]) => a.id === Number(url.pathname.split("/").at(-1)))!;
      if (method === "DELETE") { files.delete(name); return new Response(null, { status: 204 }); }
      if ((init?.headers as Record<string, string>).Accept === "application/octet-stream") return new Response(Buffer.from(file.bytes));
      return json({ id: file.id, name, state: file.state ?? "uploaded", size: file.bytes.length });
    }
    if (url.pathname.endsWith("/releases/7")) {
      if (method === "PATCH") draft = false;
      return json(release());
    }
    throw new Error(`Unexpected HTTP ${method} ${url}`);
  };
  return { request, writes, files, disableImmutability: () => { immutable = false; } };
}

test("GitHub release adapter refuses disabled immutability before creating assets", async () => {
  const github = githubFixture(); github.disableImmutability();
  const store = new GitHubReleaseStore("honeybee-v0.1.0-darwin-arm64", "test-token", github.request);
  await assert.rejects(store.open(), /enable immutable/);
  assert.deepEqual(github.writes, []);
});

test("GitHub draft upload is create-only and publication confirms host immutability", async () => {
  const github = githubFixture(), bytes = new TextEncoder().encode("original bytes");
  const store = new GitHubReleaseStore("honeybee-v0.1.0-darwin-arm64", "test-token", github.request);
  await store.open(); await store.put("runtime.tgz", bytes);
  assert.deepEqual(await store.read("runtime.tgz"), bytes);
  await assert.rejects(store.put("runtime.tgz", new TextEncoder().encode("replacement")), /422/);
  await store.seal(); await store.seal();
  await assert.rejects(store.put("late.json", bytes), /Published/);
  assert.deepEqual(await store.read("runtime.tgz"), bytes);
  assert.equal(github.writes.filter(x => x.startsWith("PATCH")).length, 1);
});

test("evaluator dispatch carries the exact immutable descriptor and stable event key", async () => {
  const descriptor = { url: "https://github.com/honeybeehq/apiary-releases/releases/download/honeybee-v0.1.0-darwin-arm64/release.json", sha256: `sha256:${"a".repeat(64)}` };
  const event = { schemaVersion: 1 as const, eventKey: descriptor.sha256, descriptor };
  const requests: unknown[] = [];
  const request: typeof fetch = async (url, init) => {
    assert.equal(url, "https://api.github.com/repos/honeybeehq/apiary/dispatches");
    requests.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 204 });
  };
  await notifyHoneybeeRelease(event, "test-token", request);
  assert.deepEqual(requests, [{ event_type: "honeybee-release-published-v1", client_payload: event }]);
});


test("rerun recovers an abandoned empty draft starter after interrupted GitHub upload", async () => {
  const github = githubFixture();
  github.files.set("runtime.tgz", { id: 1, bytes: new Uint8Array(), state: "starter" });
  const store = new GitHubReleaseStore("honeybee-v0.1.0-darwin-arm64", "test-token", github.request);
  await store.open();
  assert.equal(await store.read("runtime.tgz"), null);
  await store.put("runtime.tgz", new TextEncoder().encode("checked runtime"));
  assert.equal(new TextDecoder().decode((await store.read("runtime.tgz"))!), "checked runtime");
  assert.equal(github.writes.filter(x => x.startsWith("DELETE")).length, 1);
});

test("starter recovery never deletes nonempty or published assets", async () => {
  const github = githubFixture();
  github.files.set("runtime.tgz", { id: 1, bytes: new TextEncoder().encode("data"), state: "starter" });
  const store = new GitHubReleaseStore("honeybee-v0.1.0-darwin-arm64", "test-token", github.request);
  await store.open();
  await assert.rejects(store.read("runtime.tgz"), /Incomplete/);
  github.files.set("runtime.tgz", { id: 1, bytes: new Uint8Array(), state: "starter" });
  await store.seal();
  await assert.rejects(store.read("runtime.tgz"), /Incomplete/);
  assert.equal(github.writes.filter(x => x.startsWith("DELETE")).length, 0);
});
