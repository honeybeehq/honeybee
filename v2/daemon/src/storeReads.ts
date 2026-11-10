import {
  MAIL_HISTORY_MAX_LIMIT,
  filterMailbox,
  mirrorBeeRow,
  toBeeHandoffView,
  toBeeMoveView,
  type AuditRow,
  type BeeViewRow,
  type CommandRow,
  type CoreStore,
  type MailHistoryParams,
  type MailHistoryResult,
  type MailPendingResult,
  type MessageRow,
} from "../../core/src/index.ts";
import { peerOwner } from "./confinedPeer.ts";
import type { IdentityRecovery } from "./identityRecovery.ts";
import {
  LIST_PAGE_MAX_LIMIT,
  LIST_REF_MAX_BYTES,
  LIST_REFS_MAX,
  RpcError,
  TRANSCRIPT_SEGMENTS_MAX_ROWS,
  type AuditTailResult,
  type ListResult,
  type RpcVerb,
  type TranscriptSegmentsResult,
  type ViewResult,
} from "./protocol.ts";
import { archivedCursor, archivedCursorText } from "./rosterRead.ts";
import type { RpcConn } from "./rpc.ts";

export const READ_SOCKET_VERBS = ["list", "view", "mailbox", "mail.pending", "mail.history", "transcript.segments", "commands", "audit.tail"] as const satisfies readonly RpcVerb[];
export type ReadSocketVerb = (typeof READ_SOCKET_VERBS)[number];

export function isReadSocketVerb(verb: RpcVerb): verb is ReadSocketVerb {
  return (READ_SOCKET_VERBS as readonly RpcVerb[]).includes(verb);
}

export function publicConfirmationAudit(row: AuditRow): AuditRow {
  if (!row.kind.startsWith("mail.confirmation_")) return row;
  const payload = { ...row.payload };
  for (const key of ["wireLine", "digest", "host", "priorDigest"]) delete payload[key];
  for (const key of ["row", "prior"]) {
    const value = payload[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const { wireLine, digest, host, ...visible } = value as Record<string, unknown>;
      payload[key] = visible;
    }
  }
  return { ...row, payload };
}

export interface StoreReadSources {
  store(): CoreStore;
  identity: IdentityRecovery;
  transcriptStore(): TranscriptSegmentsResult["store"];
}

export class StoreReads {
  private readonly sources: StoreReadSources;

  constructor(sources: StoreReadSources) {
    this.sources = sources;
  }

  dispatch(verb: ReadSocketVerb, params: Record<string, unknown>, conn: Pick<RpcConn, "confinement" | "peerClass">): unknown {
    switch (verb) {
      case "view":
        return this.view(this.param(params, "beeId"));
      case "list":
        return this.listFor(params, conn);
      case "mailbox":
        return this.mailbox(params);
      case "mail.pending":
        return this.mailPending(params);
      case "mail.history":
        return this.mailHistory(params);
      case "transcript.segments":
        return this.transcriptSegments(params);
      case "commands":
        return this.commands(params);
      case "audit.tail":
        return this.auditTail(params);
    }
  }

  identityDiagnostic(beeId: string, generation: number | null): { identityDiagnostic?: { message: "identity unresolved"; warning: boolean } } {
    const diagnostic = this.sources.identity.diagnostic(beeId, generation, Date.now());
    return diagnostic ? { identityDiagnostic: diagnostic } : {};
  }

  view(beeId: string): ViewResult {
    const store = this.sources.store();
    const bee = store.getBee(beeId);
    return {
      ...this.identityDiagnostic(beeId, store.currentRuntime(beeId)?.generation ?? null),
      view: store.view(beeId),
      bee: mirrorBeeRow(bee),
      runtime: bee ? store.currentRuntime(beeId) : null,
      move: bee ? (() => { const m = store.latestMoveOf(bee.id); return m ? toBeeMoveView(m) : null; })() : null,
      cell: bee?.cellId ? store.getCell(bee.cellId) : null,
      handoff: bee ? (() => { const h = store.latestHandoffOf(bee.id); return h ? toBeeHandoffView(h) : null; })() : null,
    };
  }

  listFor(params: Record<string, unknown>, conn: Pick<RpcConn, "confinement" | "peerClass">): ListResult {
    if (conn.confinement !== "confined") return this.list(params);
    const owner = peerOwner(conn);
    if (!owner) throw new RpcError("confined_peer_refused", "Confined caller has no owning bee");
    return { views: [this.view(owner.beeId)] };
  }

  commands(params: Record<string, unknown>): { commands: CommandRow[] } {
    return { commands: this.sources.store().listCommands({ beeId: this.requireBee(params) }) };
  }

  list(params: Record<string, unknown>): ListResult {
    const store = this.sources.store();
    const { limit, after, refs } = params;
    const lifecycle = params.lifecycle ?? null;
    if (lifecycle !== null && lifecycle !== "active" && lifecycle !== "archived") throw new RpcError("invalid_request", "list: lifecycle must be active or archived");
    const shape = (rows: BeeViewRow[]): ViewResult[] => rows.map(row => ({...row, bee: mirrorBeeRow(row.bee), ...this.identityDiagnostic(row.view.beeId, row.view.generation)}));
    if (refs !== undefined) {
      if (!Array.isArray(refs) || refs.length === 0 || refs.length > LIST_REFS_MAX || !refs.every((ref): ref is string => typeof ref === "string" && ref.length > 0 && Buffer.byteLength(ref) <= LIST_REF_MAX_BYTES)) {
        throw new RpcError("invalid_request", `list: refs must be 1 to ${LIST_REFS_MAX} non-empty strings of at most ${LIST_REF_MAX_BYTES} bytes`);
      }
      if (lifecycle !== null || limit !== undefined || after !== undefined) throw new RpcError("invalid_request", "list: refs cannot be combined with lifecycle, limit or after");
      return {views: shape(store.listBeeViewRowsForRefs(refs))};
    }
    if (limit === undefined) {
      if (after !== undefined) throw new RpcError("invalid_request", "list: after requires limit");
      return {views: shape(store.listBeeViewRows(lifecycle))};
    }
    if (lifecycle !== "archived") throw new RpcError("invalid_request", "list: limit pages archived bees; pass lifecycle archived");
    if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > LIST_PAGE_MAX_LIMIT) throw new RpcError("invalid_request", `list: limit must be an integer from 1 to ${LIST_PAGE_MAX_LIMIT}`);
    const rows = store.listBeeViewRows("archived", { limit: limit + 1, ...(after === undefined ? {} : { after: archivedCursor(after) }) });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {views: shape(page), next: rows.length > limit && last ? archivedCursorText({ archivedAt: last.bee.archivedAt ?? 0, id: last.bee.id }) : null};
  }

  mailbox(params: Record<string, unknown>): { messages: MessageRow[] } {
    const beeId = this.requireBee(params);
    const sinceId = params.sinceId === undefined || params.sinceId === null ? undefined : this.numberParam(params, "sinceId");
    if (params.unread !== undefined && typeof params.unread !== "boolean") {
      throw new RpcError("invalid_request", "mailbox: unread must be a boolean");
    }
    return { messages: filterMailbox(this.sources.store().listMessages(beeId), { sinceId, unread: params.unread === true }) };
  }

  mailPending(params: Record<string, unknown>): MailPendingResult {
    const limit = params.limit;
    if (limit !== undefined && (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0)) {
      throw new RpcError("invalid_request", "mail.pending: limit must be a positive integer");
    }
    return this.sources.store().pendingMail(
      this.requireBee(params),
      typeof limit === "number" ? { limit: Math.min(limit, MAIL_HISTORY_MAX_LIMIT) } : {},
    );
  }

  mailHistory(params: Record<string, unknown>): MailHistoryResult {
    const limit = params.limit;
    if (limit !== undefined && (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0)) {
      throw new RpcError("invalid_request", "mail.history: limit must be a positive integer");
    }
    const beforeSeq = params.beforeSeq;
    if (
      beforeSeq !== undefined &&
      (typeof beforeSeq !== "number" || !Number.isSafeInteger(beforeSeq) || beforeSeq < 0)
    ) {
      throw new RpcError("invalid_request", "mail.history: beforeSeq must be a non-negative integer");
    }
    const snapshotSeq = params.snapshotSeq;
    if (
      snapshotSeq !== undefined &&
      (typeof snapshotSeq !== "number" || !Number.isSafeInteger(snapshotSeq) || snapshotSeq < 0)
    ) {
      throw new RpcError("invalid_request", "mail.history: snapshotSeq must be a non-negative integer");
    }
    const query = {
      ...(typeof limit === "number" ? { limit: Math.min(limit, MAIL_HISTORY_MAX_LIMIT) } : {}),
      ...(typeof beforeSeq === "number" ? { beforeSeq } : {}),
      ...(typeof snapshotSeq === "number" ? { snapshotSeq } : {}),
    } satisfies MailHistoryParams;
    return this.sources.store().mailHistory(query);
  }

  transcriptSegments(params: Record<string, unknown>): TranscriptSegmentsResult {
    const beeId = this.requireBee(params);
    const store = this.sources.store();
    const { afterOrdinal, limit, last, beforeOrdinal } = params;
    const rowCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= TRANSCRIPT_SEGMENTS_MAX_ROWS;
    if (afterOrdinal !== undefined && (typeof afterOrdinal !== "number" || !Number.isInteger(afterOrdinal))) throw new RpcError("invalid_request", "transcript.segments: afterOrdinal must be an integer when given");
    if (limit !== undefined && !rowCount(limit)) throw new RpcError("invalid_request", `transcript.segments: limit must be an integer from 1 to ${TRANSCRIPT_SEGMENTS_MAX_ROWS} when given`);
    if (last !== undefined && !rowCount(last)) throw new RpcError("invalid_request", `transcript.segments: last must be an integer from 1 to ${TRANSCRIPT_SEGMENTS_MAX_ROWS} when given`);
    if (beforeOrdinal !== undefined && (typeof beforeOrdinal !== "number" || !Number.isInteger(beforeOrdinal) || beforeOrdinal < 0)) throw new RpcError("invalid_request", "transcript.segments: beforeOrdinal must be a non-negative integer when given");
    if (last !== undefined && (afterOrdinal !== undefined || limit !== undefined)) throw new RpcError("invalid_request", "transcript.segments: last cannot be combined with afterOrdinal or limit");
    if (beforeOrdinal !== undefined && last === undefined) throw new RpcError("invalid_request", "transcript.segments: beforeOrdinal requires last");
    return {
      beeId,
      segments: last !== undefined
        ? store.listTranscriptSegmentObjects(beeId, { last, ...(beforeOrdinal === undefined ? {} : { beforeOrdinal }) })
        : store.listTranscriptSegmentObjects(beeId, { ...(afterOrdinal === undefined ? {} : { afterOrdinal }), limit: limit ?? 1000 }),
      store: this.sources.transcriptStore(),
      cursor: store.getTranscriptSegmentCursor(beeId),
      historyStartLine: store.transcriptSegmentHistoryStartLine(beeId),
    };
  }

  auditTail(params: Record<string, unknown>): AuditTailResult {
    const afterSeq = typeof params.afterSeq === "number" && Number.isFinite(params.afterSeq) ? params.afterSeq : 0;
    const rawLimit = typeof params.limit === "number" && Number.isFinite(params.limit) ? Math.floor(params.limit) : 100;
    const limit = Math.max(1, Math.min(1000, rawLimit));
    const beeId = typeof params.beeId === "string" && params.beeId.length > 0 ? params.beeId : null;
    return { rows: this.sources.store().auditTail(afterSeq, limit, beeId).map(row => publicConfirmationAudit(row)) };
  }

  private param(params: Record<string, unknown>, key: string): string {
    const v = params[key];
    if (typeof v !== "string" || v.length === 0) {
      throw new RpcError("invalid_request", `param '${key}' must be a non-empty string`);
    }
    return v;
  }

  private numberParam(params: Record<string, unknown>, key: string): number {
    const v = params[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
      throw new RpcError("invalid_request", `param '${key}' must be a positive integer`);
    }
    return v;
  }

  private requireBee(params: Record<string, unknown>): string {
    const beeId = this.param(params, "beeId");
    if (!this.sources.store().getBee(beeId)) throw new RpcError("bee_not_found", `bee not found: ${beeId}`);
    return beeId;
  }
}
