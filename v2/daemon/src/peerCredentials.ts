import { createHash } from "node:crypto";
import { closeSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface LocalPeer {
  uid: number;
  pid: number;
  processBirth: string | null;
}
export interface PeerCredentialBridge {
  inspect(fd: number): {uid: number; pid: number; birth: string} | null;
  pin(fd: number): number;
  alive(fd: number): boolean;
}
export type PeerCredentialStatus = {
  state: "ready" | "peer_credentials_unavailable";
  target: string;
  artifactPath: string;
  reason: "artifact_missing" | "artifact_invalid" | "load_failed" | null;
};
export type PeerConnection = {
  state: "verified";
  peer: LocalPeer;
  current(): boolean;
  close(): void;
} | {state: "degraded" | "lookup_failed"; close(): void};

export function validatePeerArtifact(directory: string, target: string): string {
  if (!["linux-x64", "linux-arm64", "darwin-arm64"].includes(target)) throw new Error("Unsupported peer credential target");
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  const binary = join(directory, "peercred.node");
  const bytes = readFileSync(binary);
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (manifest.version !== 1 || manifest.target !== target || manifest.napi !== 8 || manifest.sha256 !== hash) throw new Error("Invalid peer credential artifact metadata");
  const [platform, architecture] = target.split("-");
  if (platform === "linux") {
    if (bytes.length < 64 || bytes.toString("hex", 0, 4) !== "7f454c46" || bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(16) !== 3 || bytes.readUInt16LE(18) !== (architecture === "x64" ? 62 : 183)) throw new Error("Wrong peer credential ELF target");
  } else if (platform === "darwin") {
    if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== (architecture === "x64" ? 0x01000007 : 0x0100000c) || bytes.readUInt32LE(12) !== 8) throw new Error("Wrong peer credential Mach-O target");
  } else throw new Error("Unsupported peer credential target");
  return binary;
}

export class PeerCredentials {
  private bridge: PeerCredentialBridge | null = null;
  private attempted = false;
  private reported = false;
  private readonly connections = new Set<() => void>();
  readonly status: PeerCredentialStatus;
  private readonly options: {
    directory?: string;
    target?: string;
    load?: (path: string) => PeerCredentialBridge;
    degraded?: (status: PeerCredentialStatus) => void;
  };
  constructor(options: {
    directory?: string;
    target?: string;
    load?: (path: string) => PeerCredentialBridge;
    degraded?: (status: PeerCredentialStatus) => void;
  } = {}) {
    this.options = options;
    const target = options.target ?? `${process.platform}-${process.arch}`;
    const root = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../../../dist/v2/peercred/" : "./peercred/", import.meta.url));
    const directory = options.directory ?? join(root, target);
    this.status = {state: "ready", target, artifactPath: join(directory, "peercred.node"), reason: null};
    try { validatePeerArtifact(directory, target); }
    catch (error) { this.degrade((error as NodeJS.ErrnoException).code === "ENOENT" ? "artifact_missing" : "artifact_invalid"); }
  }
  private degrade(reason: NonNullable<PeerCredentialStatus["reason"]>): void {
    this.status.state = "peer_credentials_unavailable";
    this.status.reason = reason;
    if (!this.reported) {
      this.reported = true;
      this.options.degraded?.({...this.status});
    }
  }
  connect(socket: object): PeerConnection {
    if (this.status.state === "peer_credentials_unavailable") return {state: "degraded", close() {}};
    if (!this.attempted) {
      this.attempted = true;
      try {
        this.bridge = (this.options.load ?? createRequire(import.meta.url))(this.status.artifactPath);
        if (!this.bridge || typeof this.bridge.inspect !== "function" || typeof this.bridge.pin !== "function" || typeof this.bridge.alive !== "function") throw new Error("Invalid peer credential bridge");
      } catch { this.degrade("load_failed"); }
    }
    if (!this.bridge) return {state: "degraded", close() {}};
    const fd = (socket as {_handle?: {fd?: number}})._handle?.fd;
    if (!Number.isInteger(fd) || fd! < 0) return {state: "lookup_failed", close() {}};
    let pin = -1;
    try {
      pin = this.bridge.pin(fd!);
      const captured = this.bridge.inspect(fd!);
      if (!captured || !Number.isSafeInteger(captured.uid) || captured.uid < 0 || !Number.isSafeInteger(captured.pid) || captured.pid <= 0) throw new Error("Peer credentials unavailable");
      const peer = {uid: captured.uid, pid: captured.pid, processBirth: captured.birth || null};
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        if (pin >= 0) closeSync(pin);
        this.connections.delete(close);
      };
      this.connections.add(close);
      return {state: "verified", peer, close, current: () => {
        if (closed || !peer.processBirth) return false;
        try {
          if (pin >= 0 && !this.bridge!.alive(pin)) return false;
          const fresh = this.bridge!.inspect(fd!);
          return fresh?.uid === peer.uid && fresh.pid === peer.pid && fresh.birth === peer.processBirth;
        } catch { return false; }
      }};
    } catch {
      if (pin >= 0) closeSync(pin);
      return {state: "lookup_failed", close() {}};
    }
  }
  close(): void { for (const close of this.connections) close(); }
}
