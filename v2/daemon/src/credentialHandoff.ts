import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, openSync, fsyncSync, closeSync } from "node:fs";
import { join } from "node:path";
import type { AccountRow, CoreStore, CredentialHandoffBinding, CredentialHandoffIdentity, CredentialHandoffReceipt, CredentialHandoffRecord } from "../../core/src/index.ts";
import type { AccountsService } from "./accountsService.ts";
import { CredentialAuthorityError, type AuthorityDocument } from "./claudeCredentialAuthority.ts";
import { atomicWriteFileSync } from "./homeDefaults.ts";
import { RpcError } from "./protocol.ts";

function name(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_+/-][a-zA-Z0-9._@:+/=-]{0,511}$/.test(value)) throw new RpcError("invalid_request", "Handoff requires bounded identifiers.");
  return value;
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new RpcError("invalid_request", "Handoff requires nonnegative integer metadata.");
  return Number(value);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RpcError("invalid_request", "Handoff requires an object.");
  return value as Record<string, unknown>;
}
function identity(value: unknown): CredentialHandoffIdentity {
  const input = object(value);
  return { nodeId: name(input.nodeId), deviceKey: name(input.deviceKey) };
}
function binding(value: unknown): CredentialHandoffBinding {
  const input = object(value);
  return { handoffId: name(input.handoffId), sourceAccount: name(input.sourceAccount), harness: name(input.harness),
    generation: integer(input.generation), epoch: integer(input.epoch), from: identity(input.from), to: identity(input.to),
    sourceKey: name(input.sourceKey), materialDigest: name(input.materialDigest), since: integer(input.since), prepareBy: integer(input.prepareBy),
    claimId: input.claimId === null ? null : name(input.claimId), targetAccount: input.targetAccount === null ? null : name(input.targetAccount), targetKey: input.targetKey === null ? null : name(input.targetKey) };
}
function unsigned(value: CredentialHandoffReceipt): Buffer {
  return Buffer.from(JSON.stringify({ kind: value.kind, binding: value.binding }));
}
function receipt(value: unknown): CredentialHandoffReceipt {
  const input = object(value);
  if (!["export", "prepared", "commit", "adopted", "aborted", "stand_down", "operator_takeover", "operator_taken_down", "operator_refused"].includes(String(input.kind))) throw new RpcError("invalid_request", "Unknown handoff receipt kind.");
  return { kind: input.kind as CredentialHandoffReceipt["kind"], binding: binding(input.binding), signature: name(input.signature) };
}
function check(receipt: CredentialHandoffReceipt, kind: CredentialHandoffReceipt["kind"], key: string): void {
  let valid = false;
  try {
    const publicKey = createPublicKey({ key: Buffer.from(key, "base64"), format: "der", type: "spki" });
    valid = publicKey.asymmetricKeyType === "ed25519" && verify(null, unsigned(receipt), publicKey, Buffer.from(receipt.signature, "base64"));
  } catch {}
  if (receipt.kind !== kind || !valid) throw new RpcError("credential_handoff_conflict", "Handoff receipt signature or kind does not match the prepared authority.");
}
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function exported(value: CredentialHandoffBinding): CredentialHandoffBinding { return { ...value, claimId: null, targetAccount: null, targetKey: null }; }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
function digest(document: Record<string, unknown>): string { return createHash("sha256").update(JSON.stringify(canonical(document))).digest("hex"); }

export class CredentialHandoffService {
  private readonly store: CoreStore;
  private readonly accounts: AccountsService;
  private readonly root: string;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private reconciling = false;
  private activeLanes = 0;
  private identityReplacing = false;
  private lastSweepAt = 0;
  constructor(store: CoreStore, accounts: AccountsService, root: string, now: () => number, log: (message: string) => void) {
    this.store = store; this.accounts = accounts; this.root = root; this.now = now; this.log = log;
  }

  async setIdentity(params: Record<string, unknown>) {
    if (this.identityReplacing) throw new RpcError("credential_handoff_fenced", "Workstation identity replacement is in progress.");
    const current = this.store.credentialHandoffIdentity(), supplied = identity(params.identity);
    if (current && same(current, supplied)) return { identity: supplied, publicKey: this.publicKey(), abortedExports: [], voidedAdoptions: [] };
    if (current && params.replace !== true) throw new RpcError("credential_handoff_conflict", "Workstation identity is already pinned; use handoff-identity-set --replace explicitly to void unclaimed work before re-pairing.");
    const rows = this.store.listCredentialHandoffs();
    if (this.activeLanes || rows.some(row => row.role === "source" && ["prepared", "committed"].includes(row.state) || row.role === "destination" && row.state === "adopting")) throw new RpcError("credential_handoff_fenced", "Finish or explicitly recover committed handoffs and provider-started adoption before replacing workstation identity.");
    const abortedExports: string[] = [], voidedAdoptions: string[] = [];
    this.identityReplacing = true;
    try {
    if (params.replace === true) {
      for (const row of rows.filter(row => row.role === "source" && row.state === "exported")) {
        const account = this.account(row.account);
        await this.lane(account, `identity-abort:${row.handoffId}`, async () => {
          const current = this.row(row.handoffId, "source"), authority = this.accounts.authorityFor(account)!.status(account)!;
          this.store.putCredentialHandoff({ ...current, state: "aborted", receipt: this.signed("aborted", exported(current.binding)) }, { ...authority, phase: "ready" });
        });
        abortedExports.push(row.handoffId);
      }
      for (const row of rows.filter(row => row.role === "destination" && (["preparing", "prepared"].includes(row.state) || row.state === "aborted" && !row.scrubbed))) {
        const account = this.account(row.account);
        await this.lane(account, `identity-void:${row.handoffId}`, async () => {
          const terminal = this.put(this.row(row.handoffId, "destination"), "aborted", { receipt: null });
          this.accounts.authorityFor(account)!.forgetHandoffAdoption(account);
          this.put(terminal, "aborted", { scrubbed: true });
        });
        voidedAdoptions.push(row.handoffId);
      }
    } else if (rows.some(row => !["aborted", "confirmed", "failed", "adopted", "stood_down"].includes(row.state))) {
      throw new RpcError("credential_handoff_fenced", "Existing handoff work requires explicit --replace when enrolling workstation identity.");
    }
    this.store.setCredentialHandoffIdentity(supplied);
    return { identity: supplied, publicKey: this.publicKey(), abortedExports, voidedAdoptions };
    } finally { this.identityReplacing = false; }
  }
  private self(): CredentialHandoffIdentity {
    if (this.identityReplacing) throw new RpcError("credential_handoff_fenced", "Workstation identity replacement is in progress.");
    const current = this.store.credentialHandoffIdentity();
    if (!current) throw new RpcError("credential_handoff_unavailable", "Apiary must install this workstation's authenticated identity before handoff.");
    return current;
  }
  private assertSelf(expected: CredentialHandoffIdentity): void {
    if (!same(this.self(), expected)) throw new RpcError("credential_handoff_conflict", "Receipt is addressed to another workstation.");
  }

  private key() {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const path = join(this.root, "handoff-signing-key.pem");
    if (!existsSync(path)) {
      const pair = generateKeyPairSync("ed25519");
      atomicWriteFileSync(path, pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    }
    const key = createPrivateKey(readFileSync(path));
    for (const file of readdirSync(this.root)) if (file.startsWith("handoff-signing-key.pem.tmp.")) unlinkSync(join(this.root, file));
    const directory = openSync(this.root, "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
    return key;
  }
  private publicKey(): string { return createPublicKey(this.key()).export({ type: "spki", format: "der" }).toString("base64"); }
  private signed(kind: CredentialHandoffReceipt["kind"], binding: CredentialHandoffBinding): CredentialHandoffReceipt {
    const result: CredentialHandoffReceipt = { kind, binding, signature: "" };
    result.signature = sign(null, unsigned(result), this.key()).toString("base64");
    return result;
  }
  private row(id: string, role: CredentialHandoffRecord["role"]): CredentialHandoffRecord {
    const row = this.store.getCredentialHandoff(id, role);
    if (!row) throw new RpcError("credential_handoff_not_found", "Credential handoff does not exist on this daemon.");
    return row;
  }
  private account(id: unknown): AccountRow {
    const row = this.store.getAccount(name(id));
    if (!row) throw new RpcError("account_not_found", "Handoff account must be registered on this daemon.");
    if (!this.accounts.authorityFor(row)) throw new RpcError("credential_handoff_unsupported", "The account harness has no central credential authority.");
    return row;
  }
  private put(row: CredentialHandoffRecord, state: CredentialHandoffRecord["state"], changes: Partial<CredentialHandoffRecord> = {}): CredentialHandoffRecord {
    return this.store.putCredentialHandoff({ ...row, ...changes, state });
  }
  private result(row: CredentialHandoffRecord) {
    return { handoffId: row.handoffId, state: row.state, generation: row.generation, expiresAt: row.expiresAt, receipt: row.receipt,
      ...(row.releasePeer ? { releasePeer: row.releasePeer } : {}),
      cleanupPending: row.releasePeer?.cleanupPending ?? (row.role === "destination" && ["failed", "aborted"].includes(row.state) && !row.scrubbed) };
  }
  private async lane<T>(account: AccountRow, id: string, run: () => Promise<T>): Promise<T> {
    if (this.identityReplacing && !id.startsWith("identity-")) throw new RpcError("credential_handoff_fenced", "Workstation identity replacement holds credential handoff.");
    this.accounts.assertLeaseWriteIdle(account.id);
    this.activeLanes++;
    try { return await this.accounts.authorityFor(account)!.handoffLane(account, id, run); }
    catch (error) {
      if (error instanceof RpcError) throw error;
      if (error instanceof CredentialAuthorityError) throw new RpcError("credential_handoff_unavailable", "Credential handoff cannot proceed; inspect credential status and finish the current ownership operation.");
      throw new RpcError("credential_handoff_unavailable", "Credential handoff storage or publication failed; retry after resolving storage access.");
    } finally { this.activeLanes--; }
  }

  async export(params: Record<string, unknown>) {
    const account = this.account(params.account);
    const handoffId = name(params.handoffId), from = identity(params.from), to = identity(params.to), epoch = integer(params.epoch);
    this.assertSelf(from);
    if (account.source === "leased" || from.nodeId === to.nodeId || epoch <= this.store.credentialAuthorityEpoch(account.id)) throw new RpcError("credential_handoff_conflict", "Handoff requires a local authority, a different peer and a higher destination epoch.");
    return this.lane(account, `export:${handoffId}`, async () => {
      const authority = this.accounts.authorityFor(account)!;
      const existing = this.store.getCredentialHandoff(handoffId, "source");
      if (existing) {
        if (existing.account !== account.id || !same(existing.binding.from, from) || !same(existing.binding.to, to) || existing.binding.epoch !== epoch) throw new RpcError("credential_handoff_conflict", "Handoff id is already bound to a different request.");
        if (existing.state !== "exported") throw new RpcError("credential_handoff_decided", "Handoff is already decided; exported refresh material cannot be fetched again.");
        const document = authority.document(account);
        if (digest(document) !== existing.binding.materialDigest) throw new RpcError("credential_handoff_conflict", "Exported authority material changed.");
        return { receipt: this.signed("export", exported(existing.binding)), material: { generation: existing.binding.generation, document } };
      }
      if (this.store.activeCredentialHandoff(account.id)) throw new RpcError("credential_handoff_fenced", "Another credential handoff holds this account.");
      const { state, value } = await authority.inspectHandoffExport(account);
      const ttlMs = params.ttlMs === undefined ? 300_000 : integer(params.ttlMs);
      if (ttlMs < 1000 || ttlMs > 600_000) throw new RpcError("invalid_request", "Export preparation TTL must be between one second and ten minutes.");
      const since = this.now();
      const bound: CredentialHandoffBinding = { handoffId, sourceAccount: account.id, harness: account.harness, generation: value.generation, epoch, from, to,
        sourceKey: this.publicKey(), materialDigest: digest(value.document), since, prepareBy: since + ttlMs, claimId: null, targetAccount: null, targetKey: null };
      const signed = this.signed("export", bound);
      this.store.putCredentialHandoff({ handoffId, role: "source", account: account.id, state: "exported", binding: bound, receipt: signed, generation: null, expiresAt: null }, { ...state, phase: "handing_off" });
      return { receipt: signed, material: { generation: value.generation, document: value.document } };
    });
  }

  async adoptPrepare(params: Record<string, unknown>) {
    const account = this.account(params.account), signed = receipt(params.exportReceipt);
    const from = identity(params.from), to = identity(params.to), handoffId = name(params.handoffId), epoch = integer(params.epoch);
    this.assertSelf(to);
    if (!same(from, identity(params.authenticatedPeer))) throw new RpcError("credential_handoff_conflict", "Export source differs from the authenticated lane peer.");
    const bound = signed.binding;
    const sourceKey = name(params.sourceKey);
    check(signed, "export", sourceKey);
    if (bound.sourceKey !== sourceKey || bound.handoffId !== handoffId || bound.harness !== account.harness || bound.epoch !== epoch || !same(bound.from, from) || !same(bound.to, to) || bound.claimId !== null) throw new RpcError("credential_handoff_conflict", "Export receipt differs from the authenticated peer binding.");
    const material = object(params.material), document = object(material.document);
    if (JSON.stringify(document).length > 1_048_576 || integer(material.generation) !== bound.generation || digest(document) !== bound.materialDigest) throw new RpcError("credential_handoff_conflict", "Handoff material differs from the signed export.");
    return this.lane(account, `prepare:${handoffId}`, async () => {
      const authority = this.accounts.authorityFor(account)!;
      let row = this.store.getCredentialHandoff(handoffId, "destination");
      if (row) {
        if (row.account !== account.id || !same(exported(row.binding), bound)) throw new RpcError("credential_handoff_conflict", "Handoff id is already bound to other material or peer.");
        if (!["preparing", "prepared", "adopting", "adopted"].includes(row.state)) throw new RpcError("credential_handoff_decided", "Prepared adoption is terminal and cannot be replayed.");
        if (row.state !== "preparing" && row.state !== "prepared") return this.result(row);
      } else {
        this.accounts.assertHandoffAdoptable(account);
        if (epoch <= this.store.credentialAuthorityEpoch(account.id)) throw new RpcError("credential_handoff_stale_epoch", "Adoption requires a higher destination authority epoch.");
        if (account.source === "leased" && (account.leasedFrom?.authorityNodeId !== from.nodeId || epoch <= account.leasedFrom.epoch)) throw new RpcError("credential_handoff_conflict", "Prepared adoption must come from the lease authority at a higher epoch.");
        if (this.store.activeCredentialHandoff(account.id)) throw new RpcError("credential_handoff_fenced", "Another credential handoff holds this account.");
        const prepared = { ...bound, claimId: randomUUID(), targetAccount: account.id, targetKey: this.publicKey() };
        row = this.store.putCredentialHandoff({ handoffId, role: "destination", account: account.id, state: "preparing", binding: prepared,
          receipt: null, generation: null, expiresAt: null });
      }
      if (!authority.status(account) || authority.status(account)?.phase === "disabled") authority.prepareHandoffAdoption(account, { generation: bound.generation, operationKey: null, document });
      else if (authority.status(account)?.phase === "adopting") {
        try { authority.document(account); }
        catch { authority.prepareHandoffAdoption(account, { generation: bound.generation, operationKey: null, document }); }
      }
      if (row.state === "preparing") row = this.put(row, "prepared", { receipt: this.signed("prepared", row.binding) });
      return this.result(row);
    });
  }

  async exportPrepare(params: Record<string, unknown>) {
    const handoffId = name(params.handoffId), prepared = receipt(params.preparedReceipt);
    const row = this.row(handoffId, "source"), account = this.account(row.account);
    return this.lane(account, `source-prepare:${handoffId}`, async () => {
      const current = this.row(handoffId, "source");
      if (!prepared.binding.targetKey || !prepared.binding.claimId || !prepared.binding.targetAccount) throw new RpcError("invalid_request", "Preparation must name its claim and destination authority.");
      const targetKey = name(params.targetKey), authenticatedPeer = identity(params.authenticatedPeer);
      if (!same(authenticatedPeer, current.binding.to) || prepared.binding.targetKey !== targetKey) throw new RpcError("credential_handoff_conflict", "Preparation differs from the authenticated destination key.");
      check(prepared, "prepared", targetKey);
      if (!same(exported(prepared.binding), exported(current.binding))) throw new RpcError("credential_handoff_conflict", "Prepared peer or material does not match this export.");
      if (current.state !== "exported") {
        if (["prepared", "committed", "confirmed"].includes(current.state) && same(current.binding, prepared.binding)) return this.result(current);
        throw new RpcError("credential_handoff_decided", "Export is already decided or bound to another claim.");
      }
      if (this.now() >= current.binding.prepareBy) throw new RpcError("credential_handoff_expired", "Export preparation TTL expired; abort and begin a new handoff.");
      return this.result(this.put(current, "prepared", { binding: prepared.binding, receipt: prepared }));
    });
  }

  async exportCommit(params: Record<string, unknown>) {
    const handoffId = name(params.handoffId), claimId = name(params.claimId), row = this.row(handoffId, "source"), account = this.account(row.account);
    return this.lane(account, `commit:${handoffId}`, async () => {
      const current = this.row(handoffId, "source");
      if (current.binding.claimId !== claimId) throw new RpcError("credential_handoff_conflict", "Commit claim differs from the durable preparation.");
      if (["committed", "confirmed"].includes(current.state)) return this.result(current);
      if (current.state !== "prepared") throw new RpcError("credential_handoff_decided", "Only a prepared export can commit.");
      return this.result(this.put(current, "committed", { receipt: this.signed("commit", current.binding) }));
    });
  }

  async adopt(params: Record<string, unknown>) {
    const account = this.account(params.account), handoffId = name(params.handoffId), commit = receipt(params.commitReceipt);
    return this.lane(account, `adopt:${handoffId}`, async () => {
      if (this.store.credentialRecoveryPending(account.id)) throw new RpcError("credential_handoff_fenced", "Signed recovery holds this account; complete or cancel it before adoption.");
      let row = this.row(handoffId, "destination");
      this.assertSelf(row.binding.to);
      check(commit, "commit", row.binding.sourceKey);
      if (row.account !== account.id || !same(commit.binding, row.binding)) throw new RpcError("credential_handoff_conflict", "Commit receipt differs from the durable preparation.");
      if (row.releasePeer) throw new RpcError("credential_handoff_decided", "Removed-peer release made this claim terminal; publish the new authority epoch instead.");
      if (row.state === "adopted") return this.result(row);
      if (row.state === "failed") {
        const cleaned = row.scrubbed || await this.cleanupDestination(row);
        throw new RpcError("credential_handoff_rejected", this.recovery(account), { sourceDisposition: "committed_fenced", destinationDisposition: cleaned ? "not_enabled" : "cleanup_pending" });
      }
      if (!["prepared", "adopting"].includes(row.state)) throw new RpcError("credential_handoff_decided", "Adoption is already terminal.");
      row = this.put(row, "adopting", { receipt: commit });
      const authority = this.accounts.authorityFor(account)!;
      try {
        const state = await authority.rotateHandoffAdoption(account, row.binding.claimId!, row.binding.generation);
        const adopted = { ...row, state: "adopted" as const, generation: state.generation, expiresAt: state.expiresAt, receipt: this.signed("adopted", row.binding) };
        this.store.completeCredentialAdoption(adopted);
        return this.result(adopted);
      } catch (error) {
        if (authority.status(account)?.phase === "login_required" && authority.status(account)?.failure?.error === "invalid_token_response") throw new RpcError("credential_handoff_unusable_access", "The provider returned malformed access expiry; the replacement chain is retained privately and automatic rotation is stopped. Stand down this destination at a higher epoch before native recovery on a local account, and keep the source fenced until that explicit takeover.", { sourceDisposition: "committed_fenced", destinationDisposition: "login_required_retained" });
        if (authority.status(account)?.phase === "login_required") {
          const failed = this.put(row, "failed");
          const cleaned = await this.cleanupDestination(failed);
          throw new RpcError("credential_handoff_rejected", this.recovery(account), { sourceDisposition: "committed_fenced", destinationDisposition: cleaned ? "not_enabled" : "cleanup_pending" });
        }
        if (authority.status(account)?.phase === "uncertain") throw new RpcError("credential_handoff_uncertain", "Adoption outcome is uncertain; retained refresh material stays private and the source remains committed and fenced.", { sourceDisposition: "committed_fenced", destinationDisposition: "uncertain" });
        throw error;
      }
    });
  }

  async exportAbort(params: Record<string, unknown>) {
    const handoffId = name(params.handoffId), row = this.row(handoffId, "source"), account = this.account(row.account);
    return this.lane(account, `abort:${handoffId}`, async () => {
      const current = this.row(handoffId, "source");
      if (current.state === "aborted") return this.result(current);
      if (current.state !== "exported") throw new RpcError("credential_handoff_decided", "Prepared or committed export cannot abort; explicit operator takeover is required.");
      const authority = this.accounts.authorityFor(account)!.status(account)!;
      return this.result(this.store.putCredentialHandoff({ ...current, state: "aborted", receipt: this.signed("aborted", exported(current.binding)) }, { ...authority, phase: "ready" }));
    });
  }

  async adoptAbort(params: Record<string, unknown>) {
    const handoffId = name(params.handoffId), aborted = receipt(params.abortReceipt);
    const row = this.row(handoffId, "destination"), account = this.account(row.account);
    return this.lane(account, `destination-abort:${handoffId}`, async () => {
      const current = this.row(handoffId, "destination");
      check(aborted, "aborted", current.binding.sourceKey);
      if (!same(exported(current.binding), aborted.binding)) throw new RpcError("credential_handoff_conflict", "Abort receipt differs from the prepared export.");
      if (current.state === "aborted") {
        if (!current.scrubbed) { this.accounts.authorityFor(account)!.forgetHandoffAdoption(account); this.put(current, "aborted", { scrubbed: true }); }
        return this.result(current);
      }
      if (!["preparing", "prepared"].includes(current.state)) throw new RpcError("credential_handoff_decided", "A started adoption cannot abort.");
      const terminal = this.put(current, "aborted", { receipt: aborted });
      this.accounts.authorityFor(account)!.forgetHandoffAdoption(account);
      return this.result(this.put(terminal, "aborted", { scrubbed: true }));
    });
  }

  async exportConfirm(params: Record<string, unknown>) {
    const handoffId = name(params.handoffId), row = this.row(handoffId, "source"), account = this.account(row.account);
    const adopted = receipt(params.adoptedReceipt);
    return this.lane(account, `confirm:${handoffId}`, async () => {
      const current = this.row(handoffId, "source");
      check(adopted, "adopted", current.binding.targetKey!);
      if (!same(current.binding, adopted.binding)) throw new RpcError("credential_handoff_conflict", "Adoption receipt does not match the committed destination.");
      if (current.state === "confirmed") return this.result(current);
      if (current.releasePeer) throw new RpcError("credential_handoff_fenced", "Release-peer holds this handoff; reconcile its retained result before confirmation.");
      if (current.state !== "committed") throw new RpcError("credential_handoff_decided", "Only a committed export can be confirmed.");
      await this.accounts.scrubHandoff(account);
      this.store.demoteCredentialAuthority(account.id, current.binding.epoch);
      return this.result(this.put(current, "confirmed"));
    });
  }

  standDownReceipt(params: Record<string, unknown>) {
    const account = this.account(params.account), to = identity(params.to), epoch = integer(params.epoch);
    if (epoch < this.store.credentialAuthorityEpoch(account.id)) throw new RpcError("credential_handoff_stale_epoch", "Stand-down authorization cannot precede the issuing authority epoch.");
    const state = this.accounts.authorityFor(account)!.status(account);
    if (state?.phase !== "ready" || this.store.activeCredentialHandoff(account.id)) throw new RpcError("credential_handoff_unavailable", "A healthy central authority must authorize stand-down.");
    const id = randomUUID();
    const bound: CredentialHandoffBinding = { handoffId: id, sourceAccount: name(params.targetAccount), harness: account.harness,
      generation: integer(params.targetGeneration), epoch, from: this.self(), to, sourceKey: this.publicKey(), materialDigest: "stand-down",
      since: this.now(), prepareBy: 0, claimId: id, targetAccount: account.id, targetKey: null };
    return { receipt: this.signed("stand_down", bound) };
  }

  async standDown(params: Record<string, unknown>) {
    const account = this.account(params.account), epoch = integer(params.epoch), authorization = receipt(params.standDownReceipt);
    const authorityKey = name(params.authorityKey), authenticatedPeer = identity(params.authenticatedPeer);
    check(authorization, "stand_down", authorityKey);
    const bound = authorization.binding;
    this.assertSelf(bound.to);
    if (bound.sourceAccount !== account.id || bound.harness !== account.harness || bound.epoch !== epoch || bound.sourceKey !== authorityKey || !same(bound.from, authenticatedPeer) || bound.from.nodeId === bound.to.nodeId || bound.materialDigest !== "stand-down") throw new RpcError("credential_handoff_conflict", "Stand-down authorization differs from the authenticated authority and target.");
    return this.lane(account, `stand-down:${bound.handoffId}`, async () => {
      const existing = this.store.getCredentialHandoff(bound.handoffId, "source");
      if (existing && (!same(existing.binding, bound) || existing.receipt?.signature !== authorization.signature)) throw new RpcError("credential_handoff_conflict", "Stand-down receipt is already bound to another operation.");
      if (existing?.state === "stood_down") return { account: account.id, epoch, disposition: "stood_down", providerCalled: false };
      const floor = this.store.credentialAuthorityEpoch(account.id);
      if (epoch < floor || epoch === floor && !(existing && this.store.credentialAuthorityIsDemoted(account.id))) throw new RpcError("credential_handoff_stale_epoch", "Stand-down requires a higher authority epoch.");
      const state = this.accounts.authorityFor(account)!.status(account);
      if (!existing && state && state.phase !== "disabled" && state.generation !== bound.generation) throw new RpcError("credential_handoff_conflict", "Stand-down authorization names another refresh generation.");
      this.noRunningBees(account);
      const operation = existing ?? this.store.putCredentialHandoff({ handoffId: bound.handoffId, role: "source", account: account.id, state: "committed", binding: bound, receipt: authorization, generation: null, expiresAt: null });
      await this.accounts.scrubHandoff(account);
      this.store.demoteCredentialAuthority(account.id, epoch);
      this.finishTakeoverRows(account, operation.handoffId);
      this.put(operation, "stood_down");
      return { account: account.id, epoch, disposition: "stood_down", providerCalled: false };
    });
  }

  private noRunningBees(account: AccountRow): void {
    if (this.store.beesOnAccount(account.id).some(bee => {
      const runtime = this.store.currentRuntime(bee.id);
      return runtime !== null && runtime.state !== "stopped";
    })) throw new RpcError("credential_handoff_fenced", "Stop every running bee on the take-over account before explicit recovery.");
    if (this.store.activeLoginFlow(account.id)) throw new RpcError("credential_handoff_fenced", "Finish or cancel the account login before explicit recovery.");
  }
  private finishTakeoverRows(account: AccountRow, except: string): void {
    for (const row of this.store.listCredentialHandoffs().filter(row => row.account === account.id && row.handoffId !== except && !["stood_down", "confirmed"].includes(row.state))) {
      if (["aborted", "failed"].includes(row.state)) { if (!row.scrubbed) this.put(row, row.state, { scrubbed: true }); }
      else this.put(row, "stood_down");
    }
  }
  private takeoverEpoch(account: AccountRow, bound: CredentialHandoffBinding, existing: CredentialHandoffRecord | null): void {
    const floor = this.store.credentialAuthorityEpoch(account.id);
    if (bound.epoch < floor || bound.epoch === floor && !(existing && this.store.credentialAuthorityIsDemoted(account.id))) throw new RpcError("credential_handoff_stale_epoch", "Explicit takeover requires an epoch above both workstation authority floors.");
  }

  async releasePeer(params: Record<string, unknown>) {
    const account = this.account(params.account);
    if (params.confirm !== true || params.nativeRecovery !== undefined && typeof params.nativeRecovery !== "boolean" || params.useRetainedChain !== undefined && typeof params.useRetainedChain !== "boolean" || params.nativeRecovery === true && params.useRetainedChain === true || params.retainedGeneration !== undefined && params.useRetainedChain !== true || params.discardRetainedChain !== undefined && typeof params.discardRetainedChain !== "boolean" || params.discardRetainedChain === true && (params.nativeRecovery === true || params.useRetainedChain === true)) throw new RpcError("invalid_request", "Release-peer requires explicit operator confirmation and a boolean native recovery option.");
    const supplied = object(params.roster);
    const strings = (value: unknown, limit: number) => {
      if (!Array.isArray(value) || value.length > limit) throw new RpcError("invalid_request", "Release-peer requires a bounded validated roster.");
      const values = value.map(name);
      if (new Set(values).size !== values.length) throw new RpcError("invalid_request", "Release-peer roster entries must be unique.");
      return values.sort();
    };
    const roster = { orgId: name(supplied.orgId), genesis: name(supplied.genesis), heads: strings(supplied.heads, 1024), version: name(supplied.version),
      authorNodeId: name(supplied.authorNodeId), authorCounter: integer(supplied.authorCounter), members: strings(supplied.members, 4096) };
    if (!/^[a-f0-9]{64}$/.test(roster.genesis) || !roster.heads.length || roster.heads.some(head => !/^[a-f0-9]{64}$/.test(head)) || roster.version !== createHash("sha256").update(JSON.stringify([roster.orgId, roster.genesis, roster.heads])).digest("hex")) throw new RpcError("invalid_request", "Release-peer roster version must identify its validated membership heads.");
    const self = this.self();
    if (roster.authorNodeId !== self.nodeId || !roster.members.includes(self.nodeId)) throw new RpcError("credential_handoff_conflict", "Release-peer requires this workstation's authenticated current roster fact.");
    const candidates = this.store.listCredentialHandoffs().filter(row => row.account === account.id && (["prepared", "committed", "adopting", "adopted", "failed"].includes(row.state) || row.releasePeer));
    const active = candidates.filter(row => !row.releasePeer && ["prepared", "committed", "adopting", "adopted", "failed"].includes(row.state));
    const selected = active.length === 1 ? active[0] : candidates.length === 1 ? candidates[0] : null;
    if (params.handoffId === undefined && !selected) throw new RpcError("invalid_request", "Select the original handoff id when release-peer history is ambiguous.");
    const handoffId = params.handoffId === undefined ? selected!.handoffId : name(params.handoffId);
    return this.lane(account, `release-peer:${handoffId}`, async () => {
      const found = this.store.getCredentialHandoff(handoffId, "source") ?? this.store.getCredentialHandoff(handoffId, "destination");
      if (!found) throw new RpcError("credential_handoff_decided", "The original handoff is unavailable.");
      let row: CredentialHandoffRecord = found;
      this.assertSelf(row.role === "source" ? row.binding.from : row.binding.to);
      if (row.account !== account.id || roster.members.includes((row.role === "source" ? row.binding.to : row.binding.from).nodeId)) throw new RpcError("credential_handoff_conflict", "The committed handoff peer is still an organization member or names another account.");
      if (row.releasePeer && !same(row.releasePeer.roster, roster)) throw new RpcError("credential_handoff_conflict", "Release-peer retry must retain the original authenticated roster fact.");
      if (row.role === "source" && row.releasePeer && ((row.releasePeer.retainedUnusableCount ?? 0) > 0)) return this.releaseDestination(account, row, roster, params.nativeRecovery === true, params.useRetainedChain === true, params.retainedGeneration === undefined ? undefined : integer(params.retainedGeneration), params.discardRetainedChain === true);
      if (row.role === "destination") return this.releaseDestination(account, row, roster, params.nativeRecovery === true, params.useRetainedChain === true, params.retainedGeneration === undefined ? undefined : integer(params.retainedGeneration), params.discardRetainedChain === true);
      if (params.useRetainedChain === true || params.discardRetainedChain === true) throw new RpcError("invalid_request", "Retained-chain recovery is destination-only.");
      const firstAttempt = !row.releasePeer;
      if (firstAttempt && (!["prepared", "committed"].includes(row.state) || !["prepared", "commit"].includes(row.receipt?.kind ?? "") || account.source === "leased")) throw new RpcError("credential_handoff_decided", "Release-peer requires this computer's prepared or committed source handoff.");
      const reply = (current: CredentialHandoffRecord, providerCalled: boolean) => {
        const release = current.releasePeer!;
        const message = release.outcome === "retained_unusable" ? `The rotated chain for ${account.id} is retained at generation ${release.retainedGeneration}, but access is unusable. Explicit recovery: hive account credentials release-peer ${account.id} --confirm --file authenticated-roster.json --handoff-id ${handoffId} --use-retained-chain --retained-generation ${release.retainedGeneration}. Replaying the previous request makes no provider call.` : release.outcome === "restored" ? `Authority restored for ${account.id}. Apiary must publish the account authority record at epoch ${release.requiredEpoch} before installing or renewing leases.${release.mode === "prepared_abort" ? ` The removed computer may still hold copied refresh material for account ${account.id}; this abort does not sign it out at the provider. The source's next refresh invalidates that copied refresh token.` : ""}`
          : release.outcome === "login_required" ? `Native login required for ${account.id} on this computer. The removed computer ${release.nativeRecovery ? "may still hold" : "still holds"} a working login for account ${account.id} until it is signed out at the provider.`
          : release.retryable ? `The provider did not consume the refresh token for ${account.id}; retry this explicitly confirmed release-peer request with its original roster fact.`
          : `Release-peer outcome is unknown for ${account.id}; retained credential material remains private. Do not retry the provider blindly. Use explicit release-peer --native-recovery for native login only if no saved replacement exists.`;
        return { account: account.id, handoffId, disposition: release.outcome === "retained_unusable" ? "retained_unusable" : release.outcome === "restored" ? release.mode === "prepared_abort" ? "prepared_aborted" : "source_rotated" : release.outcome === "login_required" ? "native_login_required" : "uncertain", abortReceipt: release.outcome === "restored" ? current.receipt : null, outcome: release.outcome, requiredEpoch: release.requiredEpoch, generation: current.generation, expiresAt: current.expiresAt, providerCalled, message, cleanupPending: release.cleanupPending, retryable: release.retryable === true, rotationScheduled: release.earlyRotationPending === true, retainedGeneration: release.retainedGeneration ?? null, retainedUnusableCount: release.retainedUnusableCount ?? 0, failureReason: release.failureReason ?? null, cappedRetainedDiscardAvailable: release.failureReason === "retained_unusable_limit" && !release.discardRetainedChain };
      };
      if (params.nativeRecovery === true && row.releasePeer?.outcome !== "uncertain" && !row.releasePeer?.nativeRecovery) throw new RpcError("credential_handoff_decided", "Native recovery is only available after an uncertain release-peer outcome.");
      if (row.releasePeer && ["restored", "login_required"].includes(row.releasePeer.outcome) && !row.releasePeer.cleanupPending) return reply(row, false);
      this.noRunningBees(account);
      if (!firstAttempt && (row.state !== "committed" || this.store.credentialAuthorityEpoch(account.id) >= row.releasePeer!.requiredEpoch)) throw new RpcError("credential_handoff_decided", "A newer authority or recovery superseded this release-peer attempt.");
      if (firstAttempt) {
        if (this.store.listCredentialHandoffs().some(other => other.account === account.id && other.handoffId !== handoffId && !["aborted", "confirmed", "failed", "adopted", "stood_down"].includes(other.state))) throw new RpcError("credential_handoff_fenced", "Finish another credential recovery before releasing this peer.");
        const requiredEpoch = Math.max(row.binding.epoch, this.store.credentialAuthorityEpoch(account.id)) + 1;
        if (!Number.isSafeInteger(requiredEpoch)) throw new RpcError("invalid_request", "Release-peer cannot advance the authority epoch further.");
        if (row.state === "prepared") {
          const authority = this.accounts.authorityFor(account)!.status(account);
          if (!authority || authority.phase !== "handing_off") throw new RpcError("credential_handoff_unavailable", "Prepared release requires the original fenced source authority.");
          row = { ...row, state: "aborted", receipt: this.signed("aborted", exported(row.binding)), generation: authority.generation, expiresAt: authority.expiresAt,
            releasePeer: { roster, requiredEpoch, mode: "prepared_abort", outcome: "restored", cleanupPending: false, earlyRotationPending: true } };
          this.store.completeCredentialPeerRelease(row, { ...authority, phase: "ready", operationKey: null });
          return reply(row, false);
        }
        row = this.put(row, "committed", { releasePeer: { roster, requiredEpoch, mode: "committed_refresh", outcome: "pending", cleanupPending: false } });
      }
      let providerCalled = false;
      const reject = async () => {
        row = this.put(row, "committed", { releasePeer: { ...row.releasePeer!, outcome: "login_required", cleanupPending: true } });
        try { this.accounts.assertNoNewNativeTakeover(account); await this.accounts.scrubHandoff(account); }
        catch { return reply(row, providerCalled); }
        row = { ...row, state: "failed", scrubbed: true, releasePeer: { ...row.releasePeer!, cleanupPending: false } };
        this.store.completeCredentialPeerRelease(row);
        return reply(row, providerCalled);
      };
      if (row.releasePeer!.outcome === "login_required") return reject();
      const authority = this.accounts.authorityFor(account)!;
      if (params.nativeRecovery === true) {
        if (authority.releasedPeerRetryable(account, handoffId)) throw new RpcError("credential_handoff_decided", "The provider proved this token was unconsumed; retry normal release-peer instead of native recovery.");
        if (authority.releasedPeerHasReplacement(account, row.binding.generation)) throw new RpcError("credential_handoff_decided", "A saved replacement chain exists; retry normal release-peer to publish it. Native recovery must not discard that chain.");
        row = this.put(row, "committed", { releasePeer: { ...row.releasePeer!, nativeRecovery: true, retryable: false, outcome: "login_required", cleanupPending: true } });
        return reject();
      }
      try {
        const state = await authority.rotateReleasedPeer(account, handoffId, row.binding.generation, firstAttempt, () => { providerCalled = true; });
        row = { ...row, state: "aborted", receipt: this.signed("aborted", exported(row.binding)), generation: state.generation, expiresAt: state.expiresAt,
          releasePeer: { ...row.releasePeer!, outcome: "restored", cleanupPending: false } };
        this.store.completeCredentialPeerRelease(row);
        return reply(row, providerCalled);
      } catch {
        if (authority.status(account)?.phase === "login_required" && authority.status(account)?.failure?.outcome === "rejected") return reject();
        let unusableGeneration: number | null = null;
        try { unusableGeneration = authority.releasedPeerUnusableGeneration(account, handoffId, row.binding.generation); } catch {}
        if (unusableGeneration !== null) {
          row = this.put(row, "committed", { releasePeer: { ...row.releasePeer!, outcome: "retained_unusable", transportGeneration: row.binding.generation, retainedGeneration: unusableGeneration, retainedUnusableCount: 1, retryable: false } });
          return reply(row, providerCalled);
        }
        let retryable = false;
        try { retryable = authority.releasedPeerRetryable(account, handoffId); } catch {}
        row = this.put(row, "committed", { releasePeer: { ...row.releasePeer!, outcome: "uncertain", retryable } });
        return reply(row, providerCalled);
      }
    });
  }

  private async releaseDestination(account: AccountRow, original: CredentialHandoffRecord, roster: NonNullable<CredentialHandoffRecord["releasePeer"]>["roster"], nativeRecovery: boolean, useRetainedChain: boolean, retainedGeneration: number | undefined, discardRetainedChain: boolean) {
    let row = original;
    let firstAttempt = !row.releasePeer;
    let providerCalled = false;
    const authority = this.accounts.authorityFor(account)!;
    const reply = () => {
      const release = row.releasePeer!;
      const holder = release.mode === "destination_holder" || ["destination_retained_refresh", "committed_refresh"].includes(release.mode) && release.outcome === "restored";
      return { account: account.id, handoffId: row.handoffId, outcome: release.outcome === "pending" ? "uncertain" : release.outcome,
        disposition: release.outcome === "retained_unusable" ? "retained_unusable" : release.outcome === "uncertain" || release.outcome === "pending" ? "uncertain" : holder ? row.role === "source" ? "source_rotated" : "destination_holder_retained" : release.mode === "destination_void" ? "destination_shadow_voided" : "destination_native_login_required",
        requiredEpoch: release.requiredEpoch, generation: row.generation, expiresAt: row.expiresAt, providerCalled,
        cleanupPending: release.cleanupPending, abortReceipt: row.role === "source" && release.outcome === "restored" ? row.receipt : null, retryable: release.retryable === true, rotationScheduled: false, retainedGeneration: release.retainedGeneration ?? null, retainedUnusableCount: release.retainedUnusableCount ?? 0, failureReason: release.failureReason ?? null, cappedRetainedDiscardAvailable: release.failureReason === "retained_unusable_limit" && release.discardRetainedChain !== true,
        message: release.discardRetainedChain ? `${release.cleanupPending ? "Discard cleanup pending" : "Discarded retained chain"} for account ${account.id}, generation ${release.retainedGeneration}. The provider session behind the discarded chain stays valid until signed out at the provider. Finish cleanup, then native login, identity check and credentials enable on this same account; Apiary must publish epoch ${release.requiredEpoch}.`
          : release.failureReason === "retained_unusable_limit" ? `Three retained-chain recoveries returned unusable access for ${account.id}; native login is required. The newest chain remains private. Explicit recovery: hive account credentials release-peer ${account.id} --confirm --file authenticated-roster.json --handoff-id ${row.handoffId} --discard-retained-chain. Then native login, identity check and enable on this same row. No further retained-chain rotation is allowed.`
          : release.outcome === "retained_unusable" ? `The rotated chain for ${account.id} is retained at generation ${release.retainedGeneration}, but access is unusable. Explicit recovery: hive account credentials release-peer ${account.id} --confirm --file authenticated-roster.json --handoff-id ${row.handoffId} --use-retained-chain --retained-generation ${release.retainedGeneration}. Replaying the previous request makes no provider call.`
          : release.outcome === "uncertain" || release.outcome === "pending" ? `Retained-chain recovery is uncertain for ${account.id}; no blind provider retry. Preserve the chain and use its explicit recovery result.` : holder ? `This computer already holds account ${account.id}; Apiary must publish its authority record at epoch ${release.requiredEpoch}. No credential material was scrubbed.`
          : `Removed source ${row.binding.from.nodeId} released for account ${account.id}. The claim is terminal. ${release.mode === "destination_recovery" ? `The removed computer may still hold a working login for account ${account.id} until signed out at the provider. ` : ""}Use the normal native login, identity check and credentials enable path; Apiary must publish epoch ${release.requiredEpoch}.` };
    };
    if (nativeRecovery && (row.releasePeer?.outcome === "retained_unusable" || row.releasePeer?.failureReason === "retained_unusable_limit")) throw new RpcError("credential_handoff_decided", "The known retained chain cannot be discarded; follow its explicit retained or native-holder recovery instructions.");
    if (discardRetainedChain && (row.releasePeer?.failureReason !== "retained_unusable_limit" || (row.releasePeer.retainedUnusableCount ?? 0) < 3)) throw new RpcError("credential_handoff_decided", "Explicit retained discard is available only after three consecutive unusable retained outcomes.");
    if (row.releasePeer?.failureReason === "retained_unusable_limit" && retainedGeneration !== undefined && retainedGeneration > row.releasePeer.transportGeneration!) throw new RpcError("credential_handoff_decided", "The retained recovery limit requires explicit capped discard, then native login and enable on this same account.");
    if (row.releasePeer && retainedGeneration !== undefined && retainedGeneration < row.releasePeer.transportGeneration!) return reply();
    if (row.releasePeer && retainedGeneration !== undefined && row.releasePeer.outcome !== "retained_unusable" && retainedGeneration !== row.releasePeer.transportGeneration) throw new RpcError("credential_handoff_conflict", "Retained recovery generation differs from the durable attempt.");
    if (row.releasePeer && ["restored", "login_required"].includes(row.releasePeer.outcome) && !row.releasePeer.cleanupPending && !(discardRetainedChain && !row.releasePeer.discardRetainedChain)) return reply();
    this.noRunningBees(account);
    if (row.releasePeer && (row.state !== "committed" || this.store.credentialAuthorityEpoch(account.id) >= row.releasePeer.requiredEpoch)) throw new RpcError("credential_handoff_decided", "A newer authority or recovery superseded this destination release.");
    if (discardRetainedChain && row.releasePeer?.discardRetainedChain !== true) {
      if (authority.releasedPeerHasReplacement(account, row.releasePeer!.retainedGeneration!)) throw new RpcError("credential_handoff_decided", "A newer saved chain superseded the capped retained generation; preserve it.");
      row = this.put(row, "committed", { releasePeer: { ...row.releasePeer!, mode: "destination_recovery", discardRetainedChain: true, outcome: "login_required", cleanupPending: true } });
    }
    if (row.releasePeer?.outcome === "retained_unusable") {
      if (!useRetainedChain || retainedGeneration === undefined || retainedGeneration === row.releasePeer.transportGeneration) return reply();
      if (retainedGeneration !== row.releasePeer.retainedGeneration || authority.releasedPeerUnusableGeneration(account, row.handoffId, row.releasePeer.transportGeneration!) !== retainedGeneration) throw new RpcError("credential_handoff_conflict", "Fresh retained recovery must name the current saved unusable generation.");
      row = this.put(row, "committed", { releasePeer: { ...row.releasePeer, transportGeneration: retainedGeneration, retainedGeneration: undefined, outcome: "pending", retryable: false } });
      firstAttempt = true;
    }
    if (!row.releasePeer) {
      const current = authority.status(account);
      if (this.store.listCredentialHandoffs().some(other => other.account === account.id && other.handoffId !== row.handoffId && !["aborted", "confirmed", "failed", "adopted", "stood_down"].includes(other.state))) throw new RpcError("credential_handoff_fenced", "Another ownership operation holds this account.");
      if (this.store.credentialAuthorityEpoch(account.id) > row.binding.epoch) throw new RpcError("credential_handoff_decided", "A newer authority superseded this destination claim.");
      const holder = row.state === "adopted";
      const uncertain = row.state === "adopting";
      const retained = useRetainedChain && uncertain && current?.phase === "login_required" && current.failure?.error === "invalid_token_response" && authority.releasedPeerHasReplacement(account, row.binding.generation);
      if (retained && retainedGeneration !== undefined && retainedGeneration !== current!.generation) throw new RpcError("credential_handoff_conflict", "Retained recovery must name the current saved generation.");
      if (useRetainedChain && !retained) throw new RpcError("credential_handoff_decided", "Use-retained-chain requires a known rotated destination chain with malformed expiry.");
      if (!holder && !["prepared", "preparing", "failed", "adopting"].includes(row.state)) throw new RpcError("credential_handoff_decided", "Destination claim is already terminal.");
      if (uncertain && !nativeRecovery && !retained) throw new RpcError("credential_handoff_uncertain", "Destination outcome is unknown; use explicit release-peer --native-recovery only when no saved replacement exists.");
      if (nativeRecovery && !uncertain) throw new RpcError("credential_handoff_decided", "Native recovery requires an uncertain destination outcome.");
      if (!holder && !retained && row.state !== "preparing" && current && current.phase !== "disabled" && authority.releasedPeerHasReplacement(account, row.binding.generation)) throw new RpcError("credential_handoff_decided", "A saved replacement chain exists; finish normal adoption before releasing the removed source. Native recovery cannot discard it.");
      if (holder && current?.phase !== "ready") throw new RpcError("credential_handoff_unavailable", "Finish publishing the adopted authority before releasing its source.");
      const requiredEpoch = Math.max(row.binding.epoch, this.store.credentialAuthorityEpoch(account.id)) + 1;
      if (!Number.isSafeInteger(requiredEpoch)) throw new RpcError("invalid_request", "Release-peer cannot advance the authority epoch further.");
      row = this.put(row, "committed", { releasePeer: { roster, requiredEpoch, mode: retained ? "destination_retained_refresh" : holder ? "destination_holder" : uncertain ? "destination_recovery" : "destination_void", outcome: "pending", cleanupPending: !holder && !retained, nativeRecovery, ...(retained ? { transportGeneration: current!.generation } : {}) } });
    }
    let release = row.releasePeer!;
    if (["destination_retained_refresh", "committed_refresh"].includes(release.mode) && release.outcome !== "login_required") {
      if (!useRetainedChain && !nativeRecovery) throw new RpcError("invalid_request", "Repeat retained-chain release with the explicit recovery option.");
      if (nativeRecovery) {
        if (release.outcome !== "uncertain" || authority.releasedPeerRetryable(account, row.handoffId) || authority.releasedPeerHasReplacement(account, release.transportGeneration!)) throw new RpcError("credential_handoff_decided", "Native recovery cannot discard a known replacement or a proven unconsumed retained chain.");
        row = this.put(row, "committed", { releasePeer: { ...release, mode: "destination_recovery", nativeRecovery: true, outcome: "login_required", cleanupPending: true } });
      } else {
        try {
          const ready = await authority.rotateReleasedPeer(account, row.handoffId, release.transportGeneration!, firstAttempt, () => { providerCalled = true; });
          row = { ...row, generation: ready.generation, expiresAt: ready.expiresAt, releasePeer: { ...release, outcome: "restored", cleanupPending: false } };
        } catch {
          if (authority.status(account)?.phase === "login_required" && authority.status(account)?.failure?.outcome === "rejected") row = this.put(row, "committed", { releasePeer: { ...release, outcome: "login_required", cleanupPending: true } });
          else {
            let unusableGeneration: number | null = null;
            try { unusableGeneration = authority.releasedPeerUnusableGeneration(account, row.handoffId, release.transportGeneration!); } catch {}
            if (unusableGeneration !== null) {
              const retainedUnusableCount = (release.retainedUnusableCount ?? 0) + 1;
              const capped = retainedUnusableCount >= 3;
              row = this.put(row, "committed", { releasePeer: { ...release, outcome: capped ? "login_required" : "retained_unusable", retainedGeneration: unusableGeneration, retainedUnusableCount, retryable: false, cleanupPending: false, ...(capped ? { failureReason: "retained_unusable_limit" as const } : {}) } });
              if (capped && account.status !== "paused") this.store.setAccountStatus(account.id, "auth_needed", "Three retained-chain recoveries returned unusable access; native login required, retained chain preserved");
              return reply();
            }
            let retryable = false;
            try { retryable = authority.releasedPeerRetryable(account, row.handoffId); } catch {}
            row = this.put(row, "committed", { releasePeer: { ...release, outcome: "uncertain", retryable } });
            return reply();
          }
        }
      }
      release = row.releasePeer!;
    }
    if (release.mode !== "destination_holder" && !(["destination_retained_refresh", "committed_refresh"].includes(release.mode) && release.outcome === "restored")) {
      try {
        if (release.mode === "destination_recovery" || release.mode === "destination_retained_refresh") { this.accounts.assertNoNewNativeTakeover(account); await this.accounts.scrubHandoff(account); }
        else authority.forgetHandoffAdoption(account);
      } catch { return reply(); }
    }
    const restored = release.mode === "destination_holder" || ["destination_retained_refresh", "committed_refresh"].includes(release.mode) && release.outcome === "restored";
    row = { ...row, state: row.role === "source" && restored ? "aborted" : "stood_down", ...(row.role === "source" && restored ? { receipt: this.signed("aborted", exported(row.binding)) } : {}), scrubbed: !restored, releasePeer: { ...release, outcome: restored ? "restored" : "login_required", cleanupPending: false } };
    this.store.completeCredentialPeerRelease(row);
    return reply();
  }

  async operatorTakeover(params: Record<string, unknown>) {
    if (params.confirm !== true) throw new RpcError("invalid_request", "Explicit take-over requires --confirm; it destroys the abandoned refresh copies without revoking them.");
    const account = this.account(params.account), handoffId = name(params.takeoverId);
    return this.lane(account, `operator-takeover:${handoffId}`, async () => {
      this.noRunningBees(account);
      let operation = this.store.getCredentialHandoff(handoffId, "source");
      if (operation) {
        if (operation.account !== account.id || operation.receipt?.kind !== "operator_takeover") throw new RpcError("credential_handoff_conflict", "Take-over id belongs to another operation.");
        this.assertSelf(operation.binding.from);
        if (params.epoch !== undefined && integer(params.epoch) !== operation.binding.epoch) throw new RpcError("credential_handoff_conflict", "Take-over retry changed epoch.");
        if (["stood_down", "aborted"].includes(operation.state)) return this.result(operation);
      } else {
        const history = this.store.listCredentialHandoffs().filter(row => row.account === account.id);
        const held = this.store.activeCredentialHandoff(account.id) ?? history.filter(row => row.role === "destination" && row.state === "failed").sort((a, b) => b.binding.since - a.binding.since)[0];
        if (!held || !["committed", "adopting", "prepared", "failed"].includes(held.state) || held.receipt?.kind === "stand_down" || held.receipt?.kind === "operator_takeover") throw new RpcError("credential_handoff_unavailable", "Explicit take-over requires an abandoned handoff on this account.");
        const state = this.accounts.authorityFor(account)!.status(account);
        if (held.role === "destination" && (!state || state.phase === "disabled")) this.accounts.assertNoNewNativeTakeover(account);
        if (state?.phase === "ready" || this.store.credentialAuthorityEpoch(account.id) > held.binding.epoch || history.some(row => row.handoffId !== held.handoffId && row.binding.since > held.binding.since && !row.receipt?.kind.startsWith("operator_")) || account.leasedFrom && (account.leasedFrom.epoch > held.binding.epoch || account.leasedFrom.authorityNodeId !== held.binding.from.nodeId)) throw new RpcError("credential_handoff_decided", "This abandoned handoff has been superseded; preserve the current authority.");
        const self = this.self(), source = same(held.binding.from, self), peer = source ? held.binding.to : held.binding.from;
        const peerAccount = source ? held.binding.targetAccount : held.binding.sourceAccount;
        if (!peerAccount) throw new RpcError("credential_handoff_unavailable", "The abandoned handoff has no durable peer preparation.");
        const floor = Math.max(this.store.credentialAuthorityEpoch(account.id), held.binding.epoch);
        const epoch = params.epoch === undefined ? floor + 1 : integer(params.epoch);
        if (epoch <= floor) throw new RpcError("credential_handoff_stale_epoch", "Take-over epoch must exceed the abandoned handoff and local authority.");
        const bound: CredentialHandoffBinding = { ...held.binding, handoffId, from: self, to: peer, sourceAccount: peerAccount, targetAccount: account.id,
          epoch, sourceKey: this.publicKey(), targetKey: null, claimId: handoffId, materialDigest: held.handoffId, since: this.now(), prepareBy: 0 };
        operation = this.store.putCredentialHandoff({ handoffId, role: "source", account: account.id, state: "committed", binding: bound,
          receipt: this.signed("operator_takeover", bound), generation: null, expiresAt: null });
      }
      this.takeoverEpoch(account, operation.binding, operation);
      await this.accounts.scrubHandoff(account);
      return this.result(operation);
    });
  }

  async operatorTakeoverApply(params: Record<string, unknown>) {
    const signed = receipt(params.takeoverReceipt), key = name(params.issuerKey), peer = identity(params.authenticatedPeer), bound = signed.binding;
    check(signed, "operator_takeover", key); this.assertSelf(bound.to);
    if (bound.sourceKey !== key || !same(bound.from, peer)) throw new RpcError("credential_handoff_conflict", "Operator takeover differs from the authenticated issuer.");
    const account = this.account(bound.sourceAccount);
    if (bound.harness !== account.harness) throw new RpcError("credential_handoff_conflict", "Operator takeover names another harness.");
    return this.lane(account, `apply-takeover:${bound.handoffId}`, async () => {
      let operation = this.store.getCredentialHandoff(bound.handoffId, "destination");
      if (operation && !same({ ...operation.binding, targetKey: null }, bound)) throw new RpcError("credential_handoff_conflict", "Take-over id is already bound.");
      if (operation?.state === "aborted") throw new RpcError("credential_handoff_decided", "Peer refused this operator takeover; cancel it on the issuer and reconcile the original handoff.", { receipt: operation.receipt });
      if (operation?.state === "stood_down" && operation.receipt?.kind === "operator_taken_down") return this.result(operation);
      const original = this.store.getCredentialHandoff(bound.materialDigest, "source") ?? this.store.getCredentialHandoff(bound.materialDigest, "destination");
      if (!original || original.account !== account.id || !same(same(original.binding.from, this.self()) ? original.binding.to : original.binding.from, peer) || ((same(original.binding.from, this.self()) ? original.binding.targetAccount : original.binding.sourceAccount) !== null && bound.targetAccount !== (same(original.binding.from, this.self()) ? original.binding.targetAccount : original.binding.sourceAccount)) || bound.epoch <= original.binding.epoch) throw new RpcError("credential_handoff_conflict", "Operator takeover does not name this abandoned handoff.");
      const floor = this.store.credentialAuthorityEpoch(account.id);
      const superseded = this.store.listCredentialHandoffs().some(row => row.account === account.id && row.handoffId !== original.handoffId && row.handoffId !== bound.handoffId && !row.receipt?.kind.startsWith("operator_") && row.binding.since > original.binding.since);
      const authorityState = this.accounts.authorityFor(account)!.status(account);
      let nativeChanged = false;
      if (!operation && (!authorityState || authorityState.phase === "disabled")) {
        try { this.accounts.assertNoNewNativeTakeover(account); }
        catch (error) { if (error instanceof RpcError && error.code === "credential_handoff_decided") nativeChanged = true; else throw error; }
      }
      const stranded = original.role === "source" ? ["prepared", "committed"].includes(original.state) : ["preparing", "prepared", "adopting", "failed"].includes(original.state);
      if (!operation && (!stranded || floor > original.binding.epoch || superseded || authorityState?.phase === "ready" || nativeChanged)) {
        const refused = { ...bound, targetKey: this.publicKey() };
        const rejection = this.store.putCredentialHandoff({ handoffId: bound.handoffId, role: "destination", account: account.id, state: "aborted", binding: refused,
          receipt: this.signed("operator_refused", refused), generation: null, expiresAt: null, scrubbed: true });
        throw new RpcError("credential_handoff_decided", "Peer handoff is terminal or superseded; no refresh copy was scrubbed. Cancel the unapplied recovery and reconcile the original receipt.", { receipt: rejection.receipt, originalReceipt: original.receipt?.kind === "export" ? null : original.receipt });
      }
      this.noRunningBees(account);
      this.takeoverEpoch(account, bound, operation);
      operation ??= this.store.putCredentialHandoff({ handoffId: bound.handoffId, role: "destination", account: account.id, state: "committed", binding: bound, receipt: signed, generation: null, expiresAt: null });
      await this.accounts.scrubHandoff(account);
      this.store.demoteCredentialAuthority(account.id, bound.epoch);
      this.store.setAccountStatus(account.id, "auth_needed", "Explicit operator takeover scrubbed this peer; install a new-authority lease");
      this.finishTakeoverRows(account, operation.handoffId);
      const acknowledged = { ...bound, targetKey: this.publicKey() };
      return this.result(this.put(operation, "stood_down", { binding: acknowledged, receipt: this.signed("operator_taken_down", acknowledged) }));
    });
  }

  async operatorTakeoverComplete(params: Record<string, unknown>) {
    const handoffId = name(params.takeoverId), acknowledged = receipt(params.peerReceipt), peerKey = name(params.peerKey), peer = identity(params.authenticatedPeer);
    const operation = this.row(handoffId, "source"), account = this.account(operation.account);
    check(acknowledged, "operator_taken_down", peerKey); this.assertSelf(operation.binding.from);
    if (!same(peer, operation.binding.to) || !same(acknowledged.binding, { ...operation.binding, targetKey: peerKey })) throw new RpcError("credential_handoff_conflict", "Peer cleanup acknowledgment differs from the pinned operator takeover.");
    return this.lane(account, `complete-takeover:${handoffId}`, async () => {
      this.noRunningBees(account);
      let current = this.row(handoffId, "source");
      if (current.peerReceipt && !same(current.peerReceipt, acknowledged)) throw new RpcError("credential_handoff_conflict", "Take-over peer acknowledgment differs from the durable pin.");
      if (current.state === "stood_down") return this.result(current);
      if (!current.peerReceipt) current = this.put(current, "committed", { peerReceipt: acknowledged });
      this.takeoverEpoch(account, current.binding, current);
      await this.accounts.scrubHandoff(account);
      this.store.demoteCredentialAuthority(account.id, current.binding.epoch);
      this.finishTakeoverRows(account, handoffId);
      const completed = { ...current, state: "stood_down" as const };
      this.store.completeCredentialTakeover(completed);
      return this.result(completed);
    });
  }

  async operatorTakeoverCancel(params: Record<string, unknown>) {
    const handoffId = name(params.takeoverId), refusal = receipt(params.peerReceipt), peerKey = name(params.peerKey), peer = identity(params.authenticatedPeer);
    const operation = this.row(handoffId, "source"), account = this.account(operation.account);
    check(refusal, "operator_refused", peerKey); this.assertSelf(operation.binding.from);
    if (!same(peer, operation.binding.to) || !same(refusal.binding, { ...operation.binding, targetKey: peerKey })) throw new RpcError("credential_handoff_conflict", "Peer refusal differs from this operator takeover.");
    return this.lane(account, `cancel-takeover:${handoffId}`, async () => {
      const current = this.row(handoffId, "source");
      if (current.state === "aborted") return this.result(current);
      if (current.state !== "committed" || current.peerReceipt) throw new RpcError("credential_handoff_decided", "An acknowledged or completed peer scrub cannot be cancelled.");
      return this.result(this.put(current, "aborted", { peerReceipt: refusal, scrubbed: true }));
    });
  }

  private recovery(account: AccountRow): string {
    const target = account.source === "leased" ? "<local-account>" : account.id;
    const local = account.source === "leased" ? ` Use or add a local account on that computer (hive account add ${account.harness} <local-label>); ${account.id} remains a leased account.` : "";
    return `Provider rejected adoption; the source remains committed and fenced. For explicit recovery on the chosen holder, stop all its account bees and run hive account credentials take-over ${account.id} --confirm; Apiary must relay the signed peer scrub and complete it before native login. For an explicit operator takeover, stand down the old authority at a higher epoch (hive account credentials stand-down --file protected-payload.json), then hive account login ${target}; hive account credentials enable ${target} on the chosen new authority.${local} Resolve pending destination storage cleanup first.`;
  }

  private async cleanupDestination(row: CredentialHandoffRecord): Promise<boolean> {
    try {
      const account = this.account(row.account);
      if (row.state === "aborted") this.accounts.authorityFor(account)!.forgetHandoffAdoption(account);
      else await this.accounts.scrubHandoff(account);
      this.put(row, row.state, { scrubbed: true });
      return true;
    } catch {
      this.log(`account.credentials.handoff_cleanup_pending account=${row.account} handoff=${row.handoffId}`);
      return false;
    }
  }

  async reconcile(force = false): Promise<void> {
    if (!force && this.now() - this.lastSweepAt < 1000) return;
    this.lastSweepAt = this.now();
    const pending = this.store.pendingCredentialHandoffs();
    for (const row of pending.filter(row => row.role === "source" && row.state === "exported" && this.now() >= row.binding.prepareBy)) {
      try { await this.exportAbort({ handoffId: row.handoffId }); }
      catch { this.log(`account.credentials.handoff_reconcile_pending account=${row.account} handoff=${row.handoffId}`); }
    }
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      for (const row of pending.filter(row => row.role === "source" && row.releasePeer?.earlyRotationPending)) {
        try {
          const account = this.account(row.account), authority = this.accounts.authorityFor(account)!, state = authority.status(account);
          if (account.source === "leased" || authority.busy(account) || state?.phase !== "ready" || state.failure?.retryAt != null && state.failure.retryAt > this.now()) continue;
          const rotated = state.generation > (row.generation ?? row.binding.generation) ? state : await authority.ensure(account, 0, `release-peer-early:${row.handoffId}`);
          if (rotated.generation > (row.generation ?? row.binding.generation)) this.put(this.row(row.handoffId, "source"), "aborted", { generation: rotated.generation, expiresAt: rotated.expiresAt, releasePeer: { ...row.releasePeer!, earlyRotationPending: false } });
        } catch { this.log(`account.credentials.release_peer_early_rotation_pending account=${row.account} handoff=${row.handoffId}`); }
      }
      for (const row of pending.filter(row => row.role === "destination")) {
        try {
          const account = this.account(row.account);
          await this.lane(account, `cleanup:${row.handoffId}`, () => this.cleanupDestination(row));
        } catch { this.log(`account.credentials.handoff_reconcile_pending account=${row.account} handoff=${row.handoffId}`); }
      }
    } finally { this.reconciling = false; }
  }

  rotateKey(params: Record<string, unknown>) {
    const idempotencyKey = name(params.idempotencyKey);
    const previous = this.store.lookupRpcResult(idempotencyKey);
    if (previous) {
      if (previous.verb !== "account.credentials.handoffKeyRotate") throw new RpcError("idempotency_conflict", "Key belongs to another RPC.");
      return { ...previous.result as Record<string, unknown>, deduped: true };
    }
    const rows = this.store.listCredentialHandoffs();
    if (this.identityReplacing || this.activeLanes || rows.some(row => ["preparing", "prepared", "adopting", "committed"].includes(row.state))) throw new RpcError("credential_handoff_fenced", "Finish prepared or committed handoffs before rotating the workstation handoff key.");
    this.key();
    const exports = rows.filter(row => row.role === "source" && row.state === "exported");
    const pending = exports.map(row => {
      const account = this.account(row.account), authority = this.accounts.authorityFor(account)!.status(account);
      if (!authority || authority.phase !== "handing_off" || row.binding.sourceKey !== this.publicKey()) throw new RpcError("credential_handoff_unavailable", "Resolve the exported authority fence before rotating the workstation handoff key.");
      return { row, authority, receipt: this.signed("aborted", exported(row.binding)) };
    });
    for (const { row, authority, receipt } of pending) this.store.putCredentialHandoff({ ...row, state: "aborted", receipt }, { ...authority, phase: "ready" });
    const pair = generateKeyPairSync("ed25519");
    atomicWriteFileSync(join(this.root, "handoff-signing-key.pem"), pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    const result = { publicKey: this.publicKey(), abortedHandoffIds: exports.map(row => row.handoffId), disposition: "rotated", providerCalled: false };
    this.store.recordRpcResult(idempotencyKey, "account.credentials.handoffKeyRotate", null, result);
    return result;
  }

  status(params: Record<string, unknown>) {
    const row = this.row(name(params.handoffId), params.role === "destination" ? "destination" : "source");
    const result = this.result(row);
    let retainedChainRecoveryAvailable = false;
    if (row.role === "source" && row.state === "committed" && (row.releasePeer?.retainedUnusableCount ?? 0) > 0 && row.releasePeer?.failureReason !== "retained_unusable_limit") retainedChainRecoveryAvailable = true;
    if (row.role === "destination") {
      const account = this.account(row.account), authority = this.accounts.authorityFor(account)!, state = authority.status(account);
      if (row.releasePeer?.mode === "destination_retained_refresh" && row.state === "committed" && row.releasePeer.failureReason !== "retained_unusable_limit") retainedChainRecoveryAvailable = true;
      else if (!row.releasePeer && row.state === "adopting" && state?.phase === "login_required" && state.failure?.error === "invalid_token_response") {
        try { retainedChainRecoveryAvailable = authority.releasedPeerHasReplacement(account, row.binding.generation); } catch {}
      }
    }
    return { ...result, binding: row.binding, cappedRetainedDiscardAvailable: row.releasePeer?.failureReason === "retained_unusable_limit" && row.releasePeer.discardRetainedChain !== true && row.state === "committed", scrubbed: row.scrubbed === true, retainedChainRecoveryAvailable, receipt: row.receipt?.kind === "export" ? null : result.receipt };
  }
}
