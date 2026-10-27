import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { runCellExec } from "../src/exec.ts";
import { cellPaths } from "../src/layout.ts";

test("macOS refuses secret execution and private capture before spawning or reading credentials", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  let spawned = false;
  let credentialRead = false;
  let captured = false;
  const spawnProcess: typeof spawn = (..._args: unknown[]) => {
    spawned = true;
    throw new Error("must_not_spawn");
  };
  const secretEnv = Object.defineProperty({}, "TOKEN", {
    enumerable: true,
    get() { credentialRead = true; return "synthetic-mac-refusal"; },
  });
  const attempts: Promise<unknown>[] = [];
  try {
    Object.defineProperty(process, "platform", { ...descriptor, value: "darwin" });
    for (const mode of ["secret", "capture", "both"] as const) {
      attempts.push(assert.rejects(runCellExec(cellPaths("/missing", "wrap", "repo", "c1"), {
        argv: [process.execPath, "-e", "throw Error('must_not_run')"],
        sandbox: null, nodeKind: "satellite",
        ...(mode !== "capture" ? { secretEnv } : {}),
        ...(mode !== "secret" ? { outputCapture: {
          maxBytes: 16, expiresAt: Date.now() + 30000,
          receive: () => { captured = true; },
        } } : {}),
      }, undefined, spawnProcess), { message: "secret_execution_containment_unavailable" }));
    }
  } finally { Object.defineProperty(process, "platform", descriptor); }
  await Promise.all(attempts);
  assert.equal(spawned, false);
  assert.equal(credentialRead, false);
  assert.equal(captured, false);
});
