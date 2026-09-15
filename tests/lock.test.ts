import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  fileLockMutationGuardPath,
  publishLockMutationGuardAtomically,
  readFileLockIdentity,
  removeFileLockIfOwner,
  withFileLock,
  withGuardedFileLockOwner,
} from "../src/lock.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-lock-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

for (const failure of ["none", "heartbeat", "rename"] as const) {
  test(`release drains a slow heartbeat and reports cleanup errors (failure: ${failure})`, async () => {
    // Isolate builtin instrumentation from this file and every other test.
    await promisify(execFile)(process.execPath, [
      ...(import.meta.url.endsWith(".ts") ? ["--import", "tsx"] : []),
      "--input-type=module", "--eval", `
      import assert from "node:assert/strict";
      import fs from "node:fs/promises";
      import { syncBuiltinESMExports } from "node:module";
      import { tmpdir } from "node:os";
      import { join } from "node:path";
      import { withFileLock, readFileLockIdentity, removeFileLockIfOwner } from ${JSON.stringify(new URL("../src/lock.js", import.meta.url).href)};
      const dir = await fs.mkdtemp(join(tmpdir(), "hb-heartbeat-release-"));
      const path = join(dir, "fixture.lock");
      let enterHeartbeat;
      const entered = new Promise(resolve => { enterHeartbeat = resolve; });
      const original = fs.utimes;
      const originalRename = fs.rename;
      const keepAlive = setInterval(() => {}, 1000);
      fs.utimes = async (target, ...args) => {
        if (target === path) {
          enterHeartbeat();
          // Exceed the real release guard deadline after entering the real heartbeat.
          await new Promise(resolve => setTimeout(resolve, 1500));
          if (${failure === "heartbeat"}) throw new Error("injected heartbeat failure");
        }
        return original(target, ...args);
      };
      fs.rename = async (source, ...args) => {
        if (source === path && ${failure === "rename"}) throw Object.assign(new Error("private path"), { code: "EACCES" });
        return originalRename(source, ...args);
      };
      syncBuiltinESMExports();
      try {
        const locked = withFileLock(path, () => entered, { staleMs: 150 });
        if (${failure === "rename"}) {
          await assert.rejects(locked, { name: "FileLockReleaseError", code: "FILE_LOCK_RELEASE_FAILED" });
          const identity = await readFileLockIdentity(path);
          assert.equal(identity.owner.pid, process.pid);
          fs.rename = originalRename;
          syncBuiltinESMExports();
          assert.equal(await removeFileLockIfOwner(path, identity), true);
        } else {
          await locked;
        }
        assert.equal(await readFileLockIdentity(path), null, "release left its live-owner lock behind");
        await withFileLock(path, async () => {}, { timeoutMs: 200, staleMs: 10 });
      } finally {
        fs.utimes = original;
        fs.rename = originalRename;
        syncBuiltinESMExports();
        clearInterval(keepAlive);
        await fs.rm(dir, { recursive: true, force: true });
      }
    `], { timeout: 60_000 });
  });
}

for (const callbackFails of [false, true]) {
  test(`release reports blocked cleanup and preserves callback failure (${callbackFails})`, async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "blocked-release.lock");
      const callbackError = new Error("callback failure");
      await assert.rejects(withFileLock(path, async () => {
        const identity = await readFileLockIdentity(path);
        assert.ok(identity);
        await writeFile(fileLockMutationGuardPath(path, identity), JSON.stringify({
          pid: process.pid, hostname: hostname(), token: "live-mutator", lockFingerprint: identity.fingerprint,
        }));
        if (callbackFails) throw callbackError;
      }), (error: unknown) => {
        if (callbackFails) {
          assert.ok(error instanceof AggregateError);
          assert.equal(error.errors[0], callbackError);
          assert.equal(error.errors[1].name, "FileLockReleaseError");
        } else {
          assert.ok(error instanceof Error);
          assert.equal(error.name, "FileLockReleaseError");
        }
        return true;
      });
      assert.equal((await readFileLockIdentity(path))?.owner.pid, process.pid);
    });
  });
}

test("callback failure releases normally and preserves the original thrown value", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "callback-error.lock");
    const error = new Error("callback failure");
    await assert.rejects(withFileLock(path, async () => { throw error; }), (caught) => caught === error);
    assert.equal(await readFileLockIdentity(path), null);
    assert.equal(await withFileLock(path, async () => 42), 42);
  });
});

const TEST_PROCESS_BIRTH = "test:current-process-birth";
const currentProcessProbe = async (pid: number) =>
  pid === process.pid
    ? { state: "alive" as const, birthId: TEST_PROCESS_BIRTH }
    : { state: "dead" as const };

async function spawnLiveOwner(): Promise<ChildProcess & { pid: number }> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1_000)"], { stdio: "ignore" });
  await once(child, "spawn");
  assert.ok(child.pid);
  return child as ChildProcess & { pid: number };
}

async function stopOwner(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await once(child, "exit");
}

test("withFileLock serializes critical sections", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "test.lock");
    let inside = 0;
    let maxInside = 0;
    const worker = () =>
      withFileLock(path, async () => {
        inside += 1;
        maxInside = Math.max(maxInside, inside);
        await sleep(20);
        inside -= 1;
      });
    await Promise.all([worker(), worker(), worker(), worker()]);
    assert.equal(maxInside, 1);
  });
});

test("proven-dead lock reclaim admits exactly one waiter at a time", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "stale.lock");
    // Plant a provably dead legacy owner; age alone is not reclaim authority.
    await writeFile(path, JSON.stringify({ pid: 999999, createdAt: "2026-01-01T00:00:00.000Z", token: "dead" }));
    const past = new Date(Date.now() - 10 * 60_000);
    await utimes(path, past, past);

    let inside = 0;
    let maxInside = 0;
    const worker = () =>
      withFileLock(
        path,
        async () => {
          inside += 1;
          maxInside = Math.max(maxInside, inside);
          await sleep(15);
          inside -= 1;
        },
        { staleMs: 1_000, pollMs: 5 },
      );
    await Promise.all([worker(), worker(), worker(), worker(), worker()]);
    assert.equal(maxInside, 1, "two waiters stole the same stale lock and overlapped");
  });
});

test("empty and truncated guard initialization never publishes an authoritative guard", async () => {
  await withTempDir(async (dir) => {
    const guardPath = join(dir, "generation.mutate-fingerprint");
    const complete = JSON.stringify({
      pid: process.pid,
      hostname: hostname(),
      createdAt: "2026-08-07T00:00:00.000Z",
      token: "complete",
      lockFingerprint: "fingerprint",
    });

    for (const [name, fragment] of [["empty", ""], ["truncated", '{"pid":']] as const) {
      await assert.rejects(
        publishLockMutationGuardAtomically(guardPath, complete, async (handle) => {
          if (fragment) await handle.writeFile(fragment);
          throw new Error(`simulated ${name} initializer crash`);
        }),
        new RegExp(`simulated ${name}`),
      );
      await assert.rejects(readFile(guardPath, "utf8"), (error: NodeJS.ErrnoException) => error.code === "ENOENT");

      // Crash debris is generation-nonauthoritative and cannot block a later
      // fully initialized hard-link commit.
      await writeFile(`${guardPath}.init-crashed-${name}`, fragment);
      assert.equal(await publishLockMutationGuardAtomically(guardPath, complete), true);
      assert.deepEqual(JSON.parse(await readFile(guardPath, "utf8")), JSON.parse(complete));
      await rm(guardPath, { force: true });
    }
  });
});

test("release leaves a lock owned by a different token in place", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "owned.lock");
    const foreign = JSON.stringify({ pid: 4242, createdAt: new Date().toISOString(), token: "someone-else" });
    await withFileLock(path, async () => {
      // Simulate a steal mid-critical-section: another process now owns the path.
      await writeFile(path, foreign);
    });
    // Our release must not have deleted the new holder's lock file.
    const raw = await readFile(path, "utf8");
    assert.equal(raw, foreign);
  });
});

test("a same-host live holder is never stolen even when its mtime is old", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "live-old-mtime.lock");
    const events: string[] = [];
    let releaseHolder!: () => void;
    let holderEntered!: () => void;
    const holderReady = new Promise<void>((resolve) => { holderEntered = resolve; });
    const hold = new Promise<void>((resolve) => { releaseHolder = resolve; });

    const holder = withFileLock(
      path,
      async () => {
        events.push("holder-start");
        holderEntered();
        await hold;
        events.push("holder-end");
      },
      { staleMs: 60_000, pollMs: 5, __testOnlyProbeProcess: currentProcessProbe },
    );
    await holderReady;

    const planted = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    assert.equal(planted.hostname, hostname());
    assert.equal(typeof planted.processBirthId, "string");
    const past = new Date(Date.now() - 10 * 60_000);
    await utimes(path, past, past);

    await assert.rejects(
      () => withFileLock(path, async () => { events.push("waiter-start"); }, {
        staleMs: 1,
        pollMs: 5,
        timeoutMs: 100,
        __testOnlyProbeProcess: currentProcessProbe,
      }),
      /Timed out waiting for lock/,
    );
    assert.deepEqual(events, ["holder-start"]);

    releaseHolder();
    await holder;
    await withFileLock(path, async () => { events.push("waiter-start"); }, { __testOnlyProbeProcess: currentProcessProbe });
    assert.deepEqual(events, ["holder-start", "holder-end", "waiter-start"]);
  });
});

test("heartbeat refresh and removal serialize under exact-generation revalidation", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "heartbeat-generation-barrier.lock");
    let holderEntered!: () => void;
    const holderReady = new Promise<void>((resolve) => { holderEntered = resolve; });
    let releaseHolder!: () => void;
    const hold = new Promise<void>((resolve) => { releaseHolder = resolve; });
    const holder = withFileLock(path, async () => {
      holderEntered();
      await hold;
    }, { staleMs: 60_000, __testOnlyProbeProcess: currentProcessProbe });
    await holderReady;

    const staleAt = new Date(Date.now() - 10_000);
    await utimes(path, staleAt, staleAt);
    const observed = await readFileLockIdentity(path);
    assert.ok(observed);

    let guardEntered!: () => void;
    const guardReady = new Promise<void>((resolve) => { guardEntered = resolve; });
    let refreshNow!: () => void;
    const mayRefresh = new Promise<void>((resolve) => { refreshNow = resolve; });
    const heartbeat = withGuardedFileLockOwner(path, observed!, async () => {
      guardEntered();
      await mayRefresh;
      const now = new Date();
      await utimes(path, now, now);
    });
    await guardReady;
    const removal = removeFileLockIfOwner(path, observed!, {
      suffix: "stale-race",
      guardTimeoutMs: 2_000,
      validate: (current) => Date.now() - current.mtimeMs > 1_000,
    });

    refreshNow();
    assert.deepEqual(await heartbeat, { matched: true, value: undefined });
    assert.equal(await removal, false);
    assert.equal((await readFileLockIdentity(path))?.fingerprint, observed?.fingerprint);

    releaseHolder();
    await holder;
  });
});

test("heartbeat recovers a generation guard abandoned by a proven-dead stealer", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "heartbeat-dead-mutator.lock");
    let holderEntered!: () => void;
    const holderReady = new Promise<void>((resolve) => { holderEntered = resolve; });
    let releaseHolder!: () => void;
    const hold = new Promise<void>((resolve) => { releaseHolder = resolve; });
    const holder = withFileLock(path, async () => {
      holderEntered();
      await hold;
    }, { staleMs: 150 });
    await holderReady;

    const identity = await readFileLockIdentity(path);
    assert.ok(identity);
    const guardPath = fileLockMutationGuardPath(path, identity!);
    await writeFile(guardPath, JSON.stringify({
      pid: 818_181,
      hostname: hostname(),
      createdAt: "2026-08-07T00:00:00.000Z",
      token: "dead-stealer",
      lockFingerprint: identity!.fingerprint,
    }));
    const staleAt = new Date(Date.now() - 10_000);
    await utimes(path, staleAt, staleAt);

    // Wait for the observed effect, not a fixed 120ms scheduling window.
    const deadline = performance.now() + 5_000;
    while ((await stat(path)).mtimeMs <= staleAt.getTime() && performance.now() < deadline) await sleep(20);
    const refreshed = await stat(path);
    assert.ok(refreshed.mtimeMs > staleAt.getTime(), "live holder heartbeat resumed after dead-guard recovery");

    releaseHolder();
    await holder;
    await assert.rejects(readFile(guardPath, "utf8"), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  });
});

test("heartbeat stops refreshing after release", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "released.lock");
    await withFileLock(path, async () => undefined, { staleMs: 90 });
    await sleep(150);
    await assert.rejects(stat(path), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  });
});

test("mixed-version legacy read-release barrier publishes no replacement before old release", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "legacy-release.lock");
    const legacy = JSON.stringify({
      pid: process.pid,
      createdAt: "2026-01-01T00:00:00.000Z",
      token: "legacy-owner",
    });
    await writeFile(path, legacy);
    const past = new Date(Date.now() - 10 * 60_000);
    await utimes(path, past, past);

    // Model the old binary's non-atomic release: it has read and authorized its
    // token, then pauses before the separate rm(path).
    const authorized = JSON.parse(await readFile(path, "utf8")) as { token: string };
    assert.equal(authorized.token, "legacy-owner");
    let observedWait!: () => void;
    const waiting = new Promise<void>((resolve) => { observedWait = resolve; });
    const modern = withFileLock(
      path,
      async () => assert.fail("replacement lock entered before the live legacy owner released"),
      { staleMs: 1, pollMs: 5, timeoutMs: 100, onWait: observedWait },
    );
    await waiting;
    await assert.rejects(modern, /Timed out waiting for lock/);
    assert.equal(await readFile(path, "utf8"), legacy, "waiter replaced the lock during the old release pause");

    // The already-authorized old rm happens before any modern generation can
    // be published, so it cannot delete that generation afterward.
    await rm(path);
    let entered = false;
    await withFileLock(path, async () => { entered = true; }, { staleMs: 1, pollMs: 5, timeoutMs: 500 });
    assert.equal(entered, true);
  });
});

test("a legacy waiter stays behind a live owner, then recovers once that PID is dead", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "legacy-owner-death.lock");
    const owner = await spawnLiveOwner();
    try {
      const legacy = JSON.stringify({ pid: owner.pid, createdAt: "2026-01-01T00:00:00.000Z", token: "legacy" });
      await writeFile(path, legacy);
      const past = new Date(Date.now() - 10 * 60_000);
      await utimes(path, past, past);

      let observedWait!: () => void;
      const waiting = new Promise<void>((resolve) => { observedWait = resolve; });
      let entered = false;
      const modern = withFileLock(
        path,
        async () => { entered = true; },
        { staleMs: 1, pollMs: 5, timeoutMs: 2_000, onWait: observedWait },
      );
      await waiting;
      await sleep(50);
      assert.equal(entered, false, "live legacy PID was mtime-stolen");
      assert.equal(await readFile(path, "utf8"), legacy);

      await stopOwner(owner);
      await modern;
      assert.equal(entered, true, "dead legacy PID was not reclaimed");
    } finally {
      await stopOwner(owner);
    }
  });
});

test("dead local owner is reclaimed immediately and callbacks expose sanitized metadata", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "dead-owner.lock");
    await writeFile(path, JSON.stringify({
      pid: 999_999,
      hostname: hostname(),
      createdAt: "2026-08-07T00:00:00.000Z",
      token: "must-not-leak",
      secret: "also-must-not-leak",
    }));
    let waited: unknown;
    let acquired: unknown;
    await withFileLock(path, async () => undefined, {
      timeoutMs: 1_000,
      pollMs: 5,
      onWait: (info) => { waited = info; },
      onAcquired: (info) => { acquired = info; },
    });
    assert.deepEqual((waited as { owner: unknown }).owner, {
      pid: 999_999,
      hostname: hostname(),
      createdAt: "2026-08-07T00:00:00.000Z",
    });
    assert.equal((acquired as { waited: boolean }).waited, true);
    assert.ok((acquired as { waitMs: number }).waitMs >= 0);
    assert.doesNotMatch(JSON.stringify(acquired), /must-not-leak|also-must-not-leak/);
  });
});

test("dead owner is reclaimed when it died while holding its generation guard", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "dead-owner-guarded.lock");
    const deadPid = 717_171;
    await writeFile(path, JSON.stringify({
      pid: deadPid,
      hostname: hostname(),
      createdAt: "2026-08-07T00:00:00.000Z",
      token: "dead-lock-token",
    }));
    const identity = await readFileLockIdentity(path);
    assert.ok(identity);
    const guardPath = fileLockMutationGuardPath(path, identity!);
    await writeFile(guardPath, JSON.stringify({
      pid: deadPid,
      hostname: hostname(),
      createdAt: "2026-08-07T00:00:01.000Z",
      token: "dead-guard-token",
      lockFingerprint: identity!.fingerprint,
    }));

    let acquired = false;
    await withFileLock(path, async () => { acquired = true; }, { timeoutMs: 1_000, pollMs: 5 });
    assert.equal(acquired, true);
    await assert.rejects(readFile(guardPath, "utf8"), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  });
});

test("a modern lock with a reused PID is reclaimed only on exact birth mismatch", { skip: process.platform === "win32" }, async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "reused-pid.lock");
    await writeFile(path, JSON.stringify({
      pid: process.pid,
      hostname: hostname(),
      processBirthId: `${process.platform}:definitely-not-this-process`,
      createdAt: "2026-01-01T00:00:00.000Z",
      token: "dead-incarnation",
      formatVersion: 2,
    }));
    const past = new Date(Date.now() - 10 * 60_000);
    await utimes(path, past, past);

    let entered = false;
    await withFileLock(path, async () => { entered = true; }, {
      pollMs: 5,
      staleMs: 1,
      timeoutMs: 1_000,
      __testOnlyProbeProcess: currentProcessProbe,
    });
    assert.equal(entered, true);
  });
});

test("partial legacy ownership fails closed while live and is reclaimed after proven death", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "partial-legacy.lock");
    const owner = await spawnLiveOwner();
    const partial = `{"pid":${owner.pid},"createdAt":"2026-01-01`;
    try {
      await writeFile(path, partial);
      await assert.rejects(
        () => withFileLock(path, async () => assert.fail("entered partial live legacy lock"), { pollMs: 5, timeoutMs: 100 }),
        /Timed out waiting for lock/,
      );
      assert.equal(await readFile(path, "utf8"), partial);

      await stopOwner(owner);
      let entered = false;
      await withFileLock(path, async () => { entered = true; }, { pollMs: 5, staleMs: 1, timeoutMs: 1_000 });
      assert.equal(entered, true, "partial lock with a provably dead PID was stranded");
    } finally {
      await stopOwner(owner);
    }
  });
});

test("malformed ownership without a provable PID remains locked", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "malformed.lock");
    const malformed = "{not-json";
    await writeFile(path, malformed);
    await assert.rejects(
      () => withFileLock(path, async () => assert.fail("entered malformed ambiguous lock"), { pollMs: 5, timeoutMs: 75 }),
      /Timed out waiting for lock/,
    );
    assert.equal(await readFile(path, "utf8"), malformed);
  });
});

test("a foreign-host lock remains fail-closed even when its PID is absent locally", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "remote.lock");
    const remote = JSON.stringify({
      pid: 999_999,
      hostname: `remote-${hostname()}`,
      processBirthId: "remote:birth",
      createdAt: "2026-01-01T00:00:00.000Z",
      token: "remote",
      formatVersion: 2,
    });
    await writeFile(path, remote);
    await assert.rejects(
      () => withFileLock(path, async () => assert.fail("entered remote lock"), { pollMs: 5, timeoutMs: 75 }),
      /Timed out waiting for lock/,
    );
    assert.equal(await readFile(path, "utf8"), remote);
  });
});
