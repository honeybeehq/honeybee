import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { gitEnv } from "../src/git.ts";
import { mirrorDirFor, refreshUpstreamMirror as refreshNetworkMirror, syncOriginFromMirror as syncNetworkMirror, UPSTREAM_REF } from "../src/upstream.ts";
import { resolveUpstreamSshPolicy, upstreamFetchEnv, validatedUpstreamSsh, UpstreamFetchError, upstreamFetchFailure } from "../src/upstreamFetch.ts";
import { readUpstreamFailure } from "../src/upstreamFetchState.ts";
import { g, makeOrigin } from "./helpers.ts";

const refreshUpstreamMirror = (origin: string, root: string, opts: Parameters<typeof refreshNetworkMirror>[2]) => refreshNetworkMirror(origin, root, { ...opts, allowLocalFixture: true });
const syncOriginFromMirror = (origin: string, root: string, opts: Parameters<typeof syncNetworkMirror>[2]) => syncNetworkMirror(origin, root, { ...opts, allowLocalFixture: true });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "upstream-fence-"));
  const origin = makeOrigin(root);
  const remote = join(root, "remote.git");
  g(root, ["clone", "--bare", "--no-hardlinks", origin.repo, remote]);
  g(origin.repo, ["remote", "add", "origin", remote]);
  g(origin.repo, ["fetch", "origin"]);
  g(origin.repo, ["branch", "--set-upstream-to", "origin/main"]);
  return { root, origin, remote, mirrors: join(root, "mirrors"), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("upstream fetch ignores repository and ambient executable transport settings", () => {
  const f = fixture();
  const marker = join(f.root, "executed");
  const command = `touch '${marker}'`;
  const saved = process.env.GIT_SSH_COMMAND;
  try {
    g(f.origin.repo, ["config", "core.sshCommand", command]);
    g(f.origin.repo, ["config", "core.gitProxy", command]);
    process.env.GIT_SSH_COMMAND = command;
    assert.equal(refreshUpstreamMirror(f.origin.repo, f.mirrors, { maxAgeMs: 0, timeoutMs: 5000 }).status, "fetched");
    const mirror = mirrorDirFor(f.mirrors, f.remote);
    for (const key of ["core.sshCommand", "core.gitProxy", "core.askPass", "credential.helper", "http.https://example.invalid/.extraHeader"]) g(mirror, ["config", key, command]);
    const env = upstreamFetchEnv(mirror, "https://example.invalid/repo", undefined);
    const get = (key: string) => spawnSync("git", ["config", "--get", key], { cwd: mirror, env, encoding: "utf8" }).stdout.trim();
    assert.equal(get("core.gitProxy"), "");
    assert.equal(get("core.sshCommand"), "/bin/false");
    assert.equal(get("credential.helper"), "");
    assert.equal(get("http.https://example.invalid/.extraHeader"), "");
    assert.equal(env.GIT_NO_LAZY_FETCH, "1");
    assert.equal(env.GIT_NO_REPLACE_OBJECTS, "1");
    assert.equal(env.GIT_ALLOW_PROTOCOL, "https:ssh");
    assert.equal(env.HOME, "/dev/null");
    assert.equal(env.SSH_AUTH_SOCK, undefined);
    assert.equal(existsSync(marker), false);
    assert.throws(() => upstreamFetchEnv(mirror, "https://user:secret@example.invalid/repo", undefined), (error: unknown) => error instanceof UpstreamFetchError && error.code === "https_auth_unsupported");
  } finally {
    if (saved === undefined) delete process.env.GIT_SSH_COMMAND; else process.env.GIT_SSH_COMMAND = saved;
    f.cleanup();
  }
});

test("upstream transfer refuses a new malformed commit and keeps both refs", () => {
  const f = fixture();
  try {
    const opts = { maxAgeMs: 0, timeoutMs: 5000 };
    assert.equal(refreshUpstreamMirror(f.origin.repo, f.mirrors, opts).status, "fetched");
    const tree = g(f.remote, ["rev-parse", "HEAD^{tree}"]);
    const result = spawnSync("git", ["hash-object", "--literally", "-t", "commit", "-w", "--stdin"], { cwd: f.remote, env: gitEnv(), encoding: "utf8", input: `tree ${tree}\nparent ${f.origin.sha}\n\nmissing author\n` });
    assert.equal(result.status, 0);
    g(f.remote, ["update-ref", "refs/heads/main", result.stdout.trim()]);
    const refreshed = refreshUpstreamMirror(f.origin.repo, f.mirrors, opts);
    assert.equal(refreshed.status, "failed");
    if (refreshed.status === "failed") assert.equal(refreshed.code, "invalid_objects", refreshed.error);
    assert.equal(g(mirrorDirFor(f.mirrors, f.remote), ["rev-parse", UPSTREAM_REF]), f.origin.sha);
    assert.equal(g(f.origin.repo, ["rev-parse", "origin/main"]), f.origin.sha);
  } finally { f.cleanup(); }
});

test("mirror transfer to origin validates new objects independently", () => {
  const f = fixture();
  try {
    const opts = { maxAgeMs: 3_600_000, timeoutMs: 5000 };
    assert.equal(refreshUpstreamMirror(f.origin.repo, f.mirrors, opts).status, "fetched");
    const mirror = mirrorDirFor(f.mirrors, f.remote);
    const tree = g(f.origin.repo, ["rev-parse", "HEAD^{tree}"]);
    const bad = spawnSync("git", ["hash-object", "--literally", "-t", "commit", "-w", "--stdin"], { cwd: mirror, env: gitEnv(), encoding: "utf8", input: `tree ${tree}\nparent ${f.origin.sha}\n\nmissing author\n` });
    assert.equal(bad.status, 0);
    g(mirror, ["update-ref", UPSTREAM_REF, bad.stdout.trim()]);
    const synced = syncOriginFromMirror(f.origin.repo, f.mirrors, opts);
    assert.match(synced.skipped ?? "", /invalid_objects/u);
    assert.equal(g(f.origin.repo, ["rev-parse", "origin/main"]), f.origin.sha);
  } finally { f.cleanup(); }
});

test("detected local mirror corruption is parked without a recovery fetch", () => {
  const f = fixture();
  try {
    assert.equal(refreshUpstreamMirror(f.origin.repo, f.mirrors, { maxAgeMs: 0, timeoutMs: 5000 }).status, "fetched");
    const mirror = mirrorDirFor(f.mirrors, f.remote);
    const headPath = join(mirror, "objects", f.origin.sha.slice(0, 2), f.origin.sha.slice(2));
    mkdirSync(join(mirror, "objects", f.origin.sha.slice(0, 2)), { recursive: true });
    writeFileSync(headPath, deflateSync(Buffer.from("commit 4\0oops")));
    const result = refreshUpstreamMirror(f.origin.repo, f.mirrors, { maxAgeMs: 0, timeoutMs: 5000 });
    assert.equal(result.status, "failed", JSON.stringify(result));
    if (result.status === "failed") assert.equal(result.code, "invalid_objects");
    assert.equal(readFileSync(headPath).equals(deflateSync(Buffer.from("commit 4\0oops"))), true);
    const again = refreshUpstreamMirror(f.origin.repo, f.mirrors, { maxAgeMs: 0, timeoutMs: 5000, now: () => Date.now() + 7 * 86400000 });
    assert.equal(again.status, "failed");
    if (again.status === "failed") assert.match(again.error, /parked/u);
  } finally { f.cleanup(); }
});

test("upstream SSH resolves explicit paths and refuses unsafe metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "upstream-ssh-"));
  try {
    const identity = join(root, "identity"), known = join(root, "known_hosts");
    writeFileSync(identity, "fixture", { mode: 0o600 });
    writeFileSync(known, "fixture", { mode: 0o600 });
    const policy = resolveUpstreamSshPolicy({ identityFiles: ["identity", "missing"], knownHostsFile: "known_hosts" }, root);
    assert.deepEqual(validatedUpstreamSsh(policy), { identityFiles: [identity], knownHostsFile: known });
    chmodSync(known, 0o644);
    assert.deepEqual(validatedUpstreamSsh(policy), { identityFiles: [identity], knownHostsFile: known });
    chmodSync(known, 0o664);
    assert.throws(() => validatedUpstreamSsh(policy), UpstreamFetchError);
    chmodSync(known, 0o600);
    chmodSync(identity, 0o644);
    assert.throws(() => validatedUpstreamSsh(policy), UpstreamFetchError);
    chmodSync(identity, 0o600);
    assert.throws(() => resolveUpstreamSshPolicy({ identityFiles: ["identity%h"], knownHostsFile: "known_hosts" }, root), UpstreamFetchError);
    rmSync(known); symlinkSync(identity, known);
    assert.throws(() => validatedUpstreamSsh(policy), UpstreamFetchError);
    assert.deepEqual(resolveUpstreamSshPolicy(undefined, root, root), { identityFiles: [join(root, ".ssh/id_ed25519"), join(root, ".ssh/id_rsa")], knownHostsFile: join(root, ".ssh/known_hosts") });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("upstream cache directories are private and symlink roots are refused", () => {
  const f = fixture();
  try {
    mkdirSync(f.mirrors, { mode: 0o755 });
    assert.equal(refreshUpstreamMirror(f.origin.repo, f.mirrors, { maxAgeMs: 0, timeoutMs: 5000 }).status, "fetched");
    const mirror = mirrorDirFor(f.mirrors, f.remote);
    assert.equal(statSync(f.mirrors).mode & 0o777, 0o700);
    assert.equal(statSync(mirror).mode & 0o777, 0o700);
    chmodSync(mirror, 0o755);
    assert.equal(refreshUpstreamMirror(f.origin.repo, f.mirrors, { maxAgeMs: 3_600_000, timeoutMs: 5000 }).status, "fresh");
    assert.equal(statSync(mirror).mode & 0o777, 0o700);
    const linked = join(f.root, "linked-root");
    symlinkSync(f.mirrors, linked);
    const result = refreshUpstreamMirror(f.origin.repo, linked, { maxAgeMs: 0, timeoutMs: 5000 });
    assert.equal(result.status, "failed");
    if (result.status === "failed") assert.equal(result.code, "transport_refused");
  } finally { f.cleanup(); }
});

test("upstream rejects rewrites, URL-named remotes and unsupported transport configuration", () => {
  const f = fixture();
  try {
    const url = "https://example.invalid/repo";
    for (const key of [`remote.${f.mirrors}.uploadpack`, `remote.${f.mirrors}.url`, "url.https://other.invalid/.insteadOf", "http.sslCAInfo", "http.curloptResolve", "remote.origin.proxy", "fetch.fsck.missingAuthor", "fsck.skipList"]) {
      g(f.origin.repo, ["config", key, "fixture"]);
      assert.throws(() => upstreamFetchEnv(f.origin.repo, url, undefined), (error: unknown) => error instanceof UpstreamFetchError && error.code === "transport_refused", key);
      g(f.origin.repo, ["config", "--unset-all", key]);
    }
  } finally { f.cleanup(); }
});

test("a URL-named origin remote cannot execute uploadpack or move tracking refs", () => {
  const f = fixture();
  try {
    const knownHostsFile = join(f.root, "known_hosts");
    writeFileSync(knownHostsFile, "fixture", { mode: 0o600 });
    const opts = { maxAgeMs: 3_600_000, timeoutMs: 5000, ssh: { identityFiles: [join(f.root, "identity")], knownHostsFile } };
    assert.equal(refreshUpstreamMirror(f.origin.repo, f.mirrors, opts).status, "fetched");
    const mirror = mirrorDirFor(f.mirrors, f.remote), marker = join(f.root, "uploadpack-executed");
    g(f.origin.repo, ["config", `remote.${mirror}.uploadpack`, `touch '${marker}'`]);
    g(f.origin.repo, ["config", `remote.${mirror}.url`, "/fixture/other-repository"]);
    const report = syncOriginFromMirror(f.origin.repo, f.mirrors, opts);
    assert.equal(report.refresh.status, "failed");
    if (report.refresh.status === "failed") assert.equal(report.refresh.code, "transport_refused");
    assert.equal(existsSync(marker), false);
    assert.equal(g(f.origin.repo, ["rev-parse", "origin/main"]), f.origin.sha);
    assert.equal(readUpstreamFailure(mirror)!.parked, true);
    g(f.origin.repo, ["config", "--unset-all", `remote.${mirror}.uploadpack`]);
    g(f.origin.repo, ["config", "--unset-all", `remote.${mirror}.url`]);
    const later = { ...opts, now: () => Date.now() + 7 * 86400000 };
    const held = refreshUpstreamMirror(f.origin.repo, f.mirrors, later);
    assert.equal(held.status, "failed");
    if (held.status === "failed") assert.match(held.error, /parked/u);
    writeFileSync(knownHostsFile, "fixture policy changed");
    assert.equal(refreshUpstreamMirror(f.origin.repo, f.mirrors, later).status, "fetched");
    assert.equal(readUpstreamFailure(mirror), null);
  } finally { f.cleanup(); }
});

test("unverified and multiple network URLs refuse without fetching or deleting the cache", () => {
  const f = fixture();
  try {
    assert.equal(refreshUpstreamMirror(f.origin.repo, f.mirrors, { maxAgeMs: 0, timeoutMs: 5000 }).status, "fetched");
    const mirror = mirrorDirFor(f.mirrors, f.remote);
    g(f.origin.repo, ["remote", "set-url", "origin", "https://github.com/other/repo.git"]);
    const refused = refreshNetworkMirror(f.origin.repo, f.mirrors, { maxAgeMs: 0, timeoutMs: 5000 });
    assert.equal(refused.status, "failed");
    if (refused.status === "failed") assert.equal(refused.code, "provenance_refused");
    g(f.origin.repo, ["config", "--add", "remote.origin.url", "git@github.com:other/repo.git"]);
    const ambiguous = refreshNetworkMirror(f.origin.repo, f.mirrors, { maxAgeMs: 0, timeoutMs: 5000 });
    assert.equal(ambiguous.status, "failed");
    assert.equal(g(mirror, ["rev-parse", UPSTREAM_REF]), f.origin.sha);
  } finally { f.cleanup(); }
});

test("all mirror callers share persistent transient backoff and success resets it", () => {
  const f = fixture();
  let clock = Date.now();
  const opts = { maxAgeMs: 0, timeoutMs: 5000, now: () => clock };
  try {
    assert.equal(refreshUpstreamMirror(f.origin.repo, f.mirrors, opts).status, "fetched");
    renameSync(f.remote, `${f.remote}.away`);
    assert.equal(refreshUpstreamMirror(f.origin.repo, f.mirrors, opts).status, "failed");
    const mirror = mirrorDirFor(f.mirrors, f.remote);
    const first = readUpstreamFailure(mirror)!;
    assert.equal(first.parked, false);
    assert.equal(first.failures, 1);
    clock = first.nextAttemptAt;
    assert.equal(refreshUpstreamMirror(f.origin.repo, f.mirrors, opts).status, "failed");
    const second = readUpstreamFailure(mirror)!;
    assert.equal(second.failures, 2);
    assert.ok(second.nextAttemptAt - clock > first.nextAttemptAt - (clock - 600000));
    renameSync(`${f.remote}.away`, f.remote);
    const manual = refreshUpstreamMirror(f.origin.repo, f.mirrors, { ...opts, maxAgeMs: 0 });
    assert.equal(manual.status, "failed");
    if (manual.status === "failed") assert.match(manual.error, /not retried yet/u);
    assert.equal(readUpstreamFailure(mirror)!.failures, 2);
    clock = second.nextAttemptAt;
    assert.equal(refreshUpstreamMirror(f.origin.repo, f.mirrors, opts).status, "fetched");
    assert.equal(readUpstreamFailure(mirror), null);
  } finally { f.cleanup(); }
});

test("SSH unknown host keys are refused by the actual transport", async (t) => {
  if (!existsSync("/usr/sbin/sshd") || !existsSync("/usr/bin/ssh-keygen")) return t.skip("local OpenSSH server unavailable");
  const f = fixture();
  let server: ReturnType<typeof spawn> | undefined;
  try {
    const key = join(f.root, "hostkey"), identity = join(f.root, "identity"), known = join(f.root, "known_hosts");
    for (const path of [key, identity]) assert.equal(spawnSync("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path]).status, 0);
    writeFileSync(known, "", { mode: 0o600 });
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const address = reservation.address();
    assert.ok(address && typeof address === "object");
    const port = address.port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const cfg = join(f.root, "sshd_config");
    writeFileSync(cfg, `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${key}\nPidFile ${f.root}/sshd.pid\nUsePAM no\nPasswordAuthentication no\nAuthorizedKeysFile none\nLogLevel ERROR\n`);
    server = spawn("/usr/sbin/sshd", ["-D", "-e", "-f", cfg], { stdio: ["ignore", "ignore", "pipe"] });
    let output = "";
    server.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (server.exitCode !== null) return t.skip(`local OpenSSH server cannot start: ${output.trim()}`);
    g(f.origin.repo, ["remote", "set-url", "origin", `ssh://fixture@127.0.0.1:${port}/fixture.git`]);
    const marker = join(f.root, "ssh-command-executed");
    g(f.origin.repo, ["config", "core.sshCommand", `touch '${marker}'; /bin/false`]);
    const url = `ssh://fixture@127.0.0.1:${port}/fixture.git`;
    const env = upstreamFetchEnv(f.origin.repo, url, { identityFiles: [identity], knownHostsFile: known });
    const result = spawnSync("git", ["fetch", "--upload-pack=git-upload-pack", url], { cwd: f.origin.repo, env, encoding: "utf8", timeout: 5000 });
    assert.notEqual(result.status, 0);
    assert.equal(upstreamFetchFailure(result.stderr), "host_key_refused", result.stderr);
    assert.equal(readFileSync(known, "utf8"), "");
    assert.equal(existsSync(marker), false);
  } finally {
    if (server && server.exitCode === null) {
      server.kill("SIGTERM");
      await new Promise<void>((resolve) => server!.once("exit", () => resolve()));
    }
    f.cleanup();
  }
});
