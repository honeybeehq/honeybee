import type { RpcVerb } from "./protocol.ts";
import { rewritePath } from "./answerTriggerProjection.ts";

export const MAIL_DELIVERY_CONFIRMATION_CAPABILITY = "mail.delivery.confirmation.v1";
export const MAIL_DELIVERY_RESULTS = {
  ViewResult: { verbs: ["view"], views: ["view"], messages: [], audits: [] },
  ListResult: { verbs: ["list"], views: ["views[].view"], messages: [], audits: [] },
  ChildrenResult: { verbs: ["bee.children"], views: ["children[].view"], messages: [], audits: [] },
  SnapshotResult: { verbs: ["snapshot", "watch"], views: ["views[].view"], messages: [], audits: [] },
  MailboxResult: { verbs: ["mailbox"], views: [], messages: ["messages[]"], audits: [] },
  MailHistoryResult: { verbs: ["mail.history"], views: [], messages: ["messages[]"], audits: [] },
  MailPendingResult: { verbs: ["mail.pending"], views: [], messages: ["messages[]"], audits: [] },
  AuditTailResult: { verbs: ["audit.tail"], views: [], messages: [], audits: ["rows"] },
  WatchFrame: { verbs: [], views: [], messages: [], audits: ["events"] },
} as const satisfies Record<string, { verbs: readonly RpcVerb[]; views: readonly string[]; messages: readonly string[]; audits: readonly string[] }>;
export const MAIL_DELIVERY_AUDITS = {
  "mail.enqueued": ["message"],
  "mail.replaced": ["replacement"],
} as const;
export const MAIL_DELIVERY_HIDDEN_AUDITS = ["mail.confirmation_prepared", "mail.confirmation_held", "mail.confirmation_released", "mail.confirmation_decision"] as const;

type Coverage = { views: readonly string[]; messages: readonly string[]; audits: readonly string[] };
const routes = new Map<string, Coverage>(Object.values(MAIL_DELIVERY_RESULTS).flatMap(coverage => coverage.verbs.map(verb => [verb, coverage] as const)));
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const hiddenAudit = (value: unknown): boolean => record(value) && MAIL_DELIVERY_HIDDEN_AUDITS.some(kind => value.kind === kind);

function legacyView(value: unknown): unknown {
  if (!record(value) || !Object.hasOwn(value, "deliveryConfirmations")) return value;
  const { deliveryConfirmations, ...view } = value;
  return view;
}

function legacyMessage(value: unknown): unknown {
  if (!record(value)) return value;
  const { deliveryConfirmation, queueOrder, replacesMessageId, ...message } = value;
  const lifecycle = value.lifecycle;
  if (record(lifecycle) && lifecycle.state === "replaced") {
    return { ...message, lifecycle: { state: "canceled", canceledAt: lifecycle.replacedAt, reason: "requested" } };
  }
  return Object.hasOwn(value, "deliveryConfirmation") || Object.hasOwn(value, "queueOrder") || Object.hasOwn(value, "replacesMessageId") ? message : value;
}

function legacyAudit(value: unknown): unknown {
  if (!record(value)) return value;
  if (value.kind === "mail.replaced" && record(value.payload)) {
    const p = value.payload;
    return { ...value, kind: "mail.canceled", payload: {
      messageId: p.messageId,
      ...(record(p.replacement) ? { urgency: p.replacement.urgency } : {}),
      reason: "requested", canceledAt: p.replacedAt,
      ...(p.rpcCaller === undefined ? {} : { rpcCaller: p.rpcCaller }),
    } };
  }
  return value.kind === "mail.enqueued" ? rewritePath(value, ["payload", "message"], legacyMessage) : value;
}

function legacyAudits(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const rows = value.filter(row => !hiddenAudit(row)).map(legacyAudit);
  return rows.length === value.length && rows.every((row, index) => row === value[index]) ? value : rows;
}

function project(value: unknown, coverage: Coverage): unknown {
  let result = value;
  for (const path of coverage.views) result = rewritePath(result, path.split("."), legacyView);
  for (const path of coverage.messages) result = rewritePath(result, path.split("."), legacyMessage);
  for (const path of coverage.audits) result = rewritePath(result, path.split("."), legacyAudits);
  return result;
}

export function projectMailDeliveryResult(verb: RpcVerb, value: unknown, capabilities: readonly string[]): unknown {
  if (capabilities.includes(MAIL_DELIVERY_CONFIRMATION_CAPABILITY)) return value;
  const coverage = routes.get(verb);
  if (coverage) return project(value, coverage);
  if (verb === "rpc.effect.resolve" && record(value) && record(value.receipt) && typeof value.receipt.verb === "string") {
    const nested = routes.get(value.receipt.verb);
    if (nested) {
      const result = project(value.receipt.result, nested);
      if (result !== value.receipt.result) return { ...value, receipt: { ...value.receipt, result } };
    }
  }
  return value;
}

export function projectMailDeliveryDelta(value: unknown, capabilities: readonly string[]): unknown {
  if (capabilities.includes(MAIL_DELIVERY_CONFIRMATION_CAPABILITY)) return value;
  if (record(value) && value.type === "delta" && Array.isArray(value.events) && value.events.some(hiddenAudit)) return { type: "gap", seq: value.seq };
  return project(value, MAIL_DELIVERY_RESULTS.WatchFrame);
}
