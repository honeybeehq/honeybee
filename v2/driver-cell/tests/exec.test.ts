import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CELL_EXEC_MAX_OUTPUT_BYTES } from "../../core/src/cellMove.ts";
import { pidAlive } from "../../driver-hsr/src/psutil.ts";
import {
  containedExecCwd,
  decodeCappedUtf8,
  OutputBudget,
  OutputCap,
  runCellExec,
  utf8DecodableEnd,
} from "../src/exec.ts";
import { cellPaths } from "../src/layout.ts";

function space(): { root: string; paths: ReturnType<typeof cellPaths>; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "hb-cell-exec-"));
  const paths = cellPaths(root, "wrap", "repo", "c1");
  mkdirSync(paths.spaceDir, { recursive: true });
  mkdirSync(paths.boxDir, { recursive: true });
  return { root, paths, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("exec.cwd: relative-only and realpath containment rejects a symlink out of the space", () => {
  const rig = space();
  try {
    const outside = join(rig.root, "sibling");
    mkdirSync(outside);
    symlinkSync(outside, join(rig.paths.spaceDir, "escape"));
    mkdirSync(join(rig.paths.spaceDir, "ok"));
    assert.equal(containedExecCwd(rig.paths.spaceDir), containedExecCwd(rig.paths.spaceDir, "."));
    assert.ok(containedExecCwd(rig.paths.spaceDir, "ok").startsWith(containedExecCwd(rig.paths.spaceDir)));
    assert.throws(() => containedExecCwd(rig.paths.spaceDir, "escape"), /escapes/);
    assert.throws(() => containedExecCwd(rig.paths.spaceDir, ".."), /escapes/);
    assert.throws(() => containedExecCwd(rig.paths.spaceDir, "/tmp"), /space-relative/);
  } finally {
    rig.cleanup();
  }
});

test("exec.cap: incomplete tail is dropped, complete multibyte suffix is kept", () => {
  const incomplete = Buffer.from([0x61, 0xf0, 0x9f]);
  assert.equal(utf8DecodableEnd(incomplete), 1);
  assert.equal(decodeCappedUtf8(incomplete), "a");
  assert.equal(decodeCappedUtf8(incomplete).includes("�"), false);

  const complete = Buffer.from("a😀", "utf8");
  assert.equal(utf8DecodableEnd(complete), complete.length);
  assert.equal(decodeCappedUtf8(complete), "a😀");

  const twoByte = Buffer.from([0x61, 0xc2, 0xa9]); // a©
  assert.equal(decodeCappedUtf8(twoByte), "a©");
  assert.equal(decodeCappedUtf8(Buffer.from([0x61, 0xc2])), "a");
});

test("exec.cap: split multibyte chunks reassemble; malformed replacement stays within 1MiB", () => {
  const cap = new OutputCap();
  const emoji = Buffer.from("😀");
  assert.equal(emoji.length, 4);
  cap.push(emoji.subarray(0, 2));
  cap.push(emoji.subarray(2));
  assert.equal(cap.text(), "😀");

  const over = new OutputCap();
  over.push(Buffer.from("aa", "utf8"));
  over.push(Buffer.from("😀".repeat(300_000), "utf8"));
  assert.equal(over.truncated, true);
  assert.ok(over.used <= CELL_EXEC_MAX_OUTPUT_BYTES);
  const text = over.text();
  assert.ok(Buffer.byteLength(text, "utf8") <= CELL_EXEC_MAX_OUTPUT_BYTES);
  assert.equal(text.slice(0, 2), "aa");

  const malformed = Buffer.alloc(CELL_EXEC_MAX_OUTPUT_BYTES, 0xff);
  const decodedMalformed = decodeCappedUtf8(malformed);
  assert.match(decodedMalformed, /�/);
  assert.ok(Buffer.byteLength(decodedMalformed, "utf8") <= CELL_EXEC_MAX_OUTPUT_BYTES);
  assert.ok(decodedMalformed.length < malformed.length, "replacement expansion must be trimmed to the cap");
});

test("exec.cap: stdout and stderr share one 1MiB budget", async () => {
  const budget = new OutputBudget();
  const stdout = new OutputCap(budget);
  const stderr = new OutputCap(budget);
  stdout.push(Buffer.alloc(700_000, 0x61));
  stderr.push(Buffer.alloc(700_000, 0x62));
  assert.equal(budget.truncated, true);
  assert.ok(stdout.used + stderr.used <= CELL_EXEC_MAX_OUTPUT_BYTES);
  assert.ok(
    Buffer.byteLength(stdout.text(), "utf8") + Buffer.byteLength(stderr.text(), "utf8") <= CELL_EXEC_MAX_OUTPUT_BYTES,
  );

  const rig = space();
  try {
    const script = join(rig.paths.spaceDir, "both-streams.mjs");
    writeFileSync(
      script,
      [
        'import { writeSync } from "node:fs";',
        'writeSync(1, Buffer.from("stdout-start\\n"));',
        'writeSync(2, Buffer.from("stderr-start\\n"));',
        "const chunk = Buffer.alloc(64 * 1024, 0x61);",
        "for (let i = 0; i < 12; i += 1) {",
        "  writeSync(1, chunk);",
        "  writeSync(2, chunk);",
        "}",
      ].join("\n"),
    );
    const outcome = await runCellExec(rig.paths, {
      argv: [process.execPath, script],
      timeoutMs: 5_000,
      sandbox: false,
      nodeKind: "workstation",
    });
    assert.equal(outcome.status, "ok");
    assert.match(outcome.stdout, /^stdout-start/);
    assert.match(outcome.stderr, /^stderr-start/);
    assert.ok(
      Buffer.byteLength(outcome.stdout, "utf8") + Buffer.byteLength(outcome.stderr, "utf8")
        <= CELL_EXEC_MAX_OUTPUT_BYTES,
    );
    assert.equal(outcome.truncated, true);
  } finally {
    rig.cleanup();
  }
});

test("exec.spawn: an onSpawned failure terminates and reaps the process", async () => {
  const rig = space();
  let spawnedPid = 0;
  try {
    const script = join(rig.paths.spaceDir, "wait.mjs");
    writeFileSync(script, "setInterval(() => {}, 1_000);\n");
    await assert.rejects(
      runCellExec(
        rig.paths,
        {
          argv: [process.execPath, script],
          timeoutMs: 5_000,
          sandbox: false,
          nodeKind: "workstation",
        },
        ({ pid }) => {
          spawnedPid = pid;
          throw new Error("persist spawned identity failed");
        },
      ),
      /persist spawned identity failed/,
    );
    assert.ok(spawnedPid > 0);
    assert.equal(pidAlive(spawnedPid), false);
  } finally {
    if (spawnedPid > 0 && pidAlive(spawnedPid)) {
      try {
        process.kill(-spawnedPid, "SIGKILL");
      } catch {
        process.kill(spawnedPid, "SIGKILL");
      }
    }
    rig.cleanup();
  }
});

test("exec.spawn: argv spawn errors reject with their cause", async () => {
  const rig = space();
  try {
    await assert.rejects(
      runCellExec(rig.paths, {
        argv: [join(rig.paths.spaceDir, "command-that-does-not-exist")],
        timeoutMs: 5_000,
        sandbox: false,
        nodeKind: "workstation",
      }),
      /ENOENT/,
    );
  } finally {
    rig.cleanup();
  }
});

test("exec.timeout: SIGTERM-ignoring child is SIGKILL-reaped before resolve", async () => {
  const rig = space();
  try {
    let spawnedPid: number | null = null;
    const script = join(rig.paths.spaceDir, "ignore-term.mjs");
    writeFileSync(
      script,
      `process.on("SIGTERM", () => {}); process.on("SIGHUP", () => {}); setInterval(() => {}, 1000);\n`,
    );
    const outcome = await runCellExec(
      rig.paths,
      {
        argv: [process.execPath, script],
        timeoutMs: 500,
        sandbox: false,
        nodeKind: "workstation",
      },
      (id) => {
        spawnedPid = id.pid;
        assert.ok(id.pidStartedAt > 0);
      },
    );
    assert.equal(outcome.status, "timeout");
    assert.ok(spawnedPid);
    assert.equal(pidAlive(spawnedPid), false);
    assert.equal(outcome.pid, spawnedPid);
  } finally {
    rig.cleanup();
  }
});
