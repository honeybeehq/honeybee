import { validatePeerArtifact } from "../../harness/src/processIdentity.ts";
export { validatePeerArtifact } from "../../harness/src/processIdentity.ts";
import { closeSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { type } from "node:os";
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
    const kernel = type();
    const hostPlatform = kernel === "Darwin" ? "darwin" : kernel === "Linux" ? "linux" : "unsupported";
    const target = options.target ?? `${hostPlatform}-${process.arch}`;
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
