import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCellExec } from "../src/exec.ts";
import { cellPaths } from "../src/layout.ts";

test("default satellite sandbox composes with containment, isolates writes, redacts and captures", { skip: process.platform !== "linux" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "secret-sandbox-"));
  const paths = cellPaths(root, "wrap", "repo", "c1");
  mkdirSync(paths.spaceDir, { recursive: true });
  const outside = join(root, "outside-must-not-write");
  try {
    const result = await runCellExec(paths, {
      sandbox: null, nodeKind: "satellite", secretEnv: { TOKEN: "synthetic-sandbox-only" },
      argv: [process.execPath, "-e", `const fs=require('node:fs');if(Number(fs.readFileSync('/proc/self/stat','utf8').split(' ')[0])!==process.pid)throw Error('proc_mismatch');let denied=false;try{fs.writeFileSync(${JSON.stringify(outside)},'bad')}catch{denied=true}if(!denied)throw Error('write_not_confined');fs.writeFileSync('inside','ok');process.stdout.write(process.env.TOKEN);process.stderr.write(process.env.TOKEN)`],
    });
    assert.equal(result.status, "ok", result.stderr);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "[REDACTED]");
    assert.equal(result.stderr, "[REDACTED]");
    assert.equal(readFileSync(join(paths.spaceDir, "inside"), "utf8"), "ok");
    assert.equal(existsSync(outside), false);
    const bytes: Buffer[] = [];
    const capture = await runCellExec(paths, {
      sandbox: true, nodeKind: "satellite",
      argv: [process.execPath, "-e", "process.stdout.write(Buffer.from([0,255,3,4]));process.stderr.write('synthetic-private-stderr')"],
      outputCapture: { maxBytes: 8, expiresAt: Date.now() + 30000, receive: data => bytes.push(Buffer.from(data)) },
    });
    assert.equal(capture.status, "ok");
    assert.equal(capture.stdout, "");
    assert.equal(capture.stderr, "");
    assert.deepEqual(bytes, [Buffer.from([0,255,3,4])]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
