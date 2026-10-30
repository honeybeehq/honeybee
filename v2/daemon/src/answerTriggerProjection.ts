import type { RpcVerb } from "./protocol.ts";

export const ANSWER_TRIGGER_CAPABILITY = "turn-trigger.answer.v1";
export const ANSWER_TRIGGER_RESULTS = {
  BeeTellResult: { verbs: ["bee.tell"], triggers: ["tell.turnTrigger"], audits: [] },
  BeeReactResult: { verbs: ["bee.react"], triggers: ["reaction.turnTrigger"], audits: [] },
  SetHumanOutputModeResult: { verbs: ["bee.setHumanOutputMode"], triggers: ["unansweredHumanMessage"], audits: [] },
  RenameResult: { verbs: ["bee.rename"], triggers: ["bee.lastTurnTrigger", "bee.unansweredHumanMessage"], audits: [] },
  TagResult: { verbs: ["bee.tag"], triggers: ["bee.lastTurnTrigger", "bee.unansweredHumanMessage"], audits: [] },
  ForkResult: { verbs: ["bee.fork"], triggers: ["bee.lastTurnTrigger", "bee.unansweredHumanMessage"], audits: [] },
  ChildrenResult: { verbs: ["bee.children"], triggers: ["children[].bee.lastTurnTrigger", "children[].bee.unansweredHumanMessage", "children[].view.unansweredHumanMessage"], audits: [] },
  SetArgsResult: { verbs: ["bee.setArgs"], triggers: ["bee.lastTurnTrigger", "bee.unansweredHumanMessage"], audits: [] },
  ReconfigureResult: { verbs: ["bee.reconfigure"], triggers: ["bee.lastTurnTrigger", "bee.unansweredHumanMessage"], audits: [] },
  ViewResult: { verbs: ["view"], triggers: ["bee.lastTurnTrigger", "bee.unansweredHumanMessage", "view.unansweredHumanMessage"], audits: [] },
  ChampionGetResult: { verbs: ["champion.get"], triggers: ["bee.bee.lastTurnTrigger", "bee.bee.unansweredHumanMessage", "bee.view.unansweredHumanMessage"], audits: [] },
  ListResult: { verbs: ["list"], triggers: ["views[].bee.lastTurnTrigger", "views[].bee.unansweredHumanMessage", "views[].view.unansweredHumanMessage"], audits: [] },
  SnapshotResult: { verbs: ["snapshot", "watch"], triggers: ["views[].bee.lastTurnTrigger", "views[].bee.unansweredHumanMessage", "views[].view.unansweredHumanMessage", "tells[].turnTrigger", "reactions[].turnTrigger"], audits: [] },
  AuditTailResult: { verbs: ["audit.tail"], triggers: [], audits: ["rows[]"] },
  WatchFrame: { verbs: [], triggers: [], audits: ["events[]"] },
} as const satisfies Record<string, { verbs: readonly RpcVerb[]; triggers: readonly string[]; audits: readonly string[] }>;
export const ANSWER_TRIGGER_AUDITS: Readonly<Record<string, readonly string[]>> = {
  "bee.created": ["bee.lastTurnTrigger", "bee.unansweredHumanMessage"],
  "bee.told": ["tell.turnTrigger", "unansweredHumanMessage"],
  "bee.reacted": ["reaction.turnTrigger", "unansweredHumanMessage"],
  "bee.human_output_mode_changed": ["unansweredHumanMessage"],
  "runtime.updated": ["turnTrigger"],
  "mail.delivered": ["turnTrigger", "unansweredHumanMessage"],
};

const routes = new Map<string, { triggers: readonly string[]; audits: readonly string[] }>(
  Object.values(ANSWER_TRIGGER_RESULTS).flatMap((coverage) => coverage.verbs.map((verb) => [verb, coverage] as const)),
);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function rewritePath(value: unknown, parts: readonly string[], rewrite: (value: unknown) => unknown): unknown {
  if (parts.length === 0) return rewrite(value);
  if (!record(value)) return value;
  const [part, ...rest] = parts;
  const array = part!.endsWith("[]");
  const key = array ? part!.slice(0, -2) : part!;
  const current = value[key];
  let updated: unknown;
  if (array) {
    if (!Array.isArray(current)) return value;
    const items = current.map((entry) => rewritePath(entry, rest, rewrite));
    updated = items.every((entry, index) => entry === current[index]) ? current : items;
  } else {
    updated = rewritePath(current, rest, rewrite);
  }
  return updated === current ? value : { ...value, [key]: updated };
}

function legacyTrigger(value: unknown): unknown {
  if (!record(value)) return value;
  let projected = value;
  if (value.kind === "answer") projected = { ...projected, kind: "human" };
  if (value.triggerKind === "answer") projected = { ...projected, triggerKind: "human" };
  return projected;
}

function legacyAudit(value: unknown): unknown {
  if (!record(value) || typeof value.kind !== "string") return value;
  const paths = ANSWER_TRIGGER_AUDITS[value.kind];
  if (!paths) return value;
  return paths.reduce((row, path) => rewritePath(row, ["payload", ...path.split(".")], legacyTrigger), value as unknown);
}

function project(value: unknown, coverage: { triggers: readonly string[]; audits: readonly string[] }): unknown {
  let result = value;
  for (const path of coverage.triggers) result = rewritePath(result, path.split("."), legacyTrigger);
  for (const path of coverage.audits) result = rewritePath(result, path.split("."), legacyAudit);
  return result;
}

export function projectAnswerTriggerResult(verb: RpcVerb, value: unknown, capabilities: readonly string[]): unknown {
  if (capabilities.includes(ANSWER_TRIGGER_CAPABILITY)) return value;
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

export function projectAnswerTriggerDelta(value: unknown, capabilities: readonly string[]): unknown {
  return capabilities.includes(ANSWER_TRIGGER_CAPABILITY) ? value : project(value, ANSWER_TRIGGER_RESULTS.WatchFrame);
}
