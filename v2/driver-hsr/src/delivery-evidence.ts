import { closeSync, openSync, readSync, statSync } from "node:fs";
import type { AdapterSignal } from "../../adapters/src/types.ts";

export interface DeliveryEvidence {
  accepted: number;
  refused: number;
}

export const DELIVERY_EVIDENCE_MAX_JOURNAL_BYTES = 1024 * 1024 * 1024;
const CHUNK_BYTES = 4 * 1024 * 1024;
const NEWLINE = 0x0a;

export function journalDeliveryEvidence(
  journalPath: string,
  responseMarker: string,
  messageId: number,
  parseLine: (line: string) => AdapterSignal[],
): DeliveryEvidence | null {
  let fd: number;
  try {
    if (statSync(journalPath).size > DELIVERY_EVIDENCE_MAX_JOURNAL_BYTES) return null;
    fd = openSync(journalPath, "r");
  } catch {
    return null;
  }
  const marker = Buffer.from(responseMarker);
  const evidence: DeliveryEvidence = { accepted: 0, refused: 0 };
  const countLine = (line: Buffer): void => {
    for (const signal of parseLine(line.toString("utf8"))) {
      if (signal.kind === "delivery_confirmed" && signal.messageId === messageId) evidence.accepted += 1;
      if (signal.kind === "delivery_refused" && signal.messageId === messageId) evidence.refused += 1;
    }
  };
  try {
    const chunk = Buffer.alloc(CHUNK_BYTES);
    let unfinishedLine = Buffer.alloc(0);
    for (let offset = 0; ;) {
      const bytesRead = readSync(fd, chunk, 0, chunk.length, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
      const data = unfinishedLine.length === 0 ? chunk.subarray(0, bytesRead) : Buffer.concat([unfinishedLine, chunk.subarray(0, bytesRead)]);
      const lastNewline = data.lastIndexOf(NEWLINE);
      for (let hit = data.indexOf(marker); hit >= 0 && hit < lastNewline;) {
        const lineEnd = data.indexOf(NEWLINE, hit);
        countLine(data.subarray(data.lastIndexOf(NEWLINE, hit) + 1, lineEnd));
        hit = data.indexOf(marker, lineEnd + 1);
      }
      unfinishedLine = Buffer.from(data.subarray(lastNewline + 1));
    }
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
  return evidence;
}
