/**
 * F8 — `node.harnesses`: the node's per-harness executable facts must be
 * resolver truth (the SAME core rule the spawn path uses), never wishful:
 * a configured absolute path reports itself verbatim, a resolvable command
 * reports its resolved path + a cheap `--version`, and a missing CLI is an
 * honest absent row (null path/source/version) — not an error.
 * SAFETY: temp dirs only; the only real executable probed is process.execPath.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NodeHarnessesResult } from "../src/protocol.ts";
import { makeDaemonDir, startDaemon, type DaemonHandle } from "./helpers.ts";

test("rpc.node.harnesses: present/path/source/version are resolver truth; a missing CLI reports absent", async () => {
  const { dir, cleanup } = makeDaemonDir({
    agents: {
      // A bare name no PATH or fallback dir can plausibly hold.
      ghost: { command: "hb-test-no-such-cli-f8", adapter: "stub" },
      // A bare name that must resolve wherever these tests can run at all.
      bare: { command: "node", adapter: "stub" },
    },
  });
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    const { harnesses } = await client.request<NodeHarnessesResult>("node.harnesses");
    const byName = new Map(harnesses.map((h) => [h.harness, h]));

    const agy = byName.get("agy");
    assert.ok(agy, "the built-in agy harness must be reported");
    assert.equal(agy.command, "agy");
    if (agy.present) {
      assert.ok(agy.path?.endsWith("/agy"), `resolved agy path, got ${agy.path}`);
      assert.ok(agy.source === "PATH" || agy.source === "fallback");
    } else {
      assert.deepEqual(
        { path: agy.path, source: agy.source, version: agy.version },
        { path: null, source: null, version: null },
      );
    }

    // The helper's stub agent is configured with an absolute path: reported
    // verbatim as configured_path — never rewritten.
    const stub = byName.get("stub");
    assert.ok(stub, "the configured stub agent must be reported");
    assert.equal(stub.present, true);
    assert.equal(stub.source, "configured_path");
    assert.equal(stub.path, process.execPath);
    assert.match(stub.version ?? "", /^v\d+/, "node --version is the cheap probe");

    // A bare command resolves to the absolute path a spawn would exec.
    const bare = byName.get("bare");
    assert.ok(bare?.present, "'node' must resolve on a machine that runs this test");
    assert.ok(bare.path?.endsWith("/node"), `resolved path, got ${bare.path}`);
    assert.ok(bare.source === "PATH" || bare.source === "fallback");

    // Absent is absent: no path, no source, no version, no error.
    const ghost = byName.get("ghost");
    assert.ok(ghost);
    assert.equal(ghost.command, "hb-test-no-such-cli-f8");
    assert.deepEqual(
      { present: ghost.present, path: ghost.path, source: ghost.source, version: ghost.version },
      { present: false, path: null, source: null, version: null },
    );
    client.close();
  } finally {
    if (daemon) await daemon.stop();
    cleanup();
  }
});

test("rpc.node.harnesses: the version probe runs under the spec env and re-probes when a declared stamp changes", async () => {
  // A launcher that, like Muse's, stays put while the version file beside it
  // changes, and that reports whether the spec's no-update switch reached it.
  const install = mkdtempSync(join(tmpdir(), "hb-v2-stamp-"));
  const real = join(install, "real");
  mkdirSync(real);
  const launcher = join(real, "fake-cli");
  writeFileSync(
    launcher,
    '#!/bin/sh\nprintf \'fake %s no-update=%s\\n\' "$(cat "$(dirname "$(readlink -f "$0")")/.fake-version")" "${FAKE_NO_AUTO_UPDATE:-unset}"\n',
  );
  chmodSync(launcher, 0o755);
  writeFileSync(join(real, ".fake-version"), "1.0.0");
  // Reached through a symlink, as on satellites: stamps live beside the real file.
  const linked = join(install, "fake-cli");
  symlinkSync(launcher, linked);
  const { dir, cleanup } = makeDaemonDir({
    agents: {
      stamped: { command: linked, adapter: "stub", env: { FAKE_NO_AUTO_UPDATE: "1" }, versionStamps: [".fake-version"] },
      // Same launcher, no stamps: cached on (path, mtime) exactly as before.
      plain: { command: launcher, adapter: "stub" },
    },
  });
  let daemon: DaemonHandle | null = null;
  const versions = async (): Promise<Map<string, string | null>> => {
    const client = await daemon!.client();
    try {
      const { harnesses } = await client.request<NodeHarnessesResult>("node.harnesses");
      return new Map(harnesses.map((h) => [h.harness, h.version]));
    } finally {
      client.close();
    }
  };
  try {
    daemon = await startDaemon(dir);
    let v = await versions();
    assert.equal(v.get("stamped"), "fake 1.0.0 no-update=1", "the spec env reaches the probe");
    assert.equal(v.get("plain"), "fake 1.0.0 no-update=unset");

    // The update rewrites the stamp and leaves the launcher untouched.
    const stamp = join(real, ".fake-version");
    writeFileSync(stamp, "1.1.0");
    const later = new Date(Date.now() + 60_000);
    utimesSync(stamp, later, later);
    v = await versions();
    assert.equal(v.get("stamped"), "fake 1.1.0 no-update=1", "a changed stamp re-probes without a restart");
    assert.equal(v.get("plain"), "fake 1.0.0 no-update=unset", "a spec without stamps keeps its (path, mtime) cache");
  } finally {
    if (daemon) await daemon.stop();
    cleanup();
    rmSync(install, { recursive: true, force: true });
  }
});
