import { quietReply } from "./quiet.ts";

export const LAST_MESSAGE_MAX_CHARS = 200;

const FENCE = /```[^\n]*\n?/g;
const LINE_MARKERS = /^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d+[.)][ \t]+)+/gm;
const INLINE_MARKERS = /[*`]+|~~/g;
const LINK = /\[([^\]]*)\]\([^)]*\)/g;

export function lastMessageExcerpt(text: string): string | null {
  const plain = quietReply(text).said
    .replace(FENCE, " ")
    .replace(LINE_MARKERS, "")
    .replace(LINK, "$1")
    .replace(INLINE_MARKERS, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length === 0) return null;
  const chars = Array.from(plain);
  return chars.length <= LAST_MESSAGE_MAX_CHARS ? plain : chars.slice(0, LAST_MESSAGE_MAX_CHARS).join("").trimEnd();
}
