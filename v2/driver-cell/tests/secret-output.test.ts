import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretOutput, validateSecretEnv } from "../src/secretOutput.ts";
import { runCellExec } from "../src/exec.ts";
import { cellPaths } from "../src/layout.ts";

const material = ["synthetic-credential-short", "synthetic-credential-short-long", "é😀synthetic"];

test("raw redaction chooses longest matches across every chunk boundary and flushes binary tails", () => {
  const raw = Buffer.concat([Buffer.from([255, 0]), Buffer.from(material.join("|")), Buffer.from("tail")]);
  for (let split = 0; split <= raw.length; split++) {
    const captures: Buffer[] = [];
    const redactor = new SecretOutput(material, chunk => captures.push(Buffer.from(chunk)));
    redactor.push(raw.subarray(0, split));
    redactor.push(raw.subarray(split));
    redactor.finish();
    redactor.finish();
    assert.deepEqual(Buffer.concat(captures), Buffer.concat([Buffer.from([255, 0]), Buffer.from("[REDACTED]|[REDACTED]|[REDACTED]tail")]));
    redactor.dispose();
  }
  const captures: Buffer[] = [];
  const redactor = new SecretOutput(material, chunk => captures.push(Buffer.from(chunk)));
  for (const byte of raw) redactor.push(Buffer.from([byte]));
  redactor.finish();
  for (const value of material) assert.equal(Buffer.concat(captures).includes(Buffer.from(value)), false);
  redactor.dispose();
});

test("secret env rejects empty, oversized, nul and loader or parent environment overrides", () => {
  for (const env of [{}, { TOKEN: "" }, { TOKEN: "a\0b" }, { TOKEN: "x".repeat(16385) }, { NODE_OPTIONS: "x" }, { PATH: "x" }, { LD_PRELOAD: "x" }, { HIVE_CELL: "x" }]) assert.throws(() => validateSecretEnv(env), /secret_execution_invalid/);
});

test("child-only injection redacts stdout, stderr, EOF, nonzero, spawn failure and truncation before capture", async () => {
  const root = mkdtempSync(join(tmpdir(), "secret-exec-"));
  const paths = cellPaths(root, "wrap", "repo", "c1");
  mkdirSync(paths.spaceDir, { recursive: true });
  const spec = { sandbox: false, nodeKind: "satellite" as const, secretEnv: { SYNTHETIC_TOKEN: material[1]! } };
  const before = process.env.SYNTHETIC_TOKEN;
  try {
    const result = await runCellExec(paths, { ...spec, argv: [process.execPath, "-e", "const s=process.env.SYNTHETIC_TOKEN; process.stdout.write(s.slice(0,9)); setTimeout(()=>{process.stdout.write(s.slice(9));process.stderr.write(s);process.exitCode=7},10)"] });
    assert.equal(result.stdout, "[REDACTED]");
    assert.equal(result.stderr, "[REDACTED]");
    assert.equal(result.exitCode, 7);
    assert.equal(process.env.SYNTHETIC_TOKEN, before);
    await assert.rejects(runCellExec(paths, { ...spec, argv: ["/nonexistent/synthetic-executable"] }), /cell_execution_spawn_failed/);
    const truncated = await runCellExec(paths, { ...spec, argv: [process.execPath, "-e", "process.stdout.write('x'.repeat(1048570)+process.env.SYNTHETIC_TOKEN);process.stderr.write(process.env.SYNTHETIC_TOKEN)"] });
    assert.equal(truncated.truncated, true);
    assert.equal(JSON.stringify(truncated).includes(material[1]!), false);
    const flood = await runCellExec(paths, { ...spec, argv: [process.execPath, "-e", "const b=Buffer.alloc(1048576,120);for(let i=0;i<100;i++)process.stdout.write(b);process.stderr.write(process.env.SYNTHETIC_TOKEN)"] });
    assert.equal(flood.truncated, true);
    assert.equal(JSON.stringify(flood).includes(material[1]!), false);
    assert.ok(Buffer.byteLength(flood.stdout) + Buffer.byteLength(flood.stderr) <= 1048576);
    const controller = new AbortController();
    const pending = runCellExec(paths, { ...spec, signal: controller.signal, argv: [process.execPath, "-e", "process.stdout.write(process.env.SYNTHETIC_TOKEN);require('node:fs').writeFileSync('cancel-ready','1');setInterval(()=>{},1000)"] }, () => {
      const deadline = Date.now() + 5000;
      const ready = setInterval(() => {
        if (existsSync(join(paths.spaceDir, "cancel-ready")) || Date.now() >= deadline) {
          clearInterval(ready);
          controller.abort();
        }
      }, 20);
    });
    const cancelled = await pending;
    assert.equal(cancelled.status, "interrupted");
    assert.equal(cancelled.exitCode, null);
    assert.equal(cancelled.stdout, "[REDACTED]");
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("private stdout capture releases only bounded successful bytes and suppresses both ordinary streams", async () => {
  const root = mkdtempSync(join(tmpdir(), "private-capture-"));
  const paths = cellPaths(root, "wrap", "repo", "c1");
  mkdirSync(paths.spaceDir, { recursive: true });
  try {
    const outputCapture = { maxBytes: 8, expiresAt: Date.now() + 30000, receive: () => { throw new Error("synthetic-private-callback-detail"); } };
    await assert.rejects(runCellExec(paths, { sandbox: false, nodeKind: "satellite", outputCapture, argv: ["/nonexistent/synthetic-private-executable"] }), /^Error: cell_execution_spawn_failed$/);
    for (const mode of ["ok", "boundary", "nonzero", "overflow", "timeout", "expired", "cancel"] as const) {
      const released: Buffer[] = [];
      const controller = new AbortController();
      const result = await runCellExec(paths, {
        sandbox: false, nodeKind: "satellite", signal: controller.signal,
        timeoutMs: mode === "timeout" ? 1000 : 5000,
        outputCapture: { maxBytes: 8, expiresAt: Date.now() + (mode === "expired" ? -1 : 30000), receive: bytes => released.push(Buffer.from(bytes)) },
        argv: [process.execPath, "-e", `process.stdout.write(Buffer.from([0,255,1,2]));process.stderr.write('synthetic-private-stderr');${mode === "boundary" ? "process.stdout.write(Buffer.from([3,4,5,6]))" : mode === "overflow" ? "process.stdout.write('12345')" : mode === "nonzero" ? "process.exitCode=9" : mode === "timeout" || mode === "cancel" ? "setInterval(()=>{},1000)" : ""}`],
      }, () => { if (mode === "cancel") setTimeout(() => controller.abort(), 100); });
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
      if (mode === "timeout") { assert.equal(result.status, "timeout"); assert.equal(result.exitCode, null); }
      assert.equal(released.length, mode === "ok" || mode === "boundary" ? 1 : 0);
      if (released.length) assert.deepEqual(released[0], Buffer.from(mode === "boundary" ? [0,255,1,2,3,4,5,6] : [0,255,1,2]));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("supervisor preserves command exit codes and fragmented unicode configuration", async () => {
  const root = mkdtempSync(join(tmpdir(), "secret-config-"));
  const paths = cellPaths(root, "wrap", "repo", "c1");
  mkdirSync(paths.spaceDir, { recursive: true });
  try {
    for (const exitCode of [0, 124, 125, null]) {
      const result = await runCellExec(paths, {
        sandbox: false, nodeKind: "satellite",
        secretEnv: Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`TOKEN_${i}`, "é😀".repeat(2500)])),
        argv: [process.execPath, "-e", `process.stdout.write(process.env.TOKEN_3);${exitCode === null ? "process.kill(process.pid, 'SIGTERM')" : `process.exitCode=${exitCode}`}`],
      });
      assert.equal(result.exitCode, exitCode);
      assert.equal(result.status, exitCode === 0 ? "ok" : "nonzero");
      assert.equal(result.stdout, "[REDACTED]");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
