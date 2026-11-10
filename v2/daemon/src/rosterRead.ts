import type { ArchivedBeeCursor } from "../../core/src/index.ts";
import { RpcError, type RpcVerb } from "./protocol.ts";

export function archivedCursorText(cursor: ArchivedBeeCursor): string {
  return Buffer.from(JSON.stringify([cursor.archivedAt, cursor.id])).toString("base64url");
}

export function archivedCursor(text: unknown): ArchivedBeeCursor {
  if (typeof text === "string" && text.length <= 1024) {
    try {
      const value: unknown = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
      if (Array.isArray(value) && value.length === 2 && Number.isSafeInteger(value[0]) && typeof value[1] === "string") return { archivedAt: value[0], id: value[1] };
    } catch {}
  }
  throw new RpcError("invalid_request", "list: after must be the next value of an earlier page");
}

export function snapshotLifecycle(verb: RpcVerb, params: Record<string, unknown>): "active" | undefined {
  if (params.lifecycle === undefined || params.lifecycle === null) return undefined;
  if (params.lifecycle === "active") return "active";
  throw new RpcError("invalid_request", `${verb}: lifecycle must be active`);
}
