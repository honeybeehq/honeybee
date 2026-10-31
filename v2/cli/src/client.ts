import type { EffectCoverage, EffectResolution, EffectVerb } from "../../core/src/effectResolve.ts";
/**
 * Thin RPC client over the daemon's unix socket (protocol.ts framing).
 * Mutations and watch ALWAYS go through here; reads fall back to the
 * read-only store (readonly.ts) only when the daemon is down.
 */
import { createConnection, type Socket } from "node:net";
import { JsonLineBuffer } from "../../daemon/src/jsonl.ts";
import {
  PROTOCOL,
  RpcError,
  type RpcVerb,
  type RpcRequestContext,
  type WatchFrame,
} from "../../daemon/src/protocol.ts";

/** The daemon is not reachable at the socket — the read-fallback trigger. */
export class DaemonDownError extends Error {
  readonly code = "socket_unreachable";
  readonly socketPath: string;
  readonly reason: string;
  constructor(socketPath: string, reason: string) {
    super(`daemon not reachable at ${socketPath} (${reason})`);
    this.name = "DaemonDownError";
    this.socketPath = socketPath;
    this.reason = reason;
  }
}

/** The protocol the previously deployed daemon speaks; see legacyProtocolVerbs. */
export const LEGACY_PROTOCOL = "v2/1";

export interface DaemonInstance {
  id: string;
  dataDir: string;
}

export interface ConnectOptions {
  /** Shorthand for `legacyProtocolVerbs: ["update.status"]`. */
  updateOwnerCompatibility?: true;
  /**
   * Verbs this client may still issue when the daemon speaks the previous
   * protocol (v2/1). Deploys run the newly installed CLI against the daemon
   * that is about to be replaced; the store backup and identity reads it needs
   * are unchanged across that boundary, everything else stays refused.
   */
  legacyProtocolVerbs?: readonly RpcVerb[];
  capabilities?: readonly string[];
  caller?: { dataDir?: string; liveTarget?: boolean; expectedInstanceId: string | null; allowForeignDaemon?: boolean };
  verifyInstance?: (instance: DaemonInstance | null) => void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

export class RpcClient {
  private readonly socket: Socket;
  private readonly pending = new Map<number, Pending>();
  private readonly frames = new JsonLineBuffer();
  private nextId = 1;
  private closed = false;
  private legacyVerbs: readonly RpcVerb[] | null = null;
  capabilities: readonly string[] = [];
  instance: DaemonInstance | null = null;
  /** Watch push frames (deltas/gaps) land here. */
  onEvent: ((frame: WatchFrame) => void) | null = null;
  onClose: (() => void) | null = null;

  private constructor(socket: Socket) {
    this.socket = socket;
  }

  static connect(socketPath: string, timeoutMs = 3000, clientLane?: "node_relay" | "remote", options: ConnectOptions = {}): Promise<RpcClient> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new DaemonDownError(socketPath, "connect timeout"));
      }, timeoutMs);
      timer.unref();
      socket.once("error", (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(new DaemonDownError(socketPath, err.code ?? err.message));
      });
      socket.once("connect", () => {
        const client = new RpcClient(socket);
        socket.setEncoding("utf8");
        // Wait for the server hello, then answer with ours (negotiated once).
        const onHello = (chunk: string): void => {
          const lines = client.frames.push(chunk);
          const line = lines.shift();
          if (line === undefined) return;
          socket.off("data", onHello);
          clearTimeout(timer);
          let hello: Record<string, unknown>;
          try {
            hello = JSON.parse(line) as Record<string, unknown>;
          } catch {
            socket.destroy();
            reject(new RpcError("protocol_mismatch", "server hello is not json"));
            return;
          }
          const legacyVerbs = options.updateOwnerCompatibility === true ? ["update.status" as const] : options.legacyProtocolVerbs ?? [];
          client.legacyVerbs = hello.protocol === LEGACY_PROTOCOL && legacyVerbs.length > 0 ? legacyVerbs : null;
          if (hello.protocol !== PROTOCOL && !client.legacyVerbs) {
            socket.destroy();
            reject(
              new RpcError(
                "protocol_mismatch",
                `client speaks ${PROTOCOL}; server offered ${JSON.stringify(hello.protocol ?? null)}`,
              ),
            );
            return;
          }
          client.capabilities = Array.isArray(hello.capabilities) ? hello.capabilities.filter((value): value is string => typeof value === "string") : [];
          client.instance = instanceOf(hello.instance);
          try {
            options.verifyInstance?.(client.instance);
          } catch (err) {
            socket.destroy();
            reject(err);
            return;
          }
          socket.write(`${JSON.stringify({ protocol: hello.protocol, ...(clientLane ? { clientLane } : {}), ...(options.caller ? { caller: options.caller } : {}), ...(options.capabilities ? { capabilities: options.capabilities } : {}) })}\n`);
          socket.on("data", (c: string) => client.onData(c));
          socket.on("close", () => client.onSocketClose());
          socket.on("error", () => socket.destroy());
          for (const frame of lines) {
            const line = frame.trim();
            if (line.length > 0) client.onFrame(line);
          }
          resolve(client);
        };
        socket.on("data", onHello);
      });
    });
  }

  async effectCoverage(): Promise<EffectCoverage> {
    if (!this.capabilities.includes("rpc-effect-resolve.v1")) throw new RpcError("rpc_effect_resolve_unsupported", "Owner does not support effect resolution");
    const result = await this.request<EffectCoverage>("rpc.effect.status");
    if (!result || typeof result.ownerStoreId !== "string" || !/^[a-f0-9-]{36}$/.test(result.ownerStoreId) || typeof result.coverageId !== "string" || !/^[a-f0-9-]{36}$/.test(result.coverageId)) throw new RpcError("invalid_request", "Malformed effect coverage");
    return result;
  }

  async resolveEffect(verb: EffectVerb, idempotencyKey: string, expected: EffectCoverage): Promise<EffectResolution> {
    if (!this.capabilities.includes("rpc-effect-resolve.v1")) throw new RpcError("rpc_effect_resolve_unsupported", "Owner does not support effect resolution");
    const result = await this.request<EffectResolution>("rpc.effect.resolve", { verb, idempotencyKey });
    if (!result || result.ownerStoreId !== expected.ownerStoreId || result.coverageId !== expected.coverageId || result.verb !== verb || result.idempotencyKey !== idempotencyKey
      || !["committed", "never_seen_fenced", "in_flight"].includes(result.status)
      || result.status === "committed" && (!result.receipt || result.receipt.key !== idempotencyKey || result.receipt.verb !== verb || !Object.hasOwn(result.receipt, "result"))) throw new RpcError("invalid_request", "Malformed or changed-owner effect resolution; hold the effect");
    return result;
  }

  request<T = unknown>(verb: RpcVerb, params: Record<string, unknown> = {}, timeoutMs = 10_000, context?: RpcRequestContext): Promise<T> {
    if (this.legacyVerbs && !this.legacyVerbs.includes(verb)) return Promise.reject(new RpcError("protocol_mismatch", `Legacy ${LEGACY_PROTOCOL} compatibility permits only ${this.legacyVerbs.join(", ")}`));
    if (verb.startsWith("rpc.execution.")) return Promise.reject(new RpcError("rpc_execution_fence_unsupported", "Owner does not support archive/send execution fencing; do not fall back"));
    if ((verb === "rpc.effect.resolve" || verb === "rpc.effect.status") && !this.capabilities.includes("rpc-effect-resolve.v1")) return Promise.reject(new RpcError("rpc_effect_resolve_unsupported", "Owner does not support effect resolution"));
    if (verb === "question.dismiss" && !this.capabilities.includes("question.dismiss.v1")) return Promise.reject(new RpcError("question_dismiss_unsupported", "Question dismissal is unsupported by this Honeybee."));
    if (verb === "question.withdraw" && !this.capabilities.includes("question.withdraw.v1")) return Promise.reject(new RpcError("question_withdraw_unsupported", "Question withdrawal is unsupported by this Honeybee."));
    if (this.closed) return Promise.reject(new DaemonDownError("(closed)", "connection closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DaemonDownError(this.socket.remoteAddress ?? "(socket)", `rpc timeout on ${verb}`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.socket.write(`${JSON.stringify({ id, verb, params, ...(context ? { context } : {}) })}\n`);
    });
  }

  close(): void {
    this.closed = true;
    this.socket.destroy();
  }

  private onData(chunk: string): void {
    for (const frame of this.frames.push(chunk)) {
      const line = frame.trim();
      if (line.length > 0) this.onFrame(line);
    }
  }

  private onFrame(line: string): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // a torn frame on a dying socket; close handling owns cleanup
    }
    if (typeof frame.type === "string") {
      this.onEvent?.(frame as unknown as WatchFrame);
      return;
    }
    if (typeof frame.id !== "number") return;
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    if (frame.ok === true) {
      pending.resolve(frame.result);
    } else {
      const err = (frame.error ?? {}) as { code?: string; message?: string; details?: Record<string, unknown> };
      pending.reject(
        new RpcError(
          (err.code as RpcError["code"]) ?? "invalid_request",
          err.message ?? "rpc error",
          err.details,
        ),
      );
    }
  }

  private onSocketClose(): void {
    this.closed = true;
    for (const [, p] of this.pending) p.reject(new DaemonDownError("(socket)", "connection closed"));
    this.pending.clear();
    this.onClose?.();
  }
}

function instanceOf(value: unknown): DaemonInstance | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  return typeof raw.id === "string" && typeof raw.dataDir === "string" ? { id: raw.id, dataDir: raw.dataDir } : null;
}
