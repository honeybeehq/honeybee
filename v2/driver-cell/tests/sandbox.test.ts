/**
 * Spec 05 test tier 1 — sandbox matrix (A4): node-kind defaults + per-cell
 * override, Seatbelt profile generation + real `sandbox-exec` confinement
 * (darwin-local), bwrap argv construction everywhere + real bwrap
 * confinement (linux only — the metal-3 gate runs it; skipped elsewhere).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import {
  bwrapArgs,
  DEFAULT_SANDBOX_TMPFS_BYTES,
  defaultWritablePaths,
  mergeSandboxWritablePaths,
  sandboxWritableDirectory,
  sandboxDefaultFor,
  sandboxEnabled,
  seatbeltProfile,
  wrapWithSandbox,
} from "../src/sandbox.ts";
import {
  bwrapSupportsSize,
  describeSandboxTmpfs,
  formatBytes,
  fullTmpfs,
  isSandboxTmpFullDetail,
  sampleSandboxTmpfs,
  sandboxedPid,
  sandboxTmpfsCap,
  sandboxTmpFullDetail,
  SandboxTmpWatch,
} from "../src/sandboxTmp.ts";

const IS_DARWIN = platform() === "darwin";
const IS_LINUX = platform() === "linux";

test("sandbox.defaults: workstation OFF, satellite ON, cloud OFF (A4)", () => {
  assert.equal(sandboxDefaultFor("workstation"), false);
  assert.equal(sandboxDefaultFor("satellite"), true);
  assert.equal(sandboxDefaultFor("cloud"), false);
});

test("sandbox.override: per-cell override beats the node-kind default", () => {
  assert.equal(sandboxEnabled("workstation", null), false);
  assert.equal(sandboxEnabled("workstation", true), true);
  assert.equal(sandboxEnabled("satellite", undefined), true);
  assert.equal(sandboxEnabled("satellite", false), false);
  assert.equal(sandboxEnabled("cloud", true), true);
});

test("sandbox.profile: Seatbelt profile confines writes to cell + harness paths, allows the rest", () => {
  const profile = seatbeltProfile({
    cellDir: "/cells/bee-1",
    writablePaths: ["/home/u/.claude", "/home/u/.cache"],
  });
  assert.match(profile, /\(allow default\)/); // read + network open
  assert.match(profile, /\(deny file-write\*\)/);
  assert.match(profile, /\(subpath "\/cells\/bee-1"\)/);
  assert.match(profile, /\(subpath "\/home\/u\/\.claude"\)/);
  assert.match(profile, /\(subpath "\/private\/var\/folders"\)/);
  // Quotes/backslashes in paths are escaped, not profile-breaking.
  const tricky = seatbeltProfile({ cellDir: '/cells/we"ird', writablePaths: [] });
  assert.match(tricky, /\(subpath "\/cells\/we\\"ird"\)/);
});

test("sandbox.bwrap: argv is read-only root + rw cell/harness binds + net (pure, all platforms)", () => {
  const args = bwrapArgs(
    { cellDir: "/cells/bee-1", writablePaths: ["/home/u/.codex"] },
    "node",
    ["agent.mjs"],
  );
  const joined = args.join(" ");
  assert.match(joined, /--ro-bind \/ \//);
  assert.match(joined, /--bind \/cells\/bee-1 \/cells\/bee-1/);
  assert.match(joined, /--bind-try \/home\/u\/\.codex \/home\/u\/\.codex/);
  assert.match(joined, /--share-net/);
  assert.match(joined, /--die-with-parent/);
  assert.ok(joined.endsWith("-- node agent.mjs"));
});

test("sandbox.merge: a bee grant an existing baseline path already covers is not bound again", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hb-v2-merge-")));
  try {
    const cache = join(root, "cache");
    const inside = join(cache, "honeybee", "tmp", "bee-1");
    const outside = join(root, "elsewhere", "bee-1");
    mkdirSync(inside, { recursive: true });
    mkdirSync(outside, { recursive: true });
    assert.deepEqual(
      mergeSandboxWritablePaths([cache, join(root, "missing")], [{ path: inside }, { path: outside }]),
      [cache, join(root, "missing"), outside],
    );
    assert.deepEqual(
      mergeSandboxWritablePaths([join(root, "missing")], [{ path: join(root, "missing", "x") }]),
      [join(root, "missing"), join(root, "missing", "x")],
      "a baseline path that does not exist covers nothing",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sandbox.account-home: bwrap grants the exact bound home, never its parent or a sibling", () => {
  const root = mkdtempSync(join(tmpdir(), "hb-v2-account-home-"));
  try {
    const homesRoot = join(root, "homes");
    const accountHome = join(homesRoot, "codex-primary");
    const siblingHome = join(homesRoot, "codex-sibling");
    mkdirSync(accountHome, { recursive: true });
    mkdirSync(siblingHome);
    const baseline = defaultWritablePaths("/home/hive");
    const accountGrant = sandboxWritableDirectory(accountHome, { forbiddenDirectories: [homesRoot] });
    const writablePaths = mergeSandboxWritablePaths(
      baseline,
      [accountGrant],
    );
    const args = bwrapArgs(
      { cellDir: "/cells/bee-1", writablePaths, scratchPaths: [] },
      "codex",
      ["app-server"],
    );
    const bindTrySources = args.flatMap((arg, index) =>
      arg === "--bind-try" ? [args[index + 1]] : []
    );

    assert.equal(bindTrySources.filter((path) => path === accountGrant.path).length, 1);
    assert.equal(bindTrySources.includes(realpathSync(homesRoot)), false);
    assert.equal(bindTrySources.includes(realpathSync(siblingHome)), false);
    assert.deepEqual(
      mergeSandboxWritablePaths(baseline, []),
      baseline,
      "an unbound bee retains exactly the default writable homes and caches",
    );
    assert.deepEqual(
      mergeSandboxWritablePaths(["relative-legacy-cache"], []),
      ["relative-legacy-cache"],
      "the existing baseline override is not reinterpreted by the new authority seam",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sandbox.account-home validation rejects relative, missing, root, OS-home, and broad symlink targets", () => {
  const root = mkdtempSync(join(tmpdir(), "hb-v2-account-home-invalid-"));
  try {
    const homesRoot = join(root, "homes");
    const accountHome = join(homesRoot, "codex-primary");
    const rootAlias = join(root, "root-alias");
    const homeAlias = join(root, "home-alias");
    const homesAlias = join(root, "homes-alias");
    mkdirSync(accountHome, { recursive: true });
    symlinkSync("/", rootAlias, "dir");
    symlinkSync(homedir(), homeAlias, "dir");
    symlinkSync(homesRoot, homesAlias, "dir");

    assert.throws(() => sandboxWritableDirectory("relative/account"), /must be absolute/);
    assert.throws(() => sandboxWritableDirectory(join(root, "missing")), /existing directory/);
    assert.throws(() => sandboxWritableDirectory("/"), /too broad/);
    assert.throws(() => sandboxWritableDirectory(rootAlias), /too broad/);
    assert.throws(() => sandboxWritableDirectory(homedir()), /too broad/);
    assert.throws(() => sandboxWritableDirectory(homeAlias), /too broad/);
    assert.throws(
      () => sandboxWritableDirectory(homesAlias, { forbiddenDirectories: [homesRoot] }),
      /forbidden directory/,
    );
    assert.equal(
      sandboxWritableDirectory(accountHome, { forbiddenDirectories: [homesRoot] }).path,
      realpathSync(accountHome),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sandbox.wrap: platform dispatch (darwin sandbox-exec -f, linux bwrap, other throws)", () => {
  const policy = { cellDir: "/c", writablePaths: [] };
  const darwin = wrapWithSandbox(policy, "node", ["a.mjs"], "/box/p.sb", "darwin");
  assert.equal(darwin.command, "sandbox-exec");
  assert.deepEqual(darwin.args.slice(0, 2), ["-f", "/box/p.sb"]);
  assert.ok(darwin.profile != null && darwin.profile.includes("(version 1)"));
  const linux = wrapWithSandbox(policy, "node", ["a.mjs"], "/box/p.sb", "linux");
  assert.equal(linux.command, "bwrap");
  assert.equal(linux.profile, undefined);
  assert.throws(() => wrapWithSandbox(policy, "node", [], "/p", "win32"), /unsupported platform/);
});

test("sandbox.seatbelt-real: sandbox-exec confines writes to the cell (darwin)", { skip: !IS_DARWIN }, () => {
  const root = mkdtempSync(join(tmpdir(), "hb-v2-sb-"));
  try {
    const cellDir = join(root, "cell");
    const outsideDir = join(root, "outside");
    spawnSync("mkdir", ["-p", cellDir, outsideDir]);
    const profilePath = join(root, "profile.sb");
    // Pin scratch to /dev only: the test dirs live under the OS tmp area,
    // which the DEFAULT scratch policy would rightly allow — confinement is
    // proven against a policy whose only writable subtree is the cell.
    writeFileSync(profilePath, seatbeltProfile({ cellDir, writablePaths: [], scratchPaths: ["/dev"] }));

    // Inside the cell: allowed.
    const inside = spawnSync(
      "sandbox-exec",
      ["-f", profilePath, "/bin/sh", "-c", `echo ok > ${cellDir}/f.txt`],
      { encoding: "utf8" },
    );
    assert.equal(inside.status, 0, inside.stderr);
    assert.equal(readFileSync(join(cellDir, "f.txt"), "utf8"), "ok\n");

    // Outside the cell: denied.
    const outside = spawnSync(
      "sandbox-exec",
      ["-f", profilePath, "/bin/sh", "-c", `echo leak > ${outsideDir}/f.txt`],
      { encoding: "utf8" },
    );
    assert.notEqual(outside.status, 0, "write outside the cell must be denied");

    // Reads outside the cell stay allowed (fs visible, write-confined).
    const read = spawnSync("sandbox-exec", ["-f", profilePath, "/bin/cat", "/etc/hosts"], {
      encoding: "utf8",
    });
    assert.equal(read.status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sandbox.bwrap-real: bwrap confines writes to the cell (linux — metal-3 gate)", { skip: !IS_LINUX }, () => {
  const root = mkdtempSync(join(tmpdir(), "hb-v2-sb-"));
  try {
    const cellDir = join(root, "cell");
    const outsideDir = join(root, "outside");
    spawnSync("mkdir", ["-p", cellDir, outsideDir]);
    const policy = { cellDir, writablePaths: [], scratchPaths: [] };

    const inside = spawnSync(
      "bwrap",
      bwrapArgs(policy, "/bin/sh", ["-c", `echo ok > ${cellDir}/f.txt`]),
      { encoding: "utf8" },
    );
    assert.equal(inside.status, 0, inside.stderr);
    assert.equal(readFileSync(join(cellDir, "f.txt"), "utf8"), "ok\n");

    const outside = spawnSync(
      "bwrap",
      bwrapArgs(policy, "/bin/sh", ["-c", `echo leak > ${outsideDir}/f.txt`]),
      { encoding: "utf8" },
    );
    assert.notEqual(outside.status, 0, "write outside the cell must be denied");

    const read = spawnSync("bwrap", bwrapArgs(policy, "/bin/cat", ["/etc/hosts"]), { encoding: "utf8" });
    assert.equal(read.status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sandbox.bwrap-tmpfs: a tmpfs cap sizes /tmp and a private /dev/shm; no cap keeps the old argv", () => {
  const capped = bwrapArgs({ cellDir: "/cells/bee-1", writablePaths: [], tmpfsBytes: 4194304 }, "node", []);
  const joined = capped.join(" ");
  assert.match(joined, /--dev \/dev --size 4194304 --tmpfs \/dev\/shm /);
  assert.match(joined, /--size 4194304 --tmpfs \/tmp /);
  assert.ok(capped.indexOf("/dev/shm") > capped.indexOf("--dev"), "the shm tmpfs mounts over the --dev tree");
  for (const uncapped of [
    bwrapArgs({ cellDir: "/cells/bee-1", writablePaths: [] }, "node", []),
    bwrapArgs({ cellDir: "/cells/bee-1", writablePaths: [], tmpfsBytes: null }, "node", []),
  ]) {
    assert.equal(uncapped.includes("--size"), false);
    assert.equal(uncapped.includes("/dev/shm"), false);
  }
});

test("sandbox.tmpfs-cap: config, darwin and an old bwrap decide the effective cap", () => {
  assert.deepEqual(sandboxTmpfsCap(DEFAULT_SANDBOX_TMPFS_BYTES, "linux", () => true), { kind: "capped", bytes: 1073741824 });
  assert.deepEqual(sandboxTmpfsCap(null, "linux", () => true), { kind: "uncapped", reason: "config_null" });
  assert.deepEqual(sandboxTmpfsCap(4194304, "linux", () => false), { kind: "uncapped", reason: "bwrap_no_size" });
  assert.deepEqual(sandboxTmpfsCap(4194304, "darwin", () => true), { kind: "uncapped", reason: "seatbelt" });
  assert.equal(describeSandboxTmpfs("b1", 2, { kind: "capped", bytes: 1073741824 }), "sandbox.tmpfs bee=b1 gen=2 cap=1073741824 (1 GiB) paths=/tmp,/dev/shm");
  assert.equal(describeSandboxTmpfs("b1", 2, { kind: "uncapped", reason: "seatbelt" }), "sandbox.tmpfs bee=b1 gen=2 cap=none reason=seatbelt");
  assert.equal(formatBytes(4194304), "4 MiB");
  assert.equal(formatBytes(1500000), "1.4 MiB");
});

test("sandbox.tmp-full: a nearly full tmpfs yields the typed detail; space left yields nothing", () => {
  const cap = 4194304;
  assert.equal(fullTmpfs([{ path: "/tmp", sizeBytes: cap, freeBytes: cap / 2 }]), null);
  const full = fullTmpfs([{ path: "/tmp", sizeBytes: cap, freeBytes: cap / 2 }, { path: "/dev/shm", sizeBytes: cap, freeBytes: 4096 }]);
  assert.equal(full?.path, "/dev/shm");
  const detail = sandboxTmpFullDetail(full!);
  assert.ok(isSandboxTmpFullDetail(detail));
  assert.match(detail, /^sandbox tmp full: \/dev\/shm in this bee's sandbox is at its 4 MiB cap \(bees\.sandboxTmpBytes\)/);
  assert.equal(isSandboxTmpFullDetail("rate limit"), false);
});

test("sandbox.tmp-pid: the sandboxed process is the host's grandchild in another mount namespace", () => {
  const root = mkdtempSync(join(tmpdir(), "hb-v2-proc-"));
  try {
    const proc = (pid: number, ns: string, children: number[]): void => {
      mkdirSync(join(root, String(pid), "ns"), { recursive: true });
      mkdirSync(join(root, String(pid), "task", String(pid)), { recursive: true });
      symlinkSync(ns, join(root, String(pid), "ns", "mnt"));
      writeFileSync(join(root, String(pid), "task", String(pid), "children"), children.map((c) => `${c} `).join(""));
    };
    proc(10, "mnt:[1]", [11]);
    proc(11, "mnt:[1]", [12, 13]);
    proc(12, "mnt:[1]", []);
    proc(13, "mnt:[2]", []);
    assert.equal(sandboxedPid(10, root), 13);
    assert.equal(sandboxedPid(11, root), null, "a direct child in another namespace is not the shape bwrap leaves");
    assert.equal(sandboxedPid(99, root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sandbox.tmpfs-real: a capped bwrap /tmp and /dev/shm refuse writes past the cap, visible from the host", { skip: !IS_LINUX || !bwrapSupportsSize() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "hb-v2-sb-cap-"));
  try {
    const cellDir = join(root, "cell");
    mkdirSync(cellDir);
    const policy = { cellDir, writablePaths: [], scratchPaths: [], tmpfsBytes: 2 * 1024 * 1024 };
    for (const dir of ["/tmp", "/dev/shm"]) {
      const res = spawnSync("bwrap", bwrapArgs(policy, "/bin/sh", ["-c", `dd if=/dev/zero of=${dir}/fill bs=1024 count=4096 2>&1; df -k ${dir} | tail -1`]), { encoding: "utf8" });
      assert.match(res.stdout, /No space left on device/, `${dir}: ${res.stdout}${res.stderr}`);
      assert.match(res.stdout, /\s2048\s/, `${dir} is a 2 MiB tmpfs: ${res.stdout}`);
    }
    const sandbox = spawn("bwrap", bwrapArgs(policy, "/bin/sh", ["-c", "dd if=/dev/zero of=/tmp/fill bs=1024 count=4096 2>/dev/null; sleep 10"]), { stdio: "ignore" });
    try {
      let usage: ReturnType<typeof sampleSandboxTmpfs> = [];
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const pid = sandboxedPid(process.pid);
        usage = pid === null ? [] : sampleSandboxTmpfs(pid);
        if (fullTmpfs(usage)) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(fullTmpfs(usage)?.path, "/tmp", JSON.stringify(usage));
      assert.equal(usage.find((u) => u.path === "/tmp")?.sizeBytes, 2 * 1024 * 1024);
    } finally {
      sandbox.kill("SIGKILL");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("sandbox.tmp-watch: tracked bees only, set once when full, re-set after a turn clear, clear with hysteresis or on exit", () => {
  let now = 0;
  const cap = 4194304;
  const usage = new Map<number, number>();
  const logs: string[] = [];
  const watch = new SandboxTmpWatch({
    intervalMs: 5000,
    now: () => now,
    sample: (pid) => usage.has(pid) ? [{ path: "/tmp", sizeBytes: cap, freeBytes: usage.get(pid)! }] : null,
    log: (op) => logs.push(op),
  });
  const a = { beeId: "a", generation: 1, pid: 100 };
  const b = { beeId: "b", generation: 3, pid: 200 };
  const c = { beeId: "c", generation: 1, pid: 300 };
  const actions = (evs: ReturnType<SandboxTmpWatch["observe"]>) => evs.map((e) => [e.beeId, e.action]);
  watch.track("a", 1);
  watch.track("b", 3);
  usage.set(100, 0);
  usage.set(200, cap);
  usage.set(300, 0);
  const first = watch.observe([a, b, c], []);
  assert.deepEqual(actions(first), [["a", "set"], ["b", "clear"]], "an untracked bee is never read; an unknown roomy bee clears any stale flag once");
  assert.ok(first.every((e) => e.owner === "sandbox_tmp"));
  assert.match(first[0]!.detail, /^sandbox tmp full: \/tmp .* 4 MiB cap/);
  assert.match(logs[0]!, /^sandbox\.tmp_full bee=a gen=1 path=\/tmp cap=4194304 \(4 MiB\) freeBytes=0$/);
  now = 1000;
  assert.deepEqual(watch.observe([a, b], []), [], "between samples nothing is read");
  assert.deepEqual(actions(watch.observe([a, b], ["a"])), [["a", "set"]], "a turn's clear is answered at once while still full");
  assert.deepEqual(watch.observe([a, b], ["b"]), [], "a clear for a bee not marked full needs no sample");
  now = 6000;
  assert.deepEqual(watch.observe([a, b], []), [], "still full: no repeat; still roomy: no repeat");
  usage.set(100, cap / 16);
  now = 11000;
  assert.deepEqual(watch.observe([a, b], []), [], "between the thresholds the flag holds");
  usage.set(100, cap / 4);
  now = 16000;
  assert.deepEqual(actions(watch.observe([a, b], [])), [["a", "clear"]]);
  usage.set(200, 0);
  now = 21000;
  assert.deepEqual(watch.observe([a, b], []).map((e) => [e.beeId, e.action, e.generation]), [["b", "set", 3]]);
  watch.exited("b", 3);
  watch.exited("c", 1);
  now = 22000;
  assert.deepEqual(watch.observe([a], []).map((e) => [e.beeId, e.action, e.generation]), [["b", "clear", 3]], "exit clears once, at the next drain, for tracked bees only");
  usage.delete(100);
  now = 30000;
  assert.deepEqual(watch.observe([a], []), [], "an unsandboxed runtime is never judged");
});

test("sandbox.tmp-watch: an exit is fenced by generation, so a respawn behind a dying runtime stays watched", () => {
  const watch = new SandboxTmpWatch({ intervalMs: 0, now: () => 0, sample: () => [{ path: "/tmp", sizeBytes: 4194304, freeBytes: 0 }] });
  watch.track("b", 1);
  watch.track("b", 2);
  watch.exited("b", 1);
  assert.deepEqual(watch.observe([{ beeId: "b", generation: 2, pid: 1 }], []).map((e) => [e.action, e.generation]), [["set", 2]]);
  watch.track("c", null);
  watch.exited("c", 7);
  assert.deepEqual(watch.observe([{ beeId: "c", generation: 8, pid: 2 }], []).map((e) => [e.action, e.generation]), [["clear", 7]], "an adopted runtime, tracked without a generation, still clears on its exit");
  watch.track("d", 4);
  watch.track("d", null);
  watch.exited("d", 3);
  assert.deepEqual(watch.observe([{ beeId: "d", generation: 4, pid: 3 }], []).map((e) => [e.action, e.generation]), [["set", 4]], "an adopt-time resolve never loosens a known generation");
});

test("sandbox.bwrap-real: a harness launched from under /tmp still runs, read-only, while the rest of /tmp stays private (linux)", { skip: !IS_LINUX }, async () => {
  const checkout = mkdtempSync("/tmp/hb-v2-sb-checkout-");
  const neighbour = mkdtempSync("/tmp/hb-v2-sb-neighbour-");
  const socketDir = mkdtempSync("/tmp/hb-v2-sb-socket-");
  const socketPath = join(socketDir, "host.sock");
  const server = createServer();
  await new Promise<void>((listening) => server.listen(socketPath, listening));
  const root = mkdtempSync(join(tmpdir(), "hb-v2-sb-"));
  try {
    const cellDir = join(root, "cell");
    mkdirSync(cellDir);
    mkdirSync(join(checkout, "fixtures"));
    writeFileSync(join(checkout, "fixtures", "lib.mjs"), "export const answer = 42;\n");
    writeFileSync(join(checkout, "fixtures", "agent.mjs"), [
      "import { writeFileSync, existsSync } from 'node:fs';",
      "import { answer } from './lib.mjs';",
      "let readOnly = false;",
      "try { writeFileSync(new URL('./leak', import.meta.url), 'x'); } catch { readOnly = true; }",
      `console.log(JSON.stringify({ answer, readOnly, neighbour: existsSync(${JSON.stringify(neighbour)}), socket: existsSync(${JSON.stringify(socketPath)}) }));`,
    ].join("\n"));
    const linked = join(checkout, "linked-agent.mjs");
    symlinkSync(join(checkout, "fixtures", "agent.mjs"), linked);
    const policy = { cellDir, writablePaths: [], scratchPaths: [] };

    for (const script of [join(checkout, "fixtures", "agent.mjs"), linked]) {
      const run = spawnSync("bwrap", bwrapArgs(policy, process.execPath, [script, neighbour, socketPath]), { encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr);
      assert.deepEqual(JSON.parse(run.stdout), { answer: 42, readOnly: true, neighbour: false, socket: false });
    }
  } finally {
    await new Promise((closed) => server.close(closed));
    rmSync(checkout, { recursive: true, force: true });
    rmSync(neighbour, { recursive: true, force: true });
    rmSync(socketDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
