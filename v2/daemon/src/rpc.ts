import { PeerCredentials, type PeerConnection } from "./peerCredentials.ts";
import { LocalRpcTrust, type LocalTrustConfig } from "./localRpcTrust.ts";
import { LocalRpcRefusals } from "./localRpcRefusals.ts";
import { RPC_ACCESS } from "./rpcAccess.ts";
import { withRpcCaller } from "../../core/src/rpcAuditContext.ts";
/**
 * The daemon's RPC server — unix socket, jsonl frames, one negotiated
 * protocol (spec 04 "RPC surface"; framing defined in protocol.ts).
 *
 * The server is transport only: it parses frames, enforces the hello, maps
 * errors onto the closed list, and owns the per-connection watch cursors.
 * Verb semantics live in the daemon's dispatch function.
 */
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import type { AuditRow } from "../../core/src/index.ts";
import {
  AccountNotFoundError,
  AccountReferencedError,
  ActionClaimedError,
  ActionKindUnknownError,
  ActionNotFoundError,
  ActionRefusedError,
  ActionReorderInvalidError,
  ActionStaleAttemptError,
  ActionUnauthorizedError,
  BeeNotFoundError,
  CellNotFoundError,
  ContinuationUnsupportedError,
  CoreError,
  HandoffInProgressError,
  HandoffNotFoundError,
  IdempotencyConflictError,
  IllegalTransitionError,
  MoveInProgressError,
  StaleGenerationError,
  NameConflictError,
  StalePlacementError,
  PackageError,
  QuestionNotFoundError,
  SealNotFoundError,
  TaskNotFoundError,
  TemplateEnvWipeError,
  TemplateNotFoundError,
  TrackNotFoundError,
} from "../../core/src/index.ts";
import { LeaseRefusal } from "./accountsService.ts";
import { LoginFlowRefusal } from "./loginFlows.ts";
import {
  NOOP_PERFORMANCE,
  rpcPerformanceSpanName,
  type PerformanceRecorder,
} from "./performance.ts";
import {
  DAEMON_CAPABILITIES,
  PROTOCOL,
  RPC_VERBS,
  RpcError,
  LEASE_FENCE_FIELDS,
  type HelloFrame,
  BUILD_IDENTITY,
  type RpcErrorCode,
  type RpcVerb,
  type WatchFrame,
} from "./protocol.ts";

export interface RpcConn {
  readonly localPeer?: Readonly<{uid: number; pid: number; processBirth: string | null}>;
  readonly ingress?: "local_unix" | "node_relay" | "remote";
  readonly caller?: Readonly<HelloCaller>;
  /** Push a raw frame (used for watch deltas/gaps). */
  send(obj: unknown): void;
  /** Enter watch mode from this seq; subsequent flushes stream deltas. */
  subscribeWatch(cursor: number): void;
  /** Re-align the watch cursor (after serving a snapshot to a watching client). */
  alignWatch(cursor: number): void;
}

const LOCAL_HANDOFF_VERBS = new Set<RpcVerb>([
  "account.credentials.export", "account.credentials.adoptPrepare", "account.credentials.exportPrepare",
  "account.credentials.exportCommit", "account.credentials.adopt", "account.credentials.exportAbort",
  "account.credentials.adoptAbort", "account.credentials.exportConfirm", "account.credentials.standDown",
  "account.credentials.standDownReceipt", "account.credentials.handoffIdentitySet", "account.credentials.handoffKeyRotate",
  "account.credentials.operatorTakeover", "account.credentials.operatorTakeoverApply",
  "account.credentials.operatorTakeoverComplete", "account.credentials.operatorTakeoverCancel",
  "account.credentials.releasePeer", "account.credentials.exportSettle", "account.credentials.handoffStatus",
]);

export function assertLocalHandoffRpc(verb: RpcVerb, params: Record<string, unknown>, conn: RpcConn): void {
  if (["account.limits.observe","account.limits.observation","account.limits.observation.discard"].includes(verb) && conn.ingress !== "local_unix") throw new RpcError("account_limits_observation_refused", "Limits observations require a direct local Unix-socket call.", {reason:"local_required"});
  if (verb === "account.lease.install" && LEASE_FENCE_FIELDS.some(key => params[key] !== undefined) && conn.ingress !== "local_unix") throw new RpcError("account_lease_conflict", "Forwarded lease fences require a direct local Unix-socket call from the lease issuer.", { reason: "local_required" });
  if (verb === "account.lease.remove" && (params.discardNative !== undefined || params.confirm !== undefined) && conn.ingress !== "local_unix") throw new RpcError("account_lease_remove_unavailable", "Native credential discard requires a direct local Unix-socket call.", { reason: "local_required" });
  if (verb === "account.lease.export" && conn.ingress !== "local_unix") throw new RpcError("account_lease_export_refused", "Leased material export requires a direct local Unix-socket call.", { reason: "local_required" });
  if (verb === "account.lease.install" && (params.enrol !== undefined || params.viaNodeId !== undefined) && conn.ingress !== "local_unix") throw new RpcError("account_lease_enrol_refused", "Lease enrolment provenance requires a direct local Unix-socket call.", { reason: "local_required" });
  if ((LOCAL_HANDOFF_VERBS.has(verb) || params.authenticatedPeer !== undefined || params.targetKey !== undefined)
    && conn.ingress !== "local_unix") throw new RpcError("credential_handoff_conflict", "Handoff authority facts require a direct local Unix-socket call; remote and node-relayed RPCs are refused.");
}

export type RpcDispatch = (
  verb: RpcVerb,
  params: Record<string, unknown>,
  conn: RpcConn,
) => unknown;

export interface RpcServerOptions {
  dataDir?: string;
  instance?: {id: string; dataDir: string};
  localTrust?: LocalTrustConfig;
  peerCredentials?: PeerCredentials;
  securityAudit?: (kind: string, payload: Record<string, unknown>) => void;
  socketPath: string;
  log: (op: string) => void;
  dispatch: RpcDispatch;
  performance?: PerformanceRecorder;
}

interface Connection extends RpcConn {
  peerConnection: PeerConnection | null;
  socket: Socket;
  buffer: string;
  helloDone: boolean;
  relayLane: "node_relay" | "remote" | null;
  caller?: HelloCaller;
  watchCursor: number | null;
}

const RPC_VERB_SET = new Set<string>(RPC_VERBS);

function isRpcVerb(value: unknown): value is RpcVerb {
  return typeof value === "string" && RPC_VERB_SET.has(value);
}

/** Map any thrown error onto the closed RPC error list. */
export function toRpcError(err: unknown): { code: RpcErrorCode; message: string; details?: Record<string, unknown> } {
  if (err instanceof RpcError) return { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) };
  if (err instanceof LoginFlowRefusal) return { code: err.code, message: err.message };
  if (err instanceof LeaseRefusal) return { code: err.code, message: err.message };
  if (err instanceof BeeNotFoundError) return { code: "bee_not_found", message: err.message };
  if (err instanceof TemplateNotFoundError) return { code: "template_not_found", message: err.message };
  if (err instanceof TrackNotFoundError) return { code: "track_not_found", message: err.message };
  if (err instanceof QuestionNotFoundError) return { code: "question_not_found", message: err.message };
  if (err instanceof SealNotFoundError) return { code: "seal_not_found", message: err.message };
  if (err instanceof TaskNotFoundError) return { code: "task_not_found", message: err.message };
  if (err instanceof AccountNotFoundError) return { code: "account_not_found", message: err.message };
  if (err instanceof AccountReferencedError) return { code: "account_referenced", message: err.message };
  if (err instanceof CellNotFoundError) return { code: "cell_not_found", message: err.message };
  if (err instanceof StalePlacementError) return { code: "stale_placement", message: err.message };
  if (err instanceof MoveInProgressError) return { code: "move_in_progress", message: err.message };
  if (err instanceof IdempotencyConflictError) return { code: "idempotency_conflict", message: err.message };
  if (err instanceof HandoffInProgressError) return { code: "handoff_in_progress", message: err.message };
  if (err instanceof StaleGenerationError) return { code: "stale_generation", message: err.message };
  if (err instanceof HandoffNotFoundError) return { code: "handoff_not_found", message: err.message };
  if (err instanceof ActionNotFoundError) return { code: "action_not_found", message: err.message };
  if (err instanceof ActionRefusedError) return { code: "action_refused", message: err.message };
  if (err instanceof ActionReorderInvalidError) return { code: "action_reorder_invalid", message: err.message };
  if (err instanceof ActionStaleAttemptError) return { code: "action_stale_attempt", message: err.message };
  if (err instanceof ActionUnauthorizedError) return { code: "action_unauthorized", message: err.message };
  if (err instanceof ActionKindUnknownError) return { code: "action_kind_unknown", message: err.message };
  if (err instanceof ActionClaimedError) return { code: "action_claimed", message: err.message };
  if (err instanceof ContinuationUnsupportedError) return { code: "continuation_unsupported", message: err.message };
  if (err instanceof NameConflictError) return { code: "name_conflict", message: err.message };
  if (err instanceof TemplateEnvWipeError) return { code: "template_env_wipe_refused", message: err.message };
  if (err instanceof PackageError) return { code: "invalid_package", message: err.message };
  if (err instanceof IllegalTransitionError) {
    const code: RpcErrorCode = err.message.includes("lifecycle") ? "lifecycle_refused" : "runtime_refused";
    return { code, message: err.message };
  }
  if (err instanceof CoreError) return { code: "invalid_request", message: err.message };
  return { code: "invalid_request", message: err instanceof Error ? err.message : String(err) };
}

export class RpcServer {
  private readonly opts: RpcServerOptions;
  private readonly performance: PerformanceRecorder;
  private readonly server: Server;
  private readonly conns = new Set<Connection>();
  private listening = false;
  private readonly credentials: PeerCredentials;
  private readonly trust: LocalRpcTrust;
  private readonly refusals: LocalRpcRefusals;

  get localSecurity() { return {peerCredentials: {...this.credentials.status}, localTrust: this.trust.state}; }

  constructor(opts: RpcServerOptions) {
    this.opts = opts;
    const audit = opts.securityAudit ?? (() => {});
    this.credentials = opts.peerCredentials ?? new PeerCredentials({degraded: status => audit("rpc.peer_credentials_unavailable", {...status})});
    this.trust = new LocalRpcTrust(opts.localTrust ?? {requireObservationCaller: false, registrationKeyFile: ""}, opts.dataDir ?? "/", audit);
    this.refusals = new LocalRpcRefusals(audit);
    this.performance = opts.performance ?? NOOP_PERFORMANCE;
    this.server = createServer((socket) => this.onConnection(socket));
  }

  async listen(): Promise<void> {
    if (existsSync(this.opts.socketPath)) {
      if (await socketAcceptsConnections(this.opts.socketPath)) {
        throw new RpcError("socket_in_use", `another process is already listening on ${this.opts.socketPath}`, { socketPath: this.opts.socketPath });
      }
      unlinkSync(this.opts.socketPath);
    }
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.opts.socketPath, () => {
        this.listening = true;
        this.opts.log(`rpc.listen socket=${this.opts.socketPath}`);
        resolve();
      });
    });
  }

  close(): Promise<void> {
    for (const conn of this.conns) conn.socket.destroy();
    this.conns.clear();
    this.credentials.close();
    this.trust.close();
    this.refusals.close();
    return new Promise((resolve) => {
      if (!this.listening) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
      this.listening = false;
    });
  }

  /**
   * Stream pending audit rows to every watching connection. Deltas carry
   * `baseSeq` (what the client last held) and `seq` (new cursor): the client
   * fails closed on any `baseSeq` mismatch. A batch larger than `maxBatch`
   * becomes an explicit `{type:"gap"}` — the server never sends unbounded
   * frames, and the gap is detectable by construction.
   */
  flushWatch(latestSeq: number, eventsSince: (fromSeq: number) => AuditRow[], maxBatch: number): void {
    // Steady-state watchers share a cursor: fetch each distinct cursor once
    // per pass instead of once per connection.
    const byCursor = new Map<number, AuditRow[]>();
    for (const conn of this.conns) {
      if (conn.watchCursor == null || conn.watchCursor >= latestSeq) continue;
      let events = byCursor.get(conn.watchCursor);
      if (events === undefined) {
        events = eventsSince(conn.watchCursor);
        byCursor.set(conn.watchCursor, events);
      }
      if (events.length === 0) continue;
      if (events.length > maxBatch) {
        const frame: WatchFrame = { type: "gap", seq: latestSeq };
        conn.send(frame);
        conn.watchCursor = latestSeq;
        this.opts.log(`rpc.watch.gap cursor=${latestSeq} dropped=${events.length}`);
        continue;
      }
      const last = events[events.length - 1] as AuditRow;
      const frame: WatchFrame = { type: "delta", baseSeq: conn.watchCursor, seq: last.seq, events };
      conn.send(frame);
      conn.watchCursor = last.seq;
    }
  }

  private onConnection(socket: Socket): void {
    const localUnix = socket.remoteAddress === undefined;
    const conn: Connection = {
      socket,
      peerConnection: localUnix ? this.credentials.connect(socket) : null,
      get localPeer() { return conn.peerConnection?.state === "verified" ? conn.peerConnection.peer : undefined; },
      buffer: "",
      helloDone: false,
      relayLane: null,
      get ingress() { return localUnix ? conn.relayLane ?? "local_unix" : "remote"; },
      watchCursor: null,
      send: (obj: unknown) => {
        if (socket.destroyed) return;
        this.performance.measureSync("rpc.serialize", () => {
          socket.write(`${JSON.stringify(obj)}\n`);
        });
      },
      subscribeWatch: (cursor: number) => {
        conn.watchCursor = cursor;
      },
      alignWatch: (cursor: number) => {
        if (conn.watchCursor != null) conn.watchCursor = cursor;
      },
    };
    this.conns.add(conn);
    socket.setEncoding("utf8");
    // Versioned hello, server side (negotiated once). Capability tags are
    // additive: a pre-v16 client ignores the extra key.
    conn.send({ protocol: PROTOCOL, capabilities: DAEMON_CAPABILITIES, identity: BUILD_IDENTITY, ...(this.opts.instance ? { instance: this.opts.instance } : {}) } satisfies HelloFrame);
    socket.on("data", (chunk: string) => this.onData(conn, chunk));
    socket.on("error", () => socket.destroy());
    socket.on("close", () => { conn.peerConnection?.close(); this.trust.disconnect(conn); this.conns.delete(conn); });
  }

  private onData(conn: Connection, chunk: string): void {
    conn.buffer += chunk;
    for (;;) {
      const nl = conn.buffer.indexOf("\n");
      if (nl < 0) return;
      const line = conn.buffer.slice(0, nl).trim();
      conn.buffer = conn.buffer.slice(nl + 1);
      if (line.length === 0) continue;
      this.onFrame(conn, line);
    }
  }

  private onFrame(conn: Connection, line: string): void {
    let frame: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      frame = parsed as Record<string, unknown>;
    } catch {
      conn.send({ id: -1, ok: false, error: { code: "invalid_request", message: "frame is not a json object" } });
      return;
    }
    if (!conn.helloDone) {
      if (frame.protocol !== PROTOCOL) {
        conn.send({
          id: -1,
          ok: false,
          error: {
            code: "protocol_mismatch",
            message: `server speaks ${PROTOCOL}; client offered ${JSON.stringify(frame.protocol ?? null)}`,
          },
        });
        conn.socket.end();
        return;
      }
      if (frame.clientLane !== undefined && frame.clientLane !== "node_relay" && frame.clientLane !== "remote") {
        conn.send({ id: -1, ok: false, error: { code: "invalid_request", message: "clientLane can only mark node_relay or remote provenance." } });
        conn.socket.end();
        return;
      }
      const caller = helloCaller(frame.caller);
      if (caller === "invalid") {
        conn.send({ id: -1, ok: false, error: { code: "invalid_request", message: "caller must be {dataDir?: string, expectedInstanceId?: string | null, allowForeignDaemon?: boolean}." } });
        conn.socket.end();
        return;
      }
      conn.relayLane = frame.clientLane === "node_relay" || frame.clientLane === "remote" ? frame.clientLane : null;
      if (caller) conn.caller = caller;
      conn.helloDone = true;
      return;
    }
    const id = typeof frame.id === "number" ? frame.id : -1;
    const verb = frame.verb;
    if (!isRpcVerb(verb)) {
      conn.send({ id, ok: false, error: { code: "invalid_request", message: `unknown verb: ${String(verb)}` } });
      return;
    }
    const span = this.performance.startSpan(rpcPerformanceSpanName(verb));
    const params =
      frame.params === undefined
        ? {}
        : frame.params !== null && typeof frame.params === "object" && !Array.isArray(frame.params)
          ? (frame.params as Record<string, unknown>)
          : null;
    if (params === null) {
      span.end("error");
      conn.send({ id, ok: false, error: { code: "invalid_request", message: "params must be an object" } });
      return;
    }
    try {
      const peer = conn.peerConnection;
      if (peer?.state === "verified" && peer.peer.uid !== process.geteuid!()) {
        this.refusals.record("local_peer_uid_mismatch", peer.peer.uid, peer.peer.pid);
        throw new RpcError("local_peer_uid_mismatch", "Local RPC requires the daemon effective uid.");
      }
      if (peer?.state === "lookup_failed" && RPC_ACCESS[verb] === "mutate") {
        this.refusals.record("local_peer_credentials_unavailable", null, null);
        throw new RpcError("local_peer_credentials_unavailable", "Peer credentials are unavailable for this connection; reconnect before mutating state.");
      }
      const caller = peer?.state === "verified" ? {transport: "local_unix" as const, ingress: conn.ingress ?? "remote", uid: peer.peer.uid, pid: peer.peer.pid, verb} : null;
      const result = withRpcCaller(caller, () => {
        if (verb === "rpc.localTrust.challenge" || verb === "rpc.localTrust.register") {
          if (!peer) throw new RpcError("caller_not_trusted", "Registration requires a local Unix connection.");
          if (verb === "rpc.localTrust.challenge") {
            if (Object.keys(params).length) throw new RpcError("invalid_request", "Challenge takes no parameters.");
            return this.trust.challenge(peer, conn, conn.ingress);
          }
          return this.trust.register(params, peer, conn, conn.ingress);
        }
        if (verb === "account.limits.observe" || verb === "account.limits.observation.discard" || (verb === "account.limits.observation" && params.id !== undefined)) {
          if (!peer && this.trust.enabled) throw new RpcError("caller_not_trusted", "Observation trust requires a local Unix connection.");
          if (peer) this.trust.require(peer, conn.ingress);
        }
        return this.opts.dispatch(verb, params, conn);
      });
      // v7: verbs with a bounded async leg (limits fetch before an auto pick,
      // the login seat's keychain baseline) return a promise; sync verbs are
      // answered on the spot exactly as before.
      if (result instanceof Promise) {
        result.then(
          (value) => {
            span.end();
            conn.send({ id, ok: true, result: value });
          },
          (err) => {
            span.end("error");
            conn.send({ id, ok: false, error: toRpcError(err) });
          },
        );
        return;
      }
      span.end();
      conn.send({ id, ok: true, result });
    } catch (err) {
      if (err instanceof RpcError && err.code === "caller_not_trusted") this.refusals.record(err.code, conn.localPeer?.uid ?? null, conn.localPeer?.pid ?? null);
      span.end("error");
      conn.send({ id, ok: false, error: toRpcError(err) });
    }
  }
}

export interface HelloCaller {
  dataDir: string | null;
  expectedInstanceId: string | null | undefined;
  allowForeignDaemon: boolean;
}

function helloCaller(value: unknown): HelloCaller | null | "invalid" {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "invalid";
  const raw = value as Record<string, unknown>;
  if (raw.dataDir !== undefined && (typeof raw.dataDir !== "string" || raw.dataDir.length === 0)) return "invalid";
  if (raw.expectedInstanceId !== undefined && raw.expectedInstanceId !== null && typeof raw.expectedInstanceId !== "string") return "invalid";
  if (raw.allowForeignDaemon !== undefined && typeof raw.allowForeignDaemon !== "boolean") return "invalid";
  return {
    dataDir: typeof raw.dataDir === "string" ? raw.dataDir : null,
    expectedInstanceId: raw.expectedInstanceId as string | null | undefined,
    allowForeignDaemon: raw.allowForeignDaemon === true,
  };
}

export function socketAcceptsConnections(socketPath: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createConnection(socketPath);
    const finish = (live: boolean): void => {
      clearTimeout(timer);
      probe.removeAllListeners();
      probe.on("error", () => undefined);
      probe.destroy();
      resolve(live);
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    probe.once("connect", () => finish(true));
    probe.once("error", (err: NodeJS.ErrnoException) => finish(err.code !== "ECONNREFUSED" && err.code !== "ENOENT" && err.code !== "ENOTSOCK"));
  });
}
