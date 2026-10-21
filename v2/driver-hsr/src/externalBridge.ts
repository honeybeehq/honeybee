import { spawn } from "node:child_process";
import { constants, openSync, closeSync, fstatSync, readFileSync } from "node:fs";
import { dispatchBytes, record, sha256, validateReceipt, type ExternalBinding, type BridgeOperation, type BridgeReceipt, bridgeEvent, type BridgeEvent } from "../../core/src/externalExec.ts";

export const BRIDGE_ENV = Object.freeze({ PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" });
export function verifyBridge(binding: Pick<ExternalBinding, "registration">): { executableFd: number; close(): void } {
  if (process.platform !== "linux") throw new Error("external_exec_linux_required");
  const pins = binding.registration;
  const descriptors: number[] = [];
  try {
    for (const [path, expected] of [[pins.executable, pins.executableSha256], [pins.filesManifest, pins.filesManifestSha256], [pins.payloadManifest, pins.payloadManifestSha256]]) {
      const fd = openSync(path!, constants.O_RDONLY | constants.O_NOFOLLOW); descriptors.push(fd);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o222) !== 0 || stat.size > 32 * 1024 * 1024 || sha256(readFileSync(fd)) !== expected) throw new Error("external_exec_install_mismatch");
    }
    const executableFd = descriptors[0]!;
    if ((fstatSync(executableFd).mode & 0o111) === 0) throw new Error("external_exec_install_not_executable");
    return { executableFd, close: () => { for (const fd of descriptors.splice(0)) closeSync(fd); } };
  } catch (error) { for (const fd of descriptors) closeSync(fd); throw error; }
}
export async function bridgeOperation(binding: ExternalBinding, operation: BridgeOperation, onEvent: (event: BridgeEvent) => void, onStderr: (bytes: Buffer) => void): Promise<{ code: number | null; receipt: BridgeReceipt | null }> {
  const verified = verifyBridge(binding);
  let child;
  try {
    child = spawn("/proc/self/fd/3", [operation, "--manifest", "-"], { env: { ...BRIDGE_ENV }, cwd: "/", stdio: ["pipe", "pipe", "pipe", verified.executableFd] });
  } finally { verified.close(); }
  const stdout = child.stdout, stderr = child.stderr, stdin = child.stdin;
  if (!stdout || !stderr || !stdin) throw new Error("external_exec_transport_unavailable");
  let seq = 0, receipt: BridgeReceipt | null = null, failure: Error | null = null;
  let pending = Buffer.alloc(0);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  stdout.on("data", (chunk: Buffer) => {
    if (failure) return;
    pending = Buffer.concat([pending, chunk]);
    try {
      let newline: number;
      while ((newline = pending.indexOf(10)) !== -1) {
        if (newline > 2 * 1024 * 1024) throw new Error("external_exec_event_too_large");
        const line = decoder.decode(pending.subarray(0, newline));
        pending = pending.subarray(newline + 1);
        const event = bridgeEvent(JSON.parse(line), binding, ++seq);
        if (event.type === "terminal") receipt = validateReceipt(event.data, binding);
        onEvent(event);
      }
      if (pending.length > 2 * 1024 * 1024) throw new Error("external_exec_event_too_large");
    } catch { failure = new Error("external_exec_protocol_invalid"); pending = Buffer.alloc(0); }
  });
  stderr.on("data", (bytes: Buffer) => { try { onStderr(bytes); } catch { failure = new Error("external_exec_stderr_capture_failed"); } });
  stdin.on("error", () => undefined);
  stdin.end(dispatchBytes(binding.dispatch));
  return await new Promise((resolve, reject) => {
    child.on("error", () => { reject(new Error("external_exec_transport_lost")); });
    child.on("close", code => {
      if (pending.length) failure = new Error("external_exec_protocol_truncated");
      if (failure) reject(failure);
      else resolve({ code, receipt });
    });
  });
}
