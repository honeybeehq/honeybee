/**
 * Action queue helpers (schema v24). Pure: the built-in definition registry,
 * request hashing, `$ref` resolution, output validation, the instruction
 * body an agent receives, hold/controls derivation and the view projection.
 * Durable rows live in the core store; the daemon drives dispatch.
 */
import { createHash } from "node:crypto";
import { stableStringify } from "./registry.ts";
import {
  ACTION_TRANSITIONS,
  type ActionControls,
  type ActionDefinition,
  type ActionExecutor,
  type ActionHold,
  type ActionOutputRef,
  type ActionQueueRow,
  type ActionQueueView,
  type ActionRow,
  type ActionStatus,
  type ActionView,
} from "./types.ts";

/** The sender the dispatched instruction is attributed to (delivered bare, never enveloped as peer mail). */
export const ACTION_DISPATCH_SENDER = "hive:action";

export const ACTION_DISPATCH_MARKER = "[Hive action]";

export const ACTION_OPEN_STATUSES: readonly ActionStatus[] = ["queued", "running", "waiting"];
export const ACTION_TERMINAL_STATUSES: readonly ActionStatus[] = ["succeeded", "failed", "cancelled"];

const SHA_PATTERN = "^[0-9a-f]{7,64}$";
const BRANCH_PATTERN = "^[^\\s~^:?*\\[\\\\]+$";

/**
 * Built-in definitions, keyed `kind@version`. A queued instance snapshots
 * the definition it was accepted with. Custom/user-defined definitions are a
 * later slice; the registry shape is what they would extend.
 */
export const BUILTIN_ACTION_DEFINITIONS: readonly ActionDefinition[] = [
  {
    kind: "commit",
    version: 1,
    executor: "agent",
    title: "Commit",
    description: "Commit the bee's current work in its checkout and report the resulting commit.",
    inputs: [
      { name: "message", required: false, description: "Suggested commit message (the agent may refine it)." },
      { name: "instruction", required: false, description: "Extra guidance appended to the instruction." },
      { name: "urgency", required: false, description: "Mailbox urgency for the instruction: now|next|idle (default next)." },
    ],
    outputs: [
      { name: "commitSha", required: true, pattern: SHA_PATTERN, description: "Full sha of the commit that was created (or the existing HEAD when nothing needed committing)." },
      { name: "branch", required: false, pattern: BRANCH_PATTERN, description: "Branch the commit is on." },
    ],
    instruction:
      "Commit the work in your checkout now. Stage only the changes that belong to your current task, write a clear commit message, and create exactly one commit (if there is nothing to commit, report the current HEAD as commitSha).",
  },
  {
    kind: "name_branch",
    version: 1,
    executor: "agent",
    title: "Name branch",
    description: "Create or rename the working branch to a descriptive name and report it.",
    inputs: [
      { name: "instruction", required: false, description: "Extra guidance appended to the instruction." },
      { name: "urgency", required: false, description: "Mailbox urgency for the instruction: now|next|idle (default next)." },
    ],
    outputs: [{ name: "branch", required: true, pattern: BRANCH_PATTERN, description: "The branch name now checked out." }],
    instruction:
      "Give your working branch a short, descriptive name that reflects the change you are making (create it or rename the current branch), then report the branch name.",
  },
  {
    kind: "fix",
    version: 1,
    executor: "agent",
    title: "Fix issues",
    description: "Address review findings / failing checks in the checkout.",
    inputs: [
      { name: "instruction", required: false, description: "What to fix (findings, failing checks)." },
      { name: "urgency", required: false, description: "Mailbox urgency for the instruction: now|next|idle (default next)." },
    ],
    outputs: [{ name: "summary", required: false, pattern: null, description: "One-line summary of what was fixed." }],
    instruction: "Fix the issues described below in your checkout. Verify the fix (run the relevant checks) before reporting.",
  },
  {
    kind: "instruction",
    version: 1,
    executor: "agent",
    title: "Instruction",
    description: "A free-form agent instruction with a structured completion report.",
    inputs: [
      { name: "instruction", required: true, description: "The instruction body." },
      { name: "title", required: false, description: "Display title for the queue." },
      { name: "outputs", required: false, description: "Names of outputs the agent must report (string[])." },
      { name: "urgency", required: false, description: "Mailbox urgency for the instruction: now|next|idle (default next)." },
    ],
    outputs: [],
    instruction: null,
  },
  {
    kind: "land",
    version: 1,
    executor: "cell.capture",
    title: "Land",
    description: "Land the Cell's HEAD onto a branch in the origin repository (Honeybee cell.capture receipt).",
    inputs: [
      { name: "targetBranch", required: true, description: "Branch in the origin to land onto (created if absent)." },
      { name: "mode", required: false, description: "merge|rebase (default merge)." },
      { name: "commit", required: false, description: "The commit expected at the Cell HEAD (usually a $ref to a predecessor's commitSha); revalidated before the effect." },
    ],
    outputs: [
      { name: "resultSha", required: true, pattern: SHA_PATTERN, description: "The commit the target branch points at after landing." },
      { name: "targetBranch", required: true, pattern: BRANCH_PATTERN, description: "The branch that was landed onto." },
      { name: "cellHead", required: true, pattern: SHA_PATTERN, description: "The Cell HEAD that was captured." },
      { name: "alreadyLanded", required: false, pattern: null, description: "True when the target already contained the Cell HEAD (nothing_to_capture)." },
    ],
    instruction: null,
  },
  {
    kind: "land",
    version: 2,
    executor: "external",
    title: "Land",
    description: "Land committed Cell work through Apiary's destination landing queue.",
    inputs: [
      { name: "destination", required: true, description: "Pinned destination {nodeId, root, branch}; executed by that Apiary workstation." },
      { name: "commit", required: false, description: "Expected source HEAD, optionally a predecessor commitSha reference." },
    ],
    outputs: [
      { name: "resultSha", required: true, pattern: SHA_PATTERN, description: "Durably integrated result commit." },
      { name: "targetBranch", required: true, pattern: BRANCH_PATTERN, description: "Destination branch." },
      { name: "cellHead", required: true, pattern: SHA_PATTERN, description: "Pinned source commit." },
    ],
    instruction: null,
  },
  {
    kind: "archive",
    version: 1,
    executor: "lifecycle.archive",
    title: "Archive",
    description: "Archive the bee (lifecycle active → archived) once its predecessors succeeded.",
    inputs: [],
    outputs: [{ name: "archivedAt", required: true, pattern: null, description: "When the bee was archived." }],
    instruction: null,
  },
  {
    kind: "push",
    version: 1,
    executor: "external",
    title: "Push",
    description: "Push the branch to its remote (external executor: Apiary's git owner).",
    inputs: [
      { name: "branch", required: false, description: "Branch to push (default: the bee's current branch)." },
      { name: "remote", required: false, description: "Remote name (default origin)." },
    ],
    outputs: [
      { name: "remote", required: false, pattern: null, description: "Remote pushed to." },
      { name: "branch", required: false, pattern: BRANCH_PATTERN, description: "Branch pushed." },
      { name: "sha", required: false, pattern: SHA_PATTERN, description: "Remote tip after the push." },
    ],
    instruction: null,
  },
  {
    kind: "open_pr",
    version: 1,
    executor: "external",
    title: "Open PR",
    description: "Open a pull request for the branch (external executor: Apiary's GitHub owner).",
    inputs: [
      { name: "branch", required: false, description: "Head branch (default: the bee's current branch)." },
      { name: "base", required: false, description: "Base branch." },
      { name: "title", required: false, description: "PR title." },
      { name: "body", required: false, description: "PR body." },
    ],
    outputs: [
      { name: "prUrl", required: true, pattern: null, description: "URL of the opened pull request." },
      { name: "prNumber", required: false, pattern: null, description: "Pull request number." },
    ],
    instruction: null,
  },
];

export function findActionDefinition(kind: string, version: number | null): ActionDefinition | null {
  const candidates = BUILTIN_ACTION_DEFINITIONS.filter((d) => d.kind === kind);
  if (candidates.length === 0) return null;
  // Existing CLI callers omit version and supply targetBranch for Cell capture.
  // Apiary explicitly selects v2 with a workstation destination.
  if (version === null && kind === "land") return candidates.find((d) => d.version === 1)!;
  if (version === null) return candidates.reduce((a, b) => (b.version > a.version ? b : a));
  return candidates.find((d) => d.version === version) ?? null;
}

export interface ActionEnqueueItemShape {
  kind: string;
  version: number | null;
  inputs: Record<string, unknown>;
  clientRef: string | null;
  title: string | null;
}

export interface ActionEnqueueRequestShape {
  beeId: string;
  items: ActionEnqueueItemShape[];
}

export function hashActionEnqueueRequest(input: ActionEnqueueRequestShape): string {
  return createHash("sha256").update(stableStringify(input)).digest("hex");
}

export function actionTransitionLegal(from: ActionStatus, to: ActionStatus): boolean {
  return from === to || (ACTION_TRANSITIONS[from] as readonly string[]).includes(to);
}

export function isActionOutputRef(value: unknown): value is ActionOutputRef {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const ref = (value as { $ref?: unknown }).$ref;
  if (ref === null || typeof ref !== "object" || Array.isArray(ref)) return false;
  const r = ref as Record<string, unknown>;
  return typeof r.action === "string" && r.action.length > 0 && typeof r.output === "string" && r.output.length > 0;
}

/** Same-request item reference (`{$ref:{item:0, output:"commitSha"}}`), rewritten to an action id at acceptance. */
export function isActionItemRef(value: unknown): value is { $ref: { item: number; output: string } } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const ref = (value as { $ref?: unknown }).$ref;
  if (ref === null || typeof ref !== "object" || Array.isArray(ref)) return false;
  const r = ref as Record<string, unknown>;
  return typeof r.item === "number" && Number.isInteger(r.item) && r.item >= 0 && typeof r.output === "string" && r.output.length > 0;
}

/** Every `$ref.action` id an input object names (top-level values only). */
export function actionRefTargets(inputs: Record<string, unknown>): Array<{ input: string; action: string; output: string }> {
  const out: Array<{ input: string; action: string; output: string }> = [];
  for (const [name, value] of Object.entries(inputs)) {
    if (isActionOutputRef(value)) out.push({ input: name, action: value.$ref.action, output: value.$ref.output });
  }
  return out;
}

export type ResolveActionInputsResult =
  | { ok: true; resolved: Record<string, unknown> }
  | { ok: false; input: string; action: string; output: string; reason: "missing_action" | "not_succeeded" | "missing_output" };

/**
 * Resolve `$ref` inputs against predecessor results at dispatch time. A
 * reference to an action that has not succeeded (or whose result lacks the
 * output) is a typed refusal, never a silent null.
 */
export function resolveActionInputs(
  inputs: Record<string, unknown>,
  lookup: (actionId: string) => ActionRow | null,
): ResolveActionInputsResult {
  const resolved: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(inputs)) {
    if (!isActionOutputRef(value)) {
      resolved[name] = value;
      continue;
    }
    const target = lookup(value.$ref.action);
    if (!target) return { ok: false, input: name, action: value.$ref.action, output: value.$ref.output, reason: "missing_action" };
    if (target.status !== "succeeded" || !target.result) {
      return { ok: false, input: name, action: value.$ref.action, output: value.$ref.output, reason: "not_succeeded" };
    }
    if (!(value.$ref.output in target.result.outputs)) {
      return { ok: false, input: name, action: value.$ref.action, output: value.$ref.output, reason: "missing_output" };
    }
    resolved[name] = target.result.outputs[value.$ref.output];
  }
  return { ok: true, resolved };
}

export type ValidateOutputsResult = { ok: true } | { ok: false; output: string; reason: "missing" | "not_string" | "pattern" };

/** Required outputs present; string outputs match their pattern. Extra outputs are allowed. */
export function validateActionOutputs(definition: ActionDefinition, outputs: Record<string, unknown>, extraRequired: readonly string[] = []): ValidateOutputsResult {
  for (const spec of definition.outputs) {
    const value = outputs[spec.name];
    if (value === undefined || value === null) {
      if (spec.required) return { ok: false, output: spec.name, reason: "missing" };
      continue;
    }
    if (spec.pattern !== null) {
      if (typeof value !== "string") return { ok: false, output: spec.name, reason: "not_string" };
      if (!new RegExp(spec.pattern).test(value)) return { ok: false, output: spec.name, reason: "pattern" };
    }
  }
  for (const name of extraRequired) {
    const value = outputs[name];
    if (value === undefined || value === null || (typeof value === "string" && value.length === 0)) {
      return { ok: false, output: name, reason: "missing" };
    }
  }
  return { ok: true };
}

/** Output names the `instruction` kind asks for (`inputs.outputs: string[]`). */
export function requestedOutputNames(inputs: Record<string, unknown>): string[] {
  const raw = inputs.outputs;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string" && v.length > 0);
}

/** The mailbox body an agent receives for one attempt. Carries the attempt token: it IS the report capability. */
export function renderActionInstruction(action: ActionRow, resolved: Record<string, unknown>, token: string, attempt: number): string {
  const def = action.definition;
  const lines: string[] = [`${ACTION_DISPATCH_MARKER} ${def.title} — action ${action.id}, attempt ${attempt}`, ""];
  const extra = typeof resolved.instruction === "string" ? resolved.instruction.trim() : "";
  if (def.instruction) lines.push(def.instruction);
  if (extra) lines.push(def.instruction ? "" : "", extra);
  if (typeof resolved.message === "string" && resolved.message.trim().length > 0) {
    lines.push("", `Suggested commit message: ${resolved.message.trim()}`);
  }
  const contextual = Object.entries(resolved).filter(([k]) => !["instruction", "message", "urgency", "outputs", "title"].includes(k));
  if (contextual.length > 0) {
    lines.push("", "Inputs:");
    for (const [k, v] of contextual) lines.push(`- ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  }
  const outputs = [...def.outputs.map((o) => ({ name: o.name, required: o.required, description: o.description })), ...requestedOutputNames(resolved).map((name) => ({ name, required: true, description: "" }))];
  const base = `hive action report ${action.id} --attempt ${attempt} --token ${token}`;
  lines.push(
    "",
    "When you are done, report the outcome with the hive CLI. Finishing your turn does NOT complete this action; only the report does:",
    `  ${base} --succeeded${outputs.filter((o) => o.required).map((o) => ` --output ${o.name}=<${o.name}>`).join("")}`,
    `  ${base} --failed --detail "<why>"`,
    `  ${base} --ask "<question for the operator>"    (holds the queue until answered; the answer arrives as mail)`,
    `  ${base} --progress "<short status>"`,
  );
  if (outputs.length > 0) {
    lines.push("", "Outputs:");
    for (const o of outputs) lines.push(`- ${o.name}${o.required ? " (required)" : ""}${o.description ? `: ${o.description}` : ""}`);
  }
  lines.push("", "Queued actions after this one wait for your report; do not start them yourself.");
  return lines.join("\n");
}

/** Does the row still own the bee's execution lane? */
export function actionIsActive(row: Pick<ActionRow, "status">): boolean {
  return row.status === "running" || row.status === "waiting";
}

/** The nearest non-cancelled action before `row` in the lane (positional predecessor). */
export function actionPredecessor(row: ActionRow, lane: readonly ActionRow[]): ActionRow | null {
  let best: ActionRow | null = null;
  for (const other of lane) {
    if (other.id === row.id || other.beeId !== row.beeId) continue;
    if (other.position >= row.position || other.status === "cancelled") continue;
    if (best === null || other.position > best.position) best = other;
  }
  return best;
}

export function deriveActionHold(row: ActionRow, lane: readonly ActionRow[], queue: Pick<ActionQueueRow, "paused"> | null): ActionHold | null {
  if (row.status !== "queued") return null;
  const pred = actionPredecessor(row, lane);
  // Only the fallback needs the active row; keep single-action reads lazy.
  const active = !pred || pred.status === "succeeded"
    ? (queue?.paused ? null : lane.find((o) => o.id !== row.id && actionIsActive(o)) ?? null)
    : null;
  return actionHold(pred, active, queue);
}

function actionHold(pred: ActionRow | null, active: ActionRow | null, queue: Pick<ActionQueueRow, "paused"> | null): ActionHold | null {
  if (pred && pred.status === "failed") return { reason: "predecessor_failed", actionId: pred.id, actionStatus: pred.status };
  if (pred && pred.status !== "succeeded") return { reason: "predecessor_active", actionId: pred.id, actionStatus: pred.status };
  if (queue?.paused) return { reason: "paused", actionId: null, actionStatus: null };
  if (active) return { reason: "lane_busy", actionId: active.id, actionStatus: active.status };
  return null;
}

export function deriveActionControls(row: ActionRow): ActionControls {
  const undeliveredAgent = row.executor === "agent" && row.status === "running" && row.dispatch?.deliveredAt == null;
  const unclaimedExternal = row.executor === "external" && row.status === "waiting" && row.waitingReason === "executor" && row.dispatch?.claimedBy == null;
  const cancel = row.status === "queued" || undeliveredAgent || unclaimedExternal;
  const forceCancel = !cancel && actionIsActive(row) && row.executor !== "lifecycle.archive";
  const retry = row.status === "failed";
  const forceRetry = row.status === "waiting" && row.waitingReason === "uncertain";
  return { cancel, forceCancel, retry, forceRetry, reorder: row.status === "queued" };
}

/** Locked RPC/mirror projection. Drops the token; derives hold + controls from the lane. */
export function toActionView(row: ActionRow, lane: readonly ActionRow[], queue: Pick<ActionQueueRow, "paused"> | null): ActionView {
  return actionViewWithHold(row, deriveActionHold(row, lane, queue));
}

/**
 * Project a same-bee selection and its complete lane, both in increasing position
 * order (as returned by the store). Cancelled rows never become predecessors.
 * A status-filtered selection still derives holds from the complete lane.
 */
export function toActionViews(rows: readonly ActionRow[], lane: readonly ActionRow[], queue: Pick<ActionQueueRow, "paused"> | null): ActionView[] {
  const active = !queue?.paused && rows.some((row) => row.status === "queued")
    ? lane.find(actionIsActive) ?? null : null;
  let cursor = 0;
  let pred: ActionRow | null = null;
  return rows.map((row) => {
    if (row.status !== "queued") return actionViewWithHold(row, null);
    while (cursor < lane.length) {
      const previous = lane[cursor]!;
      if (previous.position >= row.position) break;
      if (previous.status !== "cancelled") pred = previous;
      cursor++;
    }
    return actionViewWithHold(row, actionHold(pred, active, queue));
  });
}

function actionViewWithHold(row: ActionRow, hold: ActionHold | null): ActionView {
  const { attemptToken: _token, enqueueKey: _key, ...rest } = row;
  return { ...rest, hold, controls: deriveActionControls(row) };
}

export function toActionQueueView(row: ActionQueueRow): ActionQueueView {
  const { nextPosition: _next, ...view } = row;
  return view;
}

export function emptyActionCounts(): Record<ActionStatus, number> {
  return { queued: 0, running: 0, waiting: 0, succeeded: 0, failed: 0, cancelled: 0 };
}

export function actionOperationKey(actionId: string, attempt: number): string {
  return `action:${actionId}:a${attempt}`;
}

/** Executors Honeybee can run without an external claimant. */
export function executorIsInternal(executor: ActionExecutor): boolean {
  return executor === "agent" || executor === "cell.capture" || executor === "lifecycle.archive";
}
