import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { runCellExec } from "../src/exec.ts";
import { cellPaths } from "../src/layout.ts";
import { defaultScratchPaths, defaultWritablePaths } from "../src/sandbox.ts";

test("default satellite sandbox composes with containment, isolates writes, redacts and captures", { skip: process.platform !== "linux" }, async () => {
  const root = realpathSync(mkdtempSync(join(fileURLToPath(new URL("../../..", import.meta.url)), ".secret-sandbox-")));
  const granted = [...defaultWritablePaths(), ...defaultScratchPaths("linux")].flatMap(path => { try { return [path, realpathSync(path)]; } catch { return [path]; } });
  assert.equal(granted.some(path => root === path || root.startsWith(path.endsWith(sep) ? path : path + sep)), false, `fixture root ${root} must sit outside /tmp and every sandbox writable grant`);
  const paths = cellPaths(root, "wrap", "repo", "c1");
  mkdirSync(paths.spaceDir, { recursive: true });
  const outside = join(root, "outside-must-not-write");
  try {
    const result = await runCellExec(paths, {
      sandbox: null, nodeKind: "satellite", secretEnv: { TOKEN: "synthetic-sandbox-only" },
      argv: [process.execPath, "-e", `const fs=require('node:fs');if(Number(fs.readFileSync('/proc/self/stat','utf8').split(' ')[0])!==process.pid)throw Error('proc_mismatch');try{fs.writeFileSync(${JSON.stringify(outside)},'bad')}catch{}fs.writeFileSync('inside','ok');process.stdout.write(process.env.TOKEN);process.stderr.write(process.env.TOKEN)`],
    });
    assert.equal(result.status, "ok", result.stderr);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "[REDACTED]");
    assert.equal(result.stderr, "[REDACTED]");
    assert.equal(readFileSync(join(paths.spaceDir, "inside"), "utf8"), "ok");
    assert.equal(statSync(outside, { throwIfNoEntry: false }), undefined, "a write beside the Cell must never reach the host filesystem");
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
