import type { MultilineStage, DeliveryFallback, DeliveryHoldReceipt, MultilineDeliveryRow, DeliveryHold } from "./multilineDeliveryTypes.ts";
export type { MultilineStage, DeliveryFallback, DeliveryHoldReceipt, MultilineDeliveryRow, DeliveryHold } from "./multilineDeliveryTypes.ts";
import { createScanner } from "jsonc-parser";

export const MULTILINE_METADATA_MAX_BYTES = 1024 * 1024;
export const MULTILINE_UNSUPPORTED_ATTEMPTS = 3;
export const MULTILINE_UNSUPPORTED_MS = 30_000;
export const MULTILINE_UNSUPPORTED_DETAILS = ["multiline_type_mode", "multiline_bracketed_paste_disabled", "multiline_bracketed_paste_unknown", "multiline_bracketed_paste_version_unsupported"] as const;
export function publicDeliveryFallback(fallback: DeliveryFallback): DeliveryFallback {
  const result = {...fallback};
  delete result.reorderMessageIds;
  return result;
}
export function readDeliveryFallback(value: unknown): DeliveryFallback | undefined {
  if (value === undefined) return undefined;
  const row = value as DeliveryFallback;
  if (row && typeof row === "object" && !Array.isArray(row) && row.code === "delivery_file_fallback"
    && ["preparing", "ready", "in_flight", "unknown", "held", "delivered", "removed"].includes(row.state)
    && typeof row.id === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(row.id)
    && typeof row.ownerStoreId === "string" && typeof row.root === "string" && row.root.startsWith("/")
    && Array.isArray(row.worktrees) && row.worktrees.every(path => typeof path === "string")
    && (row.path === null || typeof row.path === "string" && row.path.startsWith("/") && !/[\x00-\x1f]/.test(row.path))
    && (row.pointer === null || typeof row.pointer === "string" && !/[\x00-\x1f\x7f\u0085\u2028\u2029]/.test(row.pointer))
    && (row.digest === null || typeof row.digest === "string" && /^[a-f0-9]{64}$/.test(row.digest))
    && (row.bytes === null || Number.isSafeInteger(row.bytes) && row.bytes >= 0)
    && (row.generation === null || Number.isSafeInteger(row.generation) && row.generation > 0)
    && (row.detail === null || typeof row.detail === "string")
    && (row.attempts === undefined || Number.isSafeInteger(row.attempts) && row.attempts >= 0)
    && (row.attemptPhase === undefined || Number.isSafeInteger(row.attempts) && row.attempts! > 0 && (
      row.attemptPhase === "injecting" && ["in_flight", "unknown", "removed"].includes(row.state)
      || row.attemptPhase === "before_enter_cleared" && ["ready", "held", "removed"].includes(row.state)
      || row.attemptPhase === "before_enter_unknown" && ["unknown", "removed"].includes(row.state)
      || row.attemptPhase === "enter_attempted" && ["unknown", "delivered", "removed"].includes(row.state)))
    && (row.paneInput === undefined || row.paneInput && row.paneInput.code === "pane_input_unknown" && Number.isFinite(row.paneInput.since) && row.paneInput.since >= 0
      && typeof row.paneInput.reason === "string" && /^[a-z][a-z0-9_]*$/.test(row.paneInput.reason)
      && typeof row.paneInput.socketPath === "string" && row.paneInput.socketPath.startsWith("/") && !/[\x00-\x1f\x7f\u0085\u2028\u2029]/.test(row.paneInput.socketPath)
      && typeof row.paneInput.paneId === "string" && /^%[0-9]+$/.test(row.paneInput.paneId)
      && typeof row.paneInput.serverIdentity === "string" && /^[0-9]+:[0-9]+:[0-9]+(?:\.[0-9]+)?:[1-9][0-9]*:[0-9]+(?:\.[0-9]+)?$/.test(row.paneInput.serverIdentity)
      && Number.isSafeInteger(row.paneInput.generation) && row.paneInput.generation > 0 && row.paneInput.generation === row.generation
      && row.attemptPhase !== undefined && !["preparing"].includes(row.state)
      && (row.paneInput.clearedAt === undefined || Number.isFinite(row.paneInput.clearedAt) && row.paneInput.clearedAt >= 0))
    && (row.senderNoticeMessageId === null || Number.isSafeInteger(row.senderNoticeMessageId) && row.senderNoticeMessageId > 0)
    && (!["ready", "in_flight", "delivered"].includes(row.state) || row.path !== null && row.pointer !== null && row.digest !== null && row.bytes !== null)
    && (row.state !== "in_flight" || row.generation !== null)) return row;
  return { code: "delivery_file_fallback", state: "unknown", id: "", ownerStoreId: "", root: "", worktrees: [], path: null, pointer: null, digest: null, bytes: null, generation: null, detail: row?.detail === "delivery_hold_state_unknown" ? row.detail : "delivery_fallback_state_unknown", senderNoticeMessageId: null };
}
export const MULTILINE_DELIVERY_SQL = `CREATE TABLE IF NOT EXISTS multiline_delivery (
  message_id INTEGER PRIMARY KEY,
  bee_id TEXT NOT NULL,
  held_at INTEGER,
  held_since INTEGER,
  sender_notice_message_id INTEGER,
  row_json TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS multiline_delivery_bee ON multiline_delivery(bee_id, held_at);
`;
export function deliveryHold(row: MultilineDeliveryRow): DeliveryHold | undefined {
  return row.heldAt === null ? undefined : { code: "delivery_unsupported_multiline", stage: row.stage, messageId: row.messageId, heldAt: row.heldAt, heldSince: row.heldSince, receipt: row.receipt, detail: row.detail, attempts: row.attempts, unsupportedMs: row.unsupportedMs, notice: row.notice };
}

export interface MultilineUnsupportedProgress {
  attempts: number;
  unsupportedMs: number;
  lastAttemptAt: number;
  lastUnsupported: boolean;
}
export function advanceMultilineUnsupported(previous: MultilineUnsupportedProgress | null, detail: string | undefined, now: number): MultilineUnsupportedProgress & { hold: boolean } {
  const unsupported = MULTILINE_UNSUPPORTED_DETAILS.some(value => value === detail);
  const elapsed = previous?.lastUnsupported && unsupported ? Math.max(0, now - previous.lastAttemptAt) : 0;
  const attempts = (previous?.attempts ?? 0) + (unsupported ? 1 : 0);
  const unsupportedMs = (previous?.unsupportedMs ?? 0) + elapsed;
  return {
    attempts, unsupportedMs, lastAttemptAt: now, lastUnsupported: unsupported,
    hold: unsupported && (detail === "multiline_bracketed_paste_version_unsupported" || attempts >= MULTILINE_UNSUPPORTED_ATTEMPTS || unsupportedMs >= MULTILINE_UNSUPPORTED_MS),
  };
}

export const MULTILINE_JSON_SCAN_ERROR_NONE = 0;
export const MULTILINE_JSON_TOKEN = {OpenBraceToken: 1, CloseBraceToken: 2, OpenBracketToken: 3, CloseBracketToken: 4, CommaToken: 5, StringLiteral: 10, LineCommentTrivia: 12, BlockCommentTrivia: 13, Unknown: 16, EOF: 17} as const;

function uniqueJsonObjectKeys(json: string): boolean {
  const scanner = createScanner(json, false);
  const stack: ({object: true; keys: Set<string>; expectsKey: boolean} | {object: false})[] = [];
  for (let remaining = json.length + 1; remaining > 0; remaining--) {
    const token = scanner.scan();
    if (scanner.getTokenError() !== MULTILINE_JSON_SCAN_ERROR_NONE || token === MULTILINE_JSON_TOKEN.LineCommentTrivia || token === MULTILINE_JSON_TOKEN.BlockCommentTrivia || token === MULTILINE_JSON_TOKEN.Unknown) return false;
    if (token === MULTILINE_JSON_TOKEN.EOF) return stack.length === 0;
    if (scanner.getTokenLength() === 0) return false;
    const frame = stack[stack.length - 1];
    if (token === MULTILINE_JSON_TOKEN.OpenBraceToken || token === MULTILINE_JSON_TOKEN.OpenBracketToken) {
      if (stack.length >= 1000) return false;
      stack.push(token === MULTILINE_JSON_TOKEN.OpenBraceToken ? {object: true, keys: new Set(), expectsKey: true} : {object: false});
    } else if (token === MULTILINE_JSON_TOKEN.CloseBraceToken || token === MULTILINE_JSON_TOKEN.CloseBracketToken) {
      if (!frame || frame.object !== (token === MULTILINE_JSON_TOKEN.CloseBraceToken)) return false;
      stack.pop();
    } else if (token === MULTILINE_JSON_TOKEN.CommaToken && frame?.object) {
      frame.expectsKey = true;
    } else if (token === MULTILINE_JSON_TOKEN.StringLiteral && frame?.object && frame.expectsKey) {
      const key = scanner.getTokenValue();
      if (frame.keys.has(key)) return false;
      frame.keys.add(key);
      frame.expectsKey = false;
    }
  }
  return false;
}

export function readMultilineDelivery(json: string, messageId: number, beeId: string, heldAt: number | null, heldSince: number | null): MultilineDeliveryRow {
  try {
    if (Buffer.byteLength(json, "utf8") > MULTILINE_METADATA_MAX_BYTES || !uniqueJsonObjectKeys(json)) throw new Error("delivery_hold_state_unknown");
    const row = JSON.parse(json) as MultilineDeliveryRow;
    if (row && typeof row === "object" && !Array.isArray(row) && row.messageId === messageId && row.beeId === beeId && row.heldAt === heldAt && row.heldSince === heldSince
      && ["waiting", "expired", "held", "delivered"].includes(row.stage)
      && (heldSince === null || Number.isFinite(heldSince))
      && (row.stage !== "held" || heldSince !== null)
      && (heldSince === null || row.stage === "held" || row.stage === "delivered")
      && (row.receipt === null || row.receipt && typeof row.receipt === "object" && !Array.isArray(row.receipt)
        && row.receipt.code === "delivery_unsupported_multiline" && row.receipt.delivered === false && row.receipt.reason === "multiline_type_mode"
        && row.receipt.messageId === messageId && row.receipt.beeId === beeId && row.receipt.heldSince === heldSince && typeof row.receipt.sender === "string"
        && ["mail", "mail.history+audit"].includes(row.receipt.channel)
        && (row.receipt.senderNoticeMessageId === null || Number.isSafeInteger(row.receipt.senderNoticeMessageId) && row.receipt.senderNoticeMessageId > 0))
      && Number.isSafeInteger(row.attempts) && row.attempts >= 0 && Number.isFinite(row.unsupportedMs) && row.unsupportedMs >= 0
      && Number.isFinite(row.lastAttemptAt) && typeof row.lastUnsupported === "boolean"
      && typeof row.detail === "string" && (row.notice === null || typeof row.notice === "string")) {
      const fallback = readDeliveryFallback(row.fallback);
      return {
        messageId, beeId, heldAt, heldSince, stage: row.stage, attempts: row.attempts, unsupportedMs: row.unsupportedMs, lastAttemptAt: row.lastAttemptAt,
        lastUnsupported: row.lastUnsupported, detail: fallback?.id === "" ? "delivery_hold_state_unknown" : row.detail, notice: row.notice,
        ...(fallback === undefined ? {} : { fallback }),
        receipt: row.receipt === null ? null : { code: "delivery_unsupported_multiline", messageId, beeId, sender: row.receipt.sender, heldSince: row.receipt.heldSince,
          delivered: false, reason: "multiline_type_mode", channel: row.receipt.channel, senderNoticeMessageId: row.receipt.senderNoticeMessageId },
      };
    }
  } catch {}
  return { messageId, beeId, heldAt: heldAt ?? 0, heldSince, receipt: null, stage: heldSince === null ? "expired" : "held", attempts: 0, unsupportedMs: 0, lastAttemptAt: 0, lastUnsupported: false, detail: "delivery_hold_state_unknown", notice: null, fallback: { ...readDeliveryFallback(null)!, detail: "delivery_hold_state_unknown" } };
}

const jsonType = (path: string): string => `json_type(row_json, '${path}')`;
const jsonValue = (path: string): string => `json_extract(row_json, '${path}')`;
const jsonText = (path: string): string => `${jsonType(path)} = 'text'`;
const jsonFinite = (path: string): string => `${jsonType(path)} IN ('integer', 'real') AND ${jsonValue(path)} BETWEEN -1.7976931348623157e308 AND 1.7976931348623157e308`;
const jsonInteger = (path: string, minimum: number): string => `${jsonType(path)} IN ('integer', 'real') AND ${jsonValue(path)} BETWEEN ${minimum} AND 9007199254740991 AND ${jsonValue(path)} = CAST(${jsonValue(path)} AS INTEGER)`;
const jsonNullable = (path: string, check: string): string => `(${jsonType(path)} = 'null' OR (${check}))`;
const jsonOptional = (path: string, check: string): string => `(${jsonType(path)} IS NULL OR (${check}))`;
const jsonClean = (path: string, extended = false): string => [ ...Array.from({length: 32}, (_, index) => index), ...(extended ? [127, 133, 8232, 8233] : []) ].map(code => `instr(${jsonValue(path)}, char(${code})) = 0`).join(' AND ');
const jsonAbsolute = (path: string): string => `${jsonText(path)} AND substr(${jsonValue(path)}, 1, 1) = '/'`;
const fallbackPath = '$.fallback';
const fallbackState = jsonValue(`${fallbackPath}.state`);
const fallbackPhase = jsonValue(`${fallbackPath}.attemptPhase`);
const panePath = `${fallbackPath}.paneInput`;
const server = jsonValue(`${panePath}.serverIdentity`);
const serverParts = `json_each(CASE WHEN ${jsonText(`${panePath}.serverIdentity`)} THEN '[' || replace(json_quote(${server}), ':', '","') || ']' ELSE '[]' END)`;
const fallbackValidSql = [
  `${jsonType(fallbackPath)} = 'object'`,
  `${jsonText(`${fallbackPath}.code`)} AND ${jsonValue(`${fallbackPath}.code`)} = 'delivery_file_fallback'`,
  `${fallbackState} IN ('preparing','ready','in_flight','unknown','held','delivered','removed')`,
  `${jsonText(`${fallbackPath}.id`)} AND instr(${jsonValue(`${fallbackPath}.id`)}, char(0)) = 0 AND length(${jsonValue(`${fallbackPath}.id`)}) = 36 AND ${jsonValue(`${fallbackPath}.id`)} NOT GLOB '*[^a-f0-9-]*' AND ${jsonValue(`${fallbackPath}.id`)} GLOB '????????-????-????-????-????????????' AND length(replace(${jsonValue(`${fallbackPath}.id`)}, '-', '')) = 32`,
  jsonText(`${fallbackPath}.ownerStoreId`), jsonAbsolute(`${fallbackPath}.root`),
  `${jsonType(`${fallbackPath}.worktrees`)} = 'array' AND NOT EXISTS (SELECT 1 FROM json_each(row_json, '$.fallback.worktrees') WHERE type != 'text')`,
  jsonNullable(`${fallbackPath}.path`, `${jsonAbsolute(`${fallbackPath}.path`)} AND ${jsonClean(`${fallbackPath}.path`)}`),
  jsonNullable(`${fallbackPath}.pointer`, `${jsonText(`${fallbackPath}.pointer`)} AND ${jsonClean(`${fallbackPath}.pointer`, true)}`),
  jsonNullable(`${fallbackPath}.digest`, `${jsonText(`${fallbackPath}.digest`)} AND instr(${jsonValue(`${fallbackPath}.digest`)}, char(0)) = 0 AND length(${jsonValue(`${fallbackPath}.digest`)}) = 64 AND ${jsonValue(`${fallbackPath}.digest`)} NOT GLOB '*[^a-f0-9]*'`),
  jsonNullable(`${fallbackPath}.bytes`, jsonInteger(`${fallbackPath}.bytes`, 0)),
  jsonNullable(`${fallbackPath}.generation`, jsonInteger(`${fallbackPath}.generation`, 1)),
  jsonNullable(`${fallbackPath}.detail`, jsonText(`${fallbackPath}.detail`)),
  jsonNullable(`${fallbackPath}.senderNoticeMessageId`, jsonInteger(`${fallbackPath}.senderNoticeMessageId`, 1)),
  jsonOptional(`${fallbackPath}.attempts`, jsonInteger(`${fallbackPath}.attempts`, 0)),
  jsonOptional(`${fallbackPath}.attemptPhase`, `${jsonInteger(`${fallbackPath}.attempts`, 1)} AND (
    ${fallbackPhase} = 'injecting' AND ${fallbackState} IN ('in_flight','unknown','removed')
    OR ${fallbackPhase} = 'before_enter_cleared' AND ${fallbackState} IN ('ready','held','removed')
    OR ${fallbackPhase} = 'before_enter_unknown' AND ${fallbackState} IN ('unknown','removed')
    OR ${fallbackPhase} = 'enter_attempted' AND ${fallbackState} IN ('unknown','delivered','removed'))`),
  jsonOptional(panePath, `${jsonType(panePath)} = 'object'
    AND ${jsonValue(`${panePath}.code`)} = 'pane_input_unknown'
    AND ${jsonFinite(`${panePath}.since`)} AND ${jsonValue(`${panePath}.since`)} >= 0
    AND ${jsonText(`${panePath}.reason`)} AND instr(${jsonValue(`${panePath}.reason`)}, char(0)) = 0 AND ${jsonValue(`${panePath}.reason`)} GLOB '[a-z]*' AND ${jsonValue(`${panePath}.reason`)} NOT GLOB '*[^a-z0-9_]*'
    AND ${jsonAbsolute(`${panePath}.socketPath`)} AND ${jsonClean(`${panePath}.socketPath`, true)}
    AND ${jsonText(`${panePath}.paneId`)} AND instr(${jsonValue(`${panePath}.paneId`)}, char(0)) = 0 AND ${jsonValue(`${panePath}.paneId`)} GLOB '%[0-9]*' AND substr(${jsonValue(`${panePath}.paneId`)}, 2) NOT GLOB '*[^0-9]*'
    AND ${jsonText(`${panePath}.serverIdentity`)} AND instr(${server}, char(0)) = 0 AND ${server} NOT GLOB '*[^0-9:.]*'
    AND length(${server}) - length(replace(${server}, ':', '')) = 4
    AND NOT EXISTS (SELECT 1 FROM ${serverParts} WHERE length(value) = 0
      OR key IN (0,1) AND value GLOB '*[^0-9]*'
      OR key = 3 AND (value NOT GLOB '[1-9]*' OR value GLOB '*[^0-9]*')
      OR key IN (2,4) AND (value GLOB '.*' OR value GLOB '*.' OR length(value) - length(replace(value, '.', '')) > 1))
    AND ${jsonInteger(`${panePath}.generation`, 1)} AND ${jsonValue(`${panePath}.generation`)} = ${jsonValue(`${fallbackPath}.generation`)}
    AND ${jsonType(`${fallbackPath}.attemptPhase`)} IS NOT NULL AND ${fallbackState} != 'preparing'
    AND ${jsonOptional(`${panePath}.clearedAt`, `${jsonFinite(`${panePath}.clearedAt`)} AND ${jsonValue(`${panePath}.clearedAt`)} >= 0`)}`),
  `(${fallbackState} NOT IN ('ready','in_flight','delivered') OR (${['path','pointer','digest','bytes'].map(key => `${jsonType(`${fallbackPath}.${key}`)} != 'null'`).join(' AND ')}))`,
  `(${fallbackState} != 'in_flight' OR ${jsonType(`${fallbackPath}.generation`)} != 'null')`,
].map(check => `(${check})`).join(' AND ');
const multilineValidSql = [
  `json_type(row_json) = 'object'`,
  `${jsonType('$.messageId')} IN ('integer','real') AND CAST(${jsonValue('$.messageId')} AS REAL) = CAST(message_id AS REAL)`,
  `${jsonText('$.beeId')} AND ${jsonValue('$.beeId')} = bee_id`,
  `${jsonType('$.heldAt')} IN ('null','integer','real') AND CAST(${jsonValue('$.heldAt')} AS REAL) IS CAST(held_at AS REAL)`,
  `${jsonType('$.heldSince')} IN ('null','integer','real') AND CAST(${jsonValue('$.heldSince')} AS REAL) IS CAST(held_since AS REAL)`,
  `${jsonValue('$.stage')} IN ('waiting','expired','held','delivered')`,
  `(held_since IS NULL OR held_since BETWEEN -1.7976931348623157e308 AND 1.7976931348623157e308)`,
  `(${jsonValue('$.stage')} != 'held' OR held_since IS NOT NULL)`,
  `(held_since IS NULL OR ${jsonValue('$.stage')} IN ('held','delivered'))`,
  jsonNullable('$.receipt', `${jsonType('$.receipt')} = 'object'
    AND ${jsonValue('$.receipt.code')} = 'delivery_unsupported_multiline'
    AND ${jsonType('$.receipt.delivered')} = 'false'
    AND ${jsonValue('$.receipt.reason')} = 'multiline_type_mode'
    AND CAST(${jsonValue('$.receipt.messageId')} AS REAL) = CAST(message_id AS REAL) AND ${jsonType('$.receipt.messageId')} IN ('integer','real')
    AND ${jsonText('$.receipt.beeId')} AND ${jsonValue('$.receipt.beeId')} = bee_id
    AND ${jsonType('$.receipt.heldSince')} IN ('null','integer','real') AND CAST(${jsonValue('$.receipt.heldSince')} AS REAL) IS CAST(held_since AS REAL)
    AND ${jsonText('$.receipt.sender')} AND ${jsonValue('$.receipt.channel')} IN ('mail','mail.history+audit')
    AND ${jsonNullable('$.receipt.senderNoticeMessageId', jsonInteger('$.receipt.senderNoticeMessageId', 1))}`),
  jsonInteger('$.attempts', 0),
  `${jsonFinite('$.unsupportedMs')} AND ${jsonValue('$.unsupportedMs')} >= 0`,
  jsonFinite('$.lastAttemptAt'),
  `${jsonType('$.lastUnsupported')} IN ('true','false')`,
  jsonText('$.detail'), jsonNullable('$.notice', jsonText('$.notice')),
  jsonOptional(fallbackPath, fallbackValidSql),
].map(check => `(${check})`).join(' AND ');
export const MULTILINE_UNKNOWN_SQL = `CASE WHEN length(CAST(row_json AS BLOB)) > ${MULTILINE_METADATA_MAX_BYTES} THEN 1
  WHEN NOT json_valid(row_json) THEN 1
  WHEN EXISTS (SELECT 1 FROM json_tree(row_json) AS member
    WHERE typeof(member.key) = 'text' GROUP BY member.parent, member.key HAVING COUNT(*) > 1) THEN 1
  ELSE NOT COALESCE((${multilineValidSql}), 0)
    OR ${jsonValue('$.detail')} = 'delivery_hold_state_unknown'
    OR ${fallbackState} = 'unknown' END`;
