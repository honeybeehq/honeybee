import { privateManagementFile } from "./externalAuthority.ts";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { RpcError } from "./protocol.ts";
import type { PeerConnection } from "./peerCredentials.ts";

export interface LocalTrustConfig { requireObservationCaller: boolean; registrationKeyFile: string }
export interface LocalTrustChallenge {
  workspace?: string;
  challengeId: string;
  nonce: string;
  uid: number;
  pid: number;
  processBirth: string;
  daemonInstanceId: string;
  expiresAtMs: number;
}
export function localTrustMessage(challenge: LocalTrustChallenge): string {
  return JSON.stringify([...(challenge.workspace ? ["hive-external-management-v1", challenge.workspace] : ["hive-local-trust-v1"]), challenge.challengeId, challenge.nonce, challenge.uid, challenge.pid, challenge.processBirth, challenge.daemonInstanceId, challenge.expiresAtMs]);
}
export function verifyManagementChallenge(challenge: LocalTrustChallenge, expected: {uid: number; pid: number; processBirth: string; daemonInstanceId: string; workspace: string}, now = Date.now()): void {
  if (challenge.uid !== expected.uid || challenge.pid !== expected.pid || challenge.processBirth !== expected.processBirth || challenge.daemonInstanceId !== expected.daemonInstanceId || challenge.workspace !== expected.workspace || !Number.isSafeInteger(challenge.expiresAtMs) || challenge.expiresAtMs <= now || challenge.expiresAtMs > now + 60_000 || typeof challenge.nonce !== "string" || challenge.nonce.length !== 43 || typeof challenge.challengeId !== "string" || challenge.challengeId.length !== 36) throw new Error("External management challenge identity mismatch");
}
function refusal(reason: string): never { throw new RpcError("caller_not_trusted", "The local caller is not registered as trusted.", {reason}); }
function privateKey(file: string, root: string, uid: number): Buffer {
  if (!isAbsolute(file)) refusal("registration_key_unavailable");
  const canonicalRoot = realpathSync(root);
  const configuredRoot = resolve(root);
  const absoluteFile = resolve(file);
  const below = (base: string, path: string): boolean => {
    const rel = relative(base, path);
    return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  let boundary = below(configuredRoot, absoluteFile) ? configuredRoot : below(canonicalRoot, absoluteFile) ? canonicalRoot : null;
  if (boundary === null) {
    let candidate = dirname(absoluteFile);
    while (true) {
      try { if (realpathSync(candidate) === canonicalRoot) boundary = candidate; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const parent = dirname(candidate);
      if (parent === candidate) break;
      candidate = parent;
    }
  }
  if (boundary === null) refusal("registration_key_unavailable");
  const rel = relative(boundary, absoluteFile);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) refusal("registration_key_unavailable");
  const canonical = resolve(canonicalRoot, rel);
  const parent = dirname(canonical);
  let cursor = canonicalRoot;
  for (const part of relative(canonicalRoot, parent).split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part);
    try { mkdirSync(cursor, {mode: 0o700}); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const stat = lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o777) !== 0o700) refusal("registration_key_unavailable");
  }
  if (parent === canonicalRoot) {
    const stat = lstatSync(parent);
    if (stat.uid !== uid || (stat.mode & 0o777) !== 0o700) refusal("registration_key_unavailable");
  }
  let fd: number;
  try { fd = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    let created: number | undefined;
    const bytes = randomBytes(32);
    try {
      created = openSync(canonical, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      writeFileSync(created, bytes); fsyncSync(created);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    finally { bytes.fill(0); if (created !== undefined) closeSync(created); }
    const directory = openSync(parent, constants.O_RDONLY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
    fd = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o777) !== 0o600 || stat.size !== 32) refusal("registration_key_unavailable");
    const bytes = readFileSync(fd);
    if (bytes.length !== 32) { bytes.fill(0); refusal("registration_key_unavailable"); }
    return bytes;
  } finally { closeSync(fd); }
}

export class LocalRpcTrust {
  private key: Buffer | null = null;
  private keyUnavailable = false;
  private registration: {uid: number; pid: number; birth: string; expiresAtMs: number} | null = null;
  private readonly challenges = new Map<string, {challenge: LocalTrustChallenge; connection: object; consumed: boolean}>();
  readonly daemonInstanceId = randomUUID();
  private config: LocalTrustConfig;
  private readonly now: () => number;
  private readonly binding?: {workspace: string; daemonInstanceId: string};
  private readonly audit: (kind: string, data: Record<string, unknown>) => void;
  constructor(config: LocalTrustConfig, root: string, audit: (kind: string, data: Record<string, unknown>) => void, now = Date.now, binding?: {workspace: string; daemonInstanceId: string}) {
    this.config = config; this.audit = audit; this.now = now; this.binding = binding;
    this.reload(config, root);
  }
  reload(config: LocalTrustConfig, root: string): void {
    this.close();
    this.config = config;
    this.keyUnavailable = false;
    if (config.requireObservationCaller) {
      try { this.key = this.binding ? privateManagementFile(config.registrationKeyFile, root) : privateKey(config.registrationKeyFile, root, process.geteuid!());
        if (this.key.length !== 32) { this.key.fill(0); this.key = null; throw new Error("Invalid management key"); } }
      catch { this.keyUnavailable = true; }
    }
  }
  get enabled(): boolean { return this.config.requireObservationCaller; }
  get state(): "off" | "ready" | "registration_key_unavailable" { return !this.enabled ? "off" : this.keyUnavailable ? "registration_key_unavailable" : "ready"; }
  private peer(connection: PeerConnection, ingress: string | undefined): Extract<PeerConnection, {state: "verified"}> {
    if (!this.enabled) refusal("trust_disabled");
    if (ingress !== "local_unix") refusal("local_required");
    if (!this.key || this.keyUnavailable) refusal("registration_key_unavailable");
    if (connection.state !== "verified" || !connection.peer.processBirth || !connection.current()) refusal("peer_identity_unavailable");
    return connection;
  }
  challenge(connection: PeerConnection, identity: object, ingress: string | undefined): LocalTrustChallenge {
    const verified = this.peer(connection, ingress);
    const now = this.now();
    for (const [id, value] of this.challenges) if (value.challenge.expiresAtMs <= now) this.challenges.delete(id);
    const ownConnection = [...this.challenges].filter(([, value]) => value.connection === identity);
    for (const [id] of ownConnection.slice(0, Math.max(0, ownConnection.length - 1))) this.challenges.delete(id);
    const ownProcess = [...this.challenges].filter(([, value]) => value.challenge.uid === verified.peer.uid && value.challenge.pid === verified.peer.pid && value.challenge.processBirth === verified.peer.processBirth);
    for (const [id] of ownProcess.slice(0, Math.max(0, ownProcess.length - 3))) this.challenges.delete(id);
    while (this.challenges.size >= 128) {
      const processes = new Map<string, string[]>();
      for (const [id, value] of this.challenges) {
        const key = JSON.stringify([value.challenge.uid, value.challenge.pid, value.challenge.processBirth]);
        const ids = processes.get(key) ?? [];
        ids.push(id); processes.set(key, ids);
      }
      let largest: string[] = [];
      for (const ids of processes.values()) if (ids.length > largest.length) largest = ids;
      this.challenges.delete(largest[0]!);
    }
    const challenge = {...(this.binding ? {workspace: this.binding.workspace} : {}), challengeId: randomUUID(), nonce: randomBytes(32).toString("base64url"), uid: verified.peer.uid, pid: verified.peer.pid, processBirth: verified.peer.processBirth!, daemonInstanceId: this.binding?.daemonInstanceId ?? this.daemonInstanceId, expiresAtMs: now + 60_000};
    this.challenges.set(challenge.challengeId, {challenge, connection: identity, consumed: false});
    return challenge;
  }
  register(params: Record<string, unknown>, connection: PeerConnection, identity: object, ingress: string | undefined): {registered: true; uid: number; pid: number; expiresAtMs: number} {
    const verified = this.peer(connection, ingress);
    if (Object.keys(params).some(key => !["pid", "challengeId", "token"].includes(key)) || params.pid !== verified.peer.pid || typeof params.challengeId !== "string" || typeof params.token !== "string" || !/^[a-f0-9]{64}$/.test(params.token)) refusal("invalid_registration");
    const entry = this.challenges.get(params.challengeId);
    if (!entry) refusal("challenge_unknown");
    if (entry.consumed) refusal("challenge_consumed");
    if (entry.challenge.expiresAtMs <= this.now()) refusal("challenge_expired");
    if (entry.connection !== identity) refusal("challenge_connection_mismatch");
    entry.consumed = true;
    const challenge = entry.challenge;
    if (challenge.uid !== verified.peer.uid || challenge.pid !== verified.peer.pid || challenge.processBirth !== verified.peer.processBirth) refusal("peer_identity_changed");
    const expected = createHmac("sha256", this.key!).update(localTrustMessage(challenge)).digest();
    const supplied = Buffer.from(params.token, "hex");
    const valid = timingSafeEqual(expected, supplied);
    expected.fill(0); supplied.fill(0);
    if (!valid) refusal("invalid_token");
    const previous = this.registration;
    this.registration = {uid: verified.peer.uid, pid: verified.peer.pid, birth: verified.peer.processBirth!, expiresAtMs: this.now() + 300_000};
    this.audit("rpc.local_registered", {uid: verified.peer.uid, pid: verified.peer.pid, replacedPid: previous?.pid ?? null, expiresAtMs: this.registration.expiresAtMs});
    return {registered: true, uid: verified.peer.uid, pid: verified.peer.pid, expiresAtMs: this.registration.expiresAtMs};
  }
  require(connection: PeerConnection, ingress: string | undefined): void {
    if (!this.enabled) return;
    const verified = this.peer(connection, ingress);
    const registered = this.registration;
    if (!registered || registered.expiresAtMs <= this.now() || registered.uid !== verified.peer.uid || registered.pid !== verified.peer.pid || registered.birth !== verified.peer.processBirth) refusal("registration_required");
  }
  disconnect(identity: object): void { for (const [id, entry] of this.challenges) if (entry.connection === identity) this.challenges.delete(id); }
  close(): void { this.key?.fill(0); this.key = null; this.registration = null; this.challenges.clear(); }
}
