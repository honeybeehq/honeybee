import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretOutput } from "../src/secretOutput.ts";
import { runCellExec } from "../src/exec.ts";
import { cellPaths } from "../src/layout.ts";

const tokens = ["SYNTHETIC-TAIL-CREDENTIAL-79426", "é😀SYNTHETIC-TAIL-79426"];
for (const normal of [true, false]) {
  test(`held secret prefixes are ${normal ? "masked on normal EOF" : "discarded on abnormal end"} at every byte boundary`, () => {
    let checks = 0;
    for (const token of tokens) {
      const bytes = Buffer.from(token);
      for (let length = 1; length < bytes.length; length++) {
        const prefix = bytes.subarray(0, length);
        for (let split = 0; split <= prefix.length; split++) {
          const output: Buffer[] = [];
          const redactor = new SecretOutput(tokens, chunk => output.push(Buffer.from(chunk)));
          redactor.push(Buffer.from("before|"));
          redactor.push(prefix.subarray(0, split));
          redactor.push(prefix.subarray(split));
          redactor.finish(normal);
          redactor.finish(normal);
          const actual = Buffer.concat(output);
          if (normal) assert.equal(actual.toString(), "before|[REDACTED]");
          else assert.equal(Buffer.from("before|").subarray(0, actual.length).equals(actual), true);
          redactor.dispose();
          checks++;
        }
      }
    }
    console.log(JSON.stringify({ normal, byteBoundaryChecks: checks, leakedPrefixMatches: 0 }));
  });
}

for (const sandbox of process.platform === "linux" ? [false, null] : [false]) {
  for (const mode of ["normal", "cancel", "timeout", "exit7", "signal", "supervisor-kill"] as const) {
    test(`real runner mid-value ${mode} masks or drops both stream tails (sandbox=${sandbox})`, async () => {
      const root = mkdtempSync(join(tmpdir(), "secret-tail-"));
      const paths = cellPaths(root, "wrap", "repo", "c1");
      mkdirSync(paths.spaceDir, { recursive: true });
      const controller = new AbortController();
      let timer: ReturnType<typeof setInterval> | undefined;
      const prefix = tokens[0]!.slice(0, 20);
      try {
        const result = await runCellExec(paths, {
          sandbox, nodeKind: "satellite", signal: controller.signal,
          secretEnv: { TOKEN: tokens[0]! }, timeoutMs: mode === "timeout" ? 1000 : 10000,
          argv: [process.execPath, "-e", `const fs=require('node:fs');const part=Buffer.from(process.env.TOKEN).subarray(0,20);fs.writeSync(1,part);fs.writeSync(2,part);fs.writeFileSync('ready','1');${mode === "normal" ? "" : mode === "exit7" ? "process.exitCode=7" : mode === "signal" ? "process.kill(process.pid,'SIGKILL')" : "setInterval(()=>{},1000)"}`],
        }, identity => {
          if (mode !== "cancel" && mode !== "supervisor-kill") return;
          timer = setInterval(() => {
            if (!existsSync(join(paths.spaceDir, "ready"))) return;
            clearInterval(timer);
            if (mode === "cancel") controller.abort();
            else process.kill(identity.pid, "SIGKILL");
          }, 10);
        });
        assert.equal(result.stdout, mode === "normal" ? "[REDACTED]" : "");
        assert.equal(result.stderr, mode === "normal" ? "[REDACTED]" : "");
        assert.equal(result.stdout.includes(prefix) || result.stderr.includes(prefix), false);
        assert.equal(result.status, mode === "normal" ? "ok" : mode === "cancel" ? "interrupted" : mode === "timeout" ? "timeout" : "nonzero");
        console.log(JSON.stringify({ sandbox, mode, status: result.status, stdoutBytes: Buffer.byteLength(result.stdout), stderrBytes: Buffer.byteLength(result.stderr), leakedPrefixMatches: 0 }));
      } finally {
        if (timer) clearInterval(timer);
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
