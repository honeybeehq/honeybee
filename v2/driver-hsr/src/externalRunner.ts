import { ExternalCapture, EXTERNAL_CAPTURE_CAP, EXTERNAL_DRAIN_PASSES } from "./externalCapture.ts";
import { openExternalFile } from "./externalFiles.ts";
import { createInterface } from "node:readline";
import { writeSync, closeSync, fstatSync, readSync } from "node:fs";
import { join } from "node:path";
import { dispatchValue, registrationValue, record, validateReceipt, type ExternalBinding, type BridgeEvent } from "../../core/src/externalExec.ts";
import { bridgeOperation } from "./externalBridge.ts";

export async function externalRunner(): Promise<void> {
  const lines = createInterface({ input: process.stdin });
  let binding: ExternalBinding | null = null;
  let stopping: Promise<unknown> | null = null;
  let stopRequested = false;
  let startCompleted = false;
  let terminal = false;
  let terminalEvent: BridgeEvent | null = null;
  let escalated = false;
  process.on("SIGTERM", () => { escalated = true; stopRequested = true; });
  let timer: ReturnType<typeof setInterval> | null = null;
  const offsets = new Map<string, number>();
  const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  let captureFailed = false;
  const capture = new ExternalCapture();
  const appendRaw = (name: string, bytes: Buffer) => {
    const output = openExternalFile(outputDirectory!, name, true);
    try {
      if (fstatSync(output).size + bytes.length > EXTERNAL_CAPTURE_CAP) throw new Error("external_exec_existing_capture_exceeds_cap");
      let written = 0;
      while (written < bytes.length) {
        const count = writeSync(output, bytes.subarray(written));
        if (!count) throw new Error("external_exec_capture_write_stalled");
        written += count;
      }
    } finally { closeSync(output); }
  };
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
        const wanted = Math.min(stat.size - position, 1024 * 1024);
        const allowed = capture.take(target!, wanted);
        const bytes = Buffer.alloc(allowed);
        const size = readSync(fd, bytes, 0, bytes.length, position);
        if (size) {
          appendRaw(target!, bytes.subarray(0, size));
        }
        offsets.set(source!, allowed < wanted ? stat.size : position + size);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      finally { if (fd !== null) closeSync(fd); }
    }
  };
  let outputDirectory: string | null = null;
  const invoke = async (operation: "start" | "wait" | "stop" | "reconcile") => {
    const current = binding!;
    return await bridgeOperation(current, operation, event => {
      if (event.type === "terminal") { validateReceipt(event.data, current); terminal = true; terminalEvent = event; }
      else emit({ schema: "honeybee.external.observation.v1", event });
    }, bytes => {
      const allowed = capture.take("bridge-stderr.raw", bytes.length);
      if (!allowed) return;
      bytes = bytes.subarray(0, allowed);
      appendRaw("bridge-stderr.raw", bytes);
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

  };
  const finishCapture = () => {
    let previous = "";
    for (let pass = 0; pass < EXTERNAL_DRAIN_PASSES && previous !== JSON.stringify([...offsets]); pass++) { previous = JSON.stringify([...offsets]); raw(); }
    if (previous !== JSON.stringify([...offsets])) captureFailed = true;
    if (capture.truncated) captureFailed = true;
    if (captureFailed) throw new Error("external_exec_raw_capture_failed");
  };
  await new Promise<void>(resolve => {
    let begun = false;
    lines.on("line", line => {
      if (!begun) {
        begun = true;
        void Promise.resolve().then(() => run(JSON.parse(line))).catch(async error => {
          if ((!escalated && !stopRequested) || !binding) throw error;
          const result = await invoke("reconcile");
          if (result.code !== 0 || !result.receipt) throw error;
        }).then(() => {
          finishCapture();
          if (!terminalEvent) throw new Error("external_exec_terminal_missing");
          if (timer) {clearInterval(timer); timer = null;}
          const fd = openExternalFile(outputDirectory!, "capture.json", true);
          try {writeSync(fd, JSON.stringify({...capture.snapshot(), drainIncomplete: false}));} finally {closeSync(fd);}
          emit({schema: "honeybee.external.observation.v1", event: terminalEvent});
          process.exitCode = 0;
        }).catch(() => {
          emit({ schema: "honeybee.external.error.v1", code: "reconcile_required" }); process.exitCode = 75;
        }).finally(() => {
          if (timer) clearInterval(timer);
          if (outputDirectory && process.exitCode !== 0) {
            try { const fd = openExternalFile(outputDirectory, "capture.json", true); try { writeSync(fd, JSON.stringify({...capture.snapshot(), drainIncomplete: captureFailed})); } finally { closeSync(fd); } } catch { process.exitCode = 75; }
          }
          lines.close(); process.stdin.destroy(); resolve();
        });
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
