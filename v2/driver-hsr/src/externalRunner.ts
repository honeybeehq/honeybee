import { openExternalFile } from "./externalFiles.ts";
import { createInterface } from "node:readline";
import { writeSync, closeSync, fstatSync, readSync } from "node:fs";
import { join } from "node:path";
import { dispatchValue, registrationValue, record, validateReceipt, type ExternalBinding } from "../../core/src/externalExec.ts";
import { bridgeOperation } from "./externalBridge.ts";

export async function externalRunner(): Promise<void> {
  const lines = createInterface({ input: process.stdin });
  let binding: ExternalBinding | null = null;
  let stopping: Promise<unknown> | null = null;
  let stopRequested = false;
  let startCompleted = false;
  let terminal = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const offsets = new Map<string, number>();
  const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  let captureFailed = false;
  const raw = () => {
    if (!binding) return;
    for (const [source, target] of [["run-output.log", "stdout.raw"], ["run-error.log", "stderr.raw"]]) {
      let fd: number | null = null;
      try {
        fd = openExternalFile(join(binding.dispatch.stateDir, "attempts", binding.dispatch.attemptId), source!, false);
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.uid !== process.getuid!()) throw new Error("external_exec_invalid_raw_source");
        const position = offsets.get(source!) ?? 0;
        if (stat.size < position) throw new Error("external_exec_raw_truncated");
        const bytes = Buffer.alloc(Math.min(stat.size - position, 1024 * 1024));
        const size = readSync(fd, bytes, 0, bytes.length, position);
        if (size) {
          const output = openExternalFile(outputDirectory!, target!, true);
          try { let written = 0; while (written < size) written += writeSync(output, bytes.subarray(written, size)); } finally { closeSync(output); }
        }
        offsets.set(source!, position + size);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      finally { if (fd !== null) closeSync(fd); }
    }
  };
  let outputDirectory: string | null = null;
  const invoke = async (operation: "start" | "wait" | "stop" | "reconcile") => {
    const current = binding!;
    return await bridgeOperation(current, operation, event => {
      emit({ schema: "honeybee.external.observation.v1", event });
      if (event.type === "terminal") { validateReceipt(event.data, current); terminal = true; }
    }, bytes => {
      const output = openExternalFile(outputDirectory!, "bridge-stderr.raw", true);
      try { let written = 0; while (written < bytes.length) written += writeSync(output, bytes.subarray(written)); } finally { closeSync(output); }
    });
  };
  const run = async (value: unknown) => {
    const cfg = record(value), b = record(cfg.binding);
    if (cfg.operation !== "start" && cfg.operation !== "reconcile" || typeof cfg.outputDirectory !== "string" || !cfg.outputDirectory.startsWith("/")) throw new Error("external_exec_invalid_runner_config");
    binding = { beeId: String(b.beeId), bridgeId: String(b.bridgeId), workspace: String(b.workspace), admissionDigest: String(b.admissionDigest), registration: registrationValue(b.registration), dispatch: dispatchValue(b.dispatch) };
    outputDirectory = cfg.outputDirectory;
    timer = setInterval(() => { try { raw(); } catch { captureFailed = true; emit({ schema: "honeybee.external.error.v1", code: "raw_capture_failed" }); } }, 250);
    if (stopRequested) throw new Error("external_exec_stopped_before_dispatch");
    const first = await invoke(cfg.operation);
    if (first.code !== 0) throw new Error("external_exec_reconcile_required");
    startCompleted = true;
    if (stopRequested && !stopping) stopping = invoke("stop").catch(() => { emit({ schema: "honeybee.external.error.v1", code: "stop_reconcile_required" }); });
    if (!terminal) {
      const result = await invoke("wait");
      if (result.code !== 0 || !result.receipt) throw new Error("external_exec_transport_or_receipt_lost");
    }
    if (stopping) await stopping;
    let previous = "";
    while (previous !== JSON.stringify([...offsets])) { previous = JSON.stringify([...offsets]); raw(); }
    if (captureFailed) throw new Error("external_exec_raw_capture_failed");
  };
  await new Promise<void>(resolve => {
    let begun = false;
    lines.on("line", line => {
      if (!begun) {
        begun = true;
        void Promise.resolve().then(() => run(JSON.parse(line))).then(() => { process.exitCode = 0; }, () => {
          emit({ schema: "honeybee.external.error.v1", code: "reconcile_required" }); process.exitCode = 75;
        }).finally(() => { if (timer) clearInterval(timer); lines.close(); process.stdin.destroy(); resolve(); });
      } else {
        try {
          const control = record(JSON.parse(line));
          if (Object.keys(control).length === 1 && control.operation === "stop") {
            stopRequested = true;
            if (!stopping && binding && startCompleted) stopping = invoke("stop").catch(() => { emit({ schema: "honeybee.external.error.v1", code: "stop_reconcile_required" }); });
          }
        } catch { emit({ schema: "honeybee.external.error.v1", code: "invalid_control" }); }
      }
    });
    lines.on("close", () => { if (!begun) { process.exitCode = 75; resolve(); } });
  });
}
