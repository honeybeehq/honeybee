export type ContextBaselineObservation =
  | { kind: "start"; requestId: string }
  | { kind: "thread"; requestId: string; providerThreadId: string }
  | { kind: "input"; providerThreadId: string; characters: number; complete: boolean }
  | { kind: "invalidate"; providerThreadId?: string };

export function contextBaselineObservation(value: unknown): ContextBaselineObservation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const id = (s: unknown): s is string => typeof s === "string" && s.length > 0 && s.length <= 256;
  if (v.kind === "invalidate" && (v.providerThreadId === undefined || id(v.providerThreadId))) return { kind: "invalidate", ...(id(v.providerThreadId) ? { providerThreadId: v.providerThreadId } : {}) };
  if (v.kind === "start" && id(v.requestId)) return { kind: "start", requestId: v.requestId };
  if (v.kind === "thread" && id(v.requestId) && id(v.providerThreadId)) return { kind: "thread", requestId: v.requestId, providerThreadId: v.providerThreadId };
  if (v.kind === "input" && id(v.providerThreadId) && typeof v.characters === "number" && Number.isSafeInteger(v.characters) && v.characters >= 0 && typeof v.complete === "boolean") {
    return { kind: "input", providerThreadId: v.providerThreadId, characters: v.characters, complete: v.complete };
  }
  return undefined;
}

export type ContextCategoryId = "system" | "project" | "skills" | "definitions" | "messages" | "tools" | "reasoning" | "summary";
export interface ContextSourceSize { id?: string; category: ContextCategoryId; label: string; characters: number }
interface LegacyContextInventory {
  scope: "instructions" | "replacement";
  sources: ContextSourceSize[];
}

export interface RecordedInstructionInventory {
  version: 1;
  scope: "instructions";
  sources: (ContextSourceSize & { id: string })[];
  identity: {
    beeId: string;
    generation: number | null;
    providerThreadId: string;
    model: string | null;
    turnId: string | null;
    requestId: string | null;
  };
  provenance: {
    source: "codex-rollout";
    path: string;
    method: "recorded-instruction-text";
    exactRequest: false;
    cutoffLine: number;
    truncated: boolean;
  };
}
export type ContextInventory = LegacyContextInventory | RecordedInstructionInventory;

const boundedText = (value: unknown, max = 512): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const nullableText = (value: unknown): boolean => value === null || boundedText(value);

export function isRecordedInstructionInventory(value: unknown): value is RecordedInstructionInventory {
  if (!value || typeof value !== "object") return false;
  const v = value as RecordedInstructionInventory;
  const identity = v.identity;
  const provenance = v.provenance;
  return v.version === 1 && v.scope === "instructions" && validSources(v.sources) && v.sources.length <= 64 &&
    v.sources.every((s) => boundedText(s.id) && ["system", "project", "skills", "definitions"].includes(s.category)) &&
    new Set(v.sources.map((s) => s.id)).size === v.sources.length &&
    !!identity && boundedText(identity.beeId) && (identity.generation === null || count(identity.generation)) &&
    boundedText(identity.providerThreadId) && nullableText(identity.model) && nullableText(identity.turnId) && nullableText(identity.requestId) &&
    !!provenance && provenance.source === "codex-rollout" && boundedText(provenance.path, 4096) &&
    provenance.method === "recorded-instruction-text" && provenance.exactRequest === false &&
    count(provenance.cutoffLine) && typeof provenance.truncated === "boolean";
}

export function recordedInstructionMetadata(value: unknown): RecordedInstructionInventory | undefined {
  if (!isRecordedInstructionInventory(value)) return undefined;
  const { beeId, generation, providerThreadId, model, turnId, requestId } = value.identity;
  const { source, path, method, exactRequest, cutoffLine, truncated } = value.provenance;
  return { version: 1, scope: "instructions",
    sources: value.sources.map(({ id, category, label, characters }) => ({ id, category, label, characters })),
    identity: { beeId, generation, providerThreadId, model, turnId, requestId },
    provenance: { source, path, method, exactRequest, cutoffLine, truncated } };
}

export function contextTextSources(role: string, text: string): ContextSourceSize[] {
  const sources: ContextSourceSize[] = [];
  const add = (category: ContextCategoryId, label: string, value: string): void => {
    if (value) sources.push({ category, label, characters: value.length });
  };
  if (role === "user" && text.startsWith("<skill>") &&
    /^<skill>\s*<name>\s*[^\s<][^<]*<\/name>\s*<path>\s*[^\s<][^<]*<\/path>[\s\S]*<\/skill>\s*$/.test(text)) {
    add("skills", "Loaded skill instructions", text);
    return sources;
  }
  const instructions = role === "system" || role === "developer";
  const project = role === "user" ? text.match(/^# AGENTS\.md instructions for [^\n]+\r?\n\s*<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/)?.[0] : undefined;
  let content = project ?? text;
  if (project) add("messages", "User messages", text.slice(project.length));
  if (instructions || project) content = content.replace(/<skills_instructions>[\s\S]*?<\/skills_instructions>/g, (section) => {
    add("skills", "Skill catalog & instructions", section);
    return "";
  });
  add(project ? "project" : instructions ? "system" : "messages", project ? "AGENTS.md instructions" : `${role[0]?.toUpperCase() ?? ""}${role.slice(1)} ${instructions ? "instructions" : "messages"}`, content);
  return sources;
}

export function isContextInventory(value: unknown): value is ContextInventory {
  if (!value || typeof value !== "object") return false;
  if ("version" in value) return isRecordedInstructionInventory(value);
  const v = value as ContextInventory;
  return (v.scope === "instructions" || v.scope === "replacement") && validSources(v.sources);
}

function validSources(value: unknown): value is ContextSourceSize[] {
  return Array.isArray(value) && value.length <= 256 && value.every((s) =>
    s && ["system", "project", "skills", "definitions", "messages", "tools", "reasoning", "summary"].includes(s.category) &&
    boundedText(s.label) && count(s.characters)) && Number.isSafeInteger(value.reduce((sum, s) => sum + s.characters, 0));
}

export const CONTEXT_CATEGORIES: readonly ContextCategoryId[] = ["system", "project", "skills", "definitions", "messages", "tools", "reasoning", "summary"];

export interface ContextSnapshot {
  version: 1;
  scope: "request";
  status: "complete";
  identity: {
    beeId: string | null; generation: number | null; providerThreadId: string; model: string; turnId: string;
    inferenceCallId: string | null; responseId: string; requestId: string | null; attempt: number | null;
  };
  measuredAt: number;
  usage: {
    inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number; outputTokens: number;
    reasoningOutputTokens: number; totalTokens: number; contextWindow: number | null;
    source: "codex-inference-response";
  };
  provenance: {
    source: "codex-rollout-trace" | "codex-request-accounting"; method: "captured-request"; captureStage: "codex-inference-request" | "codex-logical-request";
    exactRequest: boolean; traceId: string; sequence: number; path: string | null;
    coverage: "captured-body" | "incremental-body"; limitations: string[];
    transport?: "responses-http" | "responses-websocket";
  };
  categories: Record<ContextCategoryId, {
    characters: number; estimatedTokens: number; tokens: null;
    method: "characters-div-4"; characterMethod: "decoded-text" | "serialized-json";
  }>;
  opaque: { encryptedCharacters: number; mediaItems: number; unknownItems: number; tokens: null };
  request: {
    inputItems: number; toolDefinitions: number; serializedCharacters: number;
    unattributedSerializedCharacters: number; previousResponseId: string | null;
  };
  providerOverhead: { tokens: null };
}

export interface ContextSnapshotInvalidation {
  version: 1; providerThreadId: string; observedAt: number; reason: "uncaptured-compaction";
}

const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown, max = 512): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const nullableCount = (value: unknown): boolean => value === null || count(value);
const timestamp = (value: unknown): value is number => count(value) && value <= 8_640_000_000_000_000;

export function contextSnapshotMetadata(value: unknown, { allowUnboundOwner = false }: { allowUnboundOwner?: boolean } = {}): ContextSnapshot | undefined {
  const v = object(value);
  if (!v || v.version !== 1 || v.scope !== "request" || v.status !== "complete" || !timestamp(v.measuredAt)) return;
  const i = object(v.identity), u = object(v.usage), p = object(v.provenance), c = object(v.categories);
  const o = object(v.opaque), r = object(v.request);
  if (!i || !(text(i.beeId) || (allowUnboundOwner && i.beeId === null)) || !["providerThreadId", "model", "turnId", "responseId"].every((key) => text(i[key])) ||
    !nullableText(i.inferenceCallId) || !nullableCount(i.generation) || !nullableText(i.requestId) || !nullableCount(i.attempt)) return;
  if (!u || u.source !== "codex-inference-response" || !["inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"].every((key) => count(u[key])) ||
    !nullableCount(u.contextWindow) || (u.cachedInputTokens as number) > (u.inputTokens as number)) return;
  if (!p || !["codex-rollout-trace", "codex-request-accounting"].includes(p.source as string) || p.method !== "captured-request" || !["codex-inference-request", "codex-logical-request"].includes(p.captureStage as string) ||
    typeof p.exactRequest !== "boolean" || !text(p.traceId) || !count(p.sequence) || !(text(p.path, 4096) || (p.source === "codex-request-accounting" && p.path === null)) ||
    !["captured-body", "incremental-body"].includes(p.coverage as string) || !Array.isArray(p.limitations) ||
    p.limitations.length > 16 || !p.limitations.every((item) => text(item, 128))) return;
  if (i.beeId === null && p.source !== "codex-request-accounting") return;
  if (i.inferenceCallId === null && p.source !== "codex-request-accounting") return;
  if (p.transport !== undefined && !["responses-http", "responses-websocket"].includes(p.transport as string)) return;
  if (!o || !["encryptedCharacters", "mediaItems", "unknownItems"].every((key) => count(o[key])) || o.tokens !== null || object(v.providerOverhead)?.tokens !== null) return;
  if (!r || !["inputItems", "toolDefinitions", "serializedCharacters", "unattributedSerializedCharacters"].every((key) => count(r[key])) || !nullableText(r.previousResponseId)) return;
  if (p.exactRequest && (p.coverage !== "captured-body" || r.previousResponseId !== null)) return;
  if (!c) return;
  const categories = {} as ContextSnapshot["categories"];
  for (const id of CONTEXT_CATEGORIES) {
    const row = object(c[id]);
    if (!row || !count(row.characters) || !count(row.estimatedTokens) || row.estimatedTokens !== Math.ceil(row.characters / 4) ||
      row.tokens !== null || row.method !== "characters-div-4" || !["decoded-text", "serialized-json"].includes(row.characterMethod as string)) return;
    categories[id] = { characters: row.characters, estimatedTokens: row.estimatedTokens, tokens: null, method: "characters-div-4", characterMethod: row.characterMethod as "decoded-text" | "serialized-json" };
  }
  if (!Number.isSafeInteger(Object.values(categories).reduce((sum, row) => sum + row.characters, 0))) return;
  return {
    version: 1, scope: "request", status: "complete", measuredAt: v.measuredAt,
    identity: { beeId: i.beeId, generation: i.generation, providerThreadId: i.providerThreadId, model: i.model, turnId: i.turnId,
      inferenceCallId: i.inferenceCallId, responseId: i.responseId, requestId: i.requestId, attempt: i.attempt } as ContextSnapshot["identity"],
    usage: { inputTokens: u.inputTokens, cachedInputTokens: u.cachedInputTokens, cacheWriteInputTokens: u.cacheWriteInputTokens,
      outputTokens: u.outputTokens, reasoningOutputTokens: u.reasoningOutputTokens, totalTokens: u.totalTokens,
      contextWindow: u.contextWindow, source: "codex-inference-response" } as ContextSnapshot["usage"],
    provenance: { source: p.source, method: "captured-request", captureStage: p.captureStage, exactRequest: p.exactRequest,
      traceId: p.traceId, sequence: p.sequence, path: p.path, coverage: p.coverage, limitations: [...p.limitations],
      ...(p.transport ? { transport: p.transport } : {}) } as ContextSnapshot["provenance"],
    categories,
    opaque: { encryptedCharacters: o.encryptedCharacters, mediaItems: o.mediaItems, unknownItems: o.unknownItems, tokens: null } as ContextSnapshot["opaque"],
    request: { inputItems: r.inputItems, toolDefinitions: r.toolDefinitions, serializedCharacters: r.serializedCharacters,
      unattributedSerializedCharacters: r.unattributedSerializedCharacters, previousResponseId: r.previousResponseId } as ContextSnapshot["request"],
    providerOverhead: { tokens: null },
  };
}

export function contextSnapshotInvalidationMetadata(value: unknown): ContextSnapshotInvalidation | undefined {
  const v = object(value);
  if (!v || v.version !== 1 || !text(v.providerThreadId) || !timestamp(v.observedAt) || v.reason !== "uncaptured-compaction") return;
  return { version: 1, providerThreadId: v.providerThreadId, observedAt: v.observedAt, reason: "uncaptured-compaction" };
}
