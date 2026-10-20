import type { RpcErrorShape, RpcVerb } from "./protocol.ts";
import { rewritePath } from "./answerTriggerProjection.ts";

export const QUESTION_DISMISSED_CAPABILITY = "question.dismissed.v1";
export const QUESTION_DISMISSAL_RESULTS = {
  QuestionAskResult: { verbs: ["question.ask"], values: ["question"], audits: [] },
  QuestionAnswerResult: { verbs: ["question.answer"], values: ["question"], audits: [] },
  QuestionWithdrawResult: { verbs: ["question.withdraw"], values: ["question"], audits: [] },
  QuestionDismissResult: { verbs: ["question.dismiss"], values: ["question"], audits: [] },
  ActionReportResult: { verbs: ["action.report"], values: ["question"], audits: [] },
  QuestionListResult: { verbs: ["question.list"], values: ["questions[]"], audits: [] },
  SnapshotResult: { verbs: ["snapshot", "watch"], values: ["questions[]"], audits: [] },
  AuditTailResult: { verbs: ["audit.tail"], values: [], audits: ["rows[]"] },
  WatchFrame: { verbs: [], values: [], audits: ["events[]"] },
} as const satisfies Record<string, { verbs: readonly RpcVerb[]; values: readonly string[]; audits: readonly string[] }>;
export const QUESTION_DISMISSAL_AUDITS: Readonly<Record<string, readonly string[]>> = {
  "question.asked": ["question"],
  "question.dismissed": [""],
};

const routes = new Map<string, { values: readonly string[]; audits: readonly string[] }>(Object.values(QUESTION_DISMISSAL_RESULTS).flatMap(coverage => coverage.verbs.map(verb => [verb, coverage] as const)));
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function legacyQuestion(value: unknown): unknown {
  if (!record(value)) return value;
  const { dismissedAt, dismissedBy, dismissalMessageId, ...question } = value;
  if (question.status === "dismissed") return { ...question, status: "withdrawn", withdrawalReason: "Dismissed without an answer", withdrawnAt: dismissedAt };
  return Object.hasOwn(value, "dismissedAt") || Object.hasOwn(value, "dismissedBy") || Object.hasOwn(value, "dismissalMessageId") ? question : value;
}

function legacyAudit(value: unknown): unknown {
  if (!record(value) || typeof value.kind !== "string") return value;
  const paths = QUESTION_DISMISSAL_AUDITS[value.kind];
  if (!paths) return value;
  if (value.kind === "question.dismissed" && record(value.payload)) {
    const payload = { questionId: value.payload.questionId, withdrawalReason: "Dismissed without an answer", withdrawnAt: value.payload.dismissedAt, ...(value.payload.rpcCaller === undefined ? {} : { rpcCaller: value.payload.rpcCaller }) };
    return { ...value, kind: "question.withdrawn", payload };
  }
  return paths.reduce((row, path) => rewritePath(row, ["payload", ...path.split(".")], legacyQuestion), value as unknown);
}

function project(value: unknown, coverage: { values: readonly string[]; audits: readonly string[] }): unknown {
  let result = value;
  for (const path of coverage.values) result = rewritePath(result, path.split("."), legacyQuestion);
  for (const path of coverage.audits) result = rewritePath(result, path.split("."), legacyAudit);
  if (coverage === QUESTION_DISMISSAL_RESULTS.QuestionWithdrawResult && record(result) && result.alreadyTerminal === "dismissed") {
    const { alreadyTerminal, ...legacy } = result;
    return legacy;
  }
  return result;
}

export function projectQuestionDismissalError(error: RpcErrorShape, capabilities: readonly string[]): RpcErrorShape {
  if (capabilities.includes(QUESTION_DISMISSED_CAPABILITY) || error.code !== "question_dismissed") return error;
  return { code: "question_withdrawn", message: "This question was withdrawn: Dismissed without an answer", details: { withdrawalReason: "Dismissed without an answer" } };
}

export function projectQuestionDismissalResult(verb: RpcVerb, value: unknown, capabilities: readonly string[]): unknown {
  if (capabilities.includes(QUESTION_DISMISSED_CAPABILITY)) return value;
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

export function projectQuestionDismissalDelta(value: unknown, capabilities: readonly string[]): unknown {
  return capabilities.includes(QUESTION_DISMISSED_CAPABILITY) ? value : project(value, QUESTION_DISMISSAL_RESULTS.WatchFrame);
}
