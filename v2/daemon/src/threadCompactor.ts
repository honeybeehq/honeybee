/** Native Codex compaction owner. No ordinary user turn is used to request compaction. */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { open } from "node:fs/promises";
import type { ThreadOperationRow } from "../../core/src/threadOperation.ts";
import type { SpawnSpec } from "../../driver-hsr/src/driver.ts";
import { ThreadExecutionError, sourceBaseInstructions } from "./threadHistory.ts";

export interface ThreadCompactorInput {
  row: ThreadOperationRow;
  spec: SpawnSpec;
  signal: AbortSignal;
  recordWorker: (identity: { pid: number; startedAt: number }) => void;
  timeoutMs?: number;
}

export async function compactThread({ row, spec, signal, recordWorker, timeoutMs = 300_000 }: ThreadCompactorInput): Promise<void> {
  const baseInstructions = await sourceBaseInstructions(row);
  const instruction = `Compact this conversation for its successor. Preserve decisions, constraints, unfinished work, and the information needed to continue. Apply this handoff instruction when deciding what to preserve and emphasize:\n\n${row.instruction}`;
  if (signal.aborted) throw signal.reason;
  const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ["pipe", "pipe", "pipe"] });
  // Record the exact child before any request can load or modify a conversation.
  const startedAt = Date.now();
  const closed = once(child, "close").catch(() => undefined);
  const reader = createInterface({ input: child.stdout });
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let nextId = 1;
  let finished = false;
  let compactionItem = false;
  let compactRequested = false;
  let settle!: () => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<void>((resolve, reject) => { settle = resolve; rejectCompletion = reject; });
  // Attach immediately: startup can fail before the completion await is reached.
  void completion.catch(() => {});
  const fail = (error: Error) => {
    finished = true;
    rejectCompletion(error);
    for (const p of pending.values()) p.reject(error);
    pending.clear();
  };
  const write = (value: unknown) => child.stdin.write(JSON.stringify(value) + "\n");
  const request = (method: string, params: Record<string, unknown>) => new Promise<any>((resolve, reject) => {
    if (finished) { reject(new ThreadExecutionError("compaction_failed", "Compaction transport is closed")); return; }
    const id = nextId++;
    pending.set(id, { resolve, reject });
    write({ jsonrpc: "2.0", id, method, params });
  });
  child.stdin.on("error", error => fail(error));
  child.on("error", error => fail(error));
  child.on("exit", () => { if (!finished) fail(new ThreadExecutionError("compaction_failed", "Native compactor exited before its completion receipt")); });
  child.stderr.resume(); // Never retain an unbounded provider stderr stream.
  reader.on("line", line => {
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.method && msg.id !== undefined) {
      write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Compaction does not execute interactive requests" } });
      return;
    }
    if (typeof msg.id === "number" && pending.has(msg.id)) {
      const p = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.error) p.reject(new ThreadExecutionError(msg.error.code === -32601 ? "compaction_unsupported" : "compaction_failed", String(msg.error.message)));
      else p.resolve(msg.result);
      return;
    }
    if (!compactRequested || msg.params?.threadId !== row.successorProviderSessionId) return;
    if (msg.method === "error") fail(new ThreadExecutionError("compaction_failed", String(msg.params.error?.message ?? "Native compaction failed")));
    if (msg.method === "item/completed" && msg.params.item?.type === "contextCompaction") compactionItem = true;
    if (msg.method === "turn/completed") {
      if (compactionItem && msg.params.turn?.status === "completed" && !msg.params.turn?.error) {
        finished = true;
        settle();
      } else fail(new ThreadExecutionError("compaction_failed", "Native turn ended without a successful compaction checkpoint"));
    }
  });
  const abort = () => fail(new ThreadExecutionError("compaction_failed", "Compaction interrupted by daemon shutdown"));
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => fail(new ThreadExecutionError("compaction_failed", "Native compaction timed out")), timeoutMs);
  try {
    if (child.pid == null) throw new ThreadExecutionError("compaction_failed", "Native compactor did not spawn");
    recordWorker({ pid: child.pid, startedAt });
    await request("initialize", { clientInfo: { name: "honeybee-thread-compactor", version: "1" }, capabilities: { experimentalApi: true } });
    write({ jsonrpc: "2.0", method: "initialized" });
    const resumed = await request("thread/resume", {
      modelProvider: row.source.modelProvider,
      threadId: row.successorProviderSessionId, path: row.sessionPath, cwd: spec.cwd, excludeTurns: true,
      approvalPolicy: "never", sandbox: "read-only",
      // Both compaction implementations receive the instruction. Overrides are
      // scoped to this worker; normal successor startup uses the original header.
      baseInstructions: `${baseInstructions}\n\n${instruction}`,
      config: { compact_prompt: instruction },
    });
    if (resumed?.thread?.id !== row.successorProviderSessionId) throw new ThreadExecutionError("compaction_unsupported", "Provider changed the deterministic successor identity");
    compactRequested = true;
    await request("thread/compact/start", { threadId: row.successorProviderSessionId });
    await completion;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    reader.close();
    for (const p of pending.values()) p.reject(new Error("Compactor closed"));
    pending.clear();
    child.stdin.destroy();
    // Parenthood: the unreaped ChildProcess is exact, never a name-based signal.
    child.kill("SIGKILL");
    await closed;
  }
  // Provider success must also be durable before opening the mailbox gate.
  const fd = await open(row.sessionPath, "r+");
  try { await fd.sync(); } finally { await fd.close(); }
}
