import { dirname, isAbsolute, resolve } from "node:path";
import { spawn } from "node:child_process";
import { constants, openSync, closeSync, fstatSync, readSync, lstatSync, realpathSync } from "node:fs";
import { dispatchBytes, record, sha256, validateReceipt, type ExternalBinding, type BridgeOperation, type BridgeReceipt, bridgeEvent, type BridgeEvent } from "../../core/src/externalExec.ts";

export const BRIDGE_ENV = Object.freeze({ PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" });
function descriptorBytes(fd: number): Buffer {
  const size = fstatSync(fd).size;
  if (size > 256 * 1024 * 1024) throw new Error("external_exec_install_too_large");
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(fd, bytes, offset, size - offset, offset);
    if (!count) throw new Error("external_exec_install_changed");
    offset += count;
  }
  return bytes;
}
export function immutableBridgePath(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error("external_exec_install_path_invalid");
  const check = (candidate: string) => {
    let cursor = candidate;
    while (true) {
      const stat = lstatSync(cursor);
      if (stat.uid !== 0 || !stat.isSymbolicLink() && (stat.mode & 0o022) !== 0) throw new Error("external_exec_install_chain_writable");
      const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
    }
  };
  check(path);
  check(realpathSync(path));
}
export function verifyBridge(binding: Pick<ExternalBinding, "registration">): { executableFd: number; close(): void } {
  if (process.platform !== "linux") throw new Error("external_exec_linux_required");
  const pins = binding.registration;
  const descriptors: number[] = [];
  const verified = new Set<string>();
  const verify = (path: string, expected: string, immutableFile = false): number => {
    immutableBridgePath(path);
    const fd = openSync(realpathSync(path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); descriptors.push(fd);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & (immutableFile ? 0o222 : 0o022)) !== 0 || stat.size > 256 * 1024 * 1024 || sha256(descriptorBytes(fd)) !== expected) throw new Error("external_exec_install_mismatch");
    verified.add(path); return fd;
  };
  try {
    const executableFd = verify(pins.executable, pins.executableSha256, true);
    const filesFd = verify(pins.filesManifest, pins.filesManifestSha256, true);
    const payloadFd = verify(pins.payloadManifest, pins.payloadManifestSha256, true);
    const inventory = record(JSON.parse(descriptorBytes(filesFd).toString("utf8")));
    if (!Array.isArray(inventory.files) || inventory.files.length > 20000) throw new Error("external_exec_install_inventory_invalid");
    for (const entry of inventory.files) {
      const file = record(entry);
      if (typeof file.path !== "string" || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error("external_exec_install_inventory_invalid");
      if (file.resolvedPath !== undefined && realpathSync(file.path) !== file.resolvedPath) throw new Error("external_exec_install_symlink_changed");
      const fd = verify(file.path, file.sha256); closeSync(fd); descriptors.pop();
    }
    for (const line of descriptorBytes(payloadFd).toString("utf8").trimEnd().split("\n")) {
      const match = /^([a-f0-9]{64})  (\/[^\r\n]+)$/.exec(line);
      if (!match) throw new Error("external_exec_payload_manifest_invalid");
      const fd = verify(match[2]!, match[1]!); closeSync(fd); descriptors.pop();
    }
    const header = descriptorBytes(executableFd).subarray(0, 256).toString("utf8").split("\n", 1)[0]!;
    if (header.startsWith("#!")) {
      const interpreter = header.slice(2).trim();
      if (!/^\/[^\s]+$/.test(interpreter) || !verified.has(interpreter)) throw new Error("external_exec_interpreter_unpinned");
      immutableBridgePath(interpreter);
    }
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
  let pending = Buffer.alloc(0), eventBytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  stdout.on("data", (chunk: Buffer) => {
    if (failure) return;
    eventBytes += chunk.length;
    if (eventBytes > 16 * 1024 * 1024) { failure = new Error("external_exec_events_truncated"); child.kill("SIGTERM"); return; }
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
