import { createHash } from "node:crypto";
import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from "node:zlib";

export const SEGMENT_FORMAT = "apiary-transcript-segment";
export const SEGMENT_FORMAT_VERSION = 1;
export const SEGMENT_MAX_LINES = 1024;
export const SEGMENT_MAX_RAW_BYTES = 1024 * 1024;
const ZSTD_LEVEL = 3;

export interface ProjectedLine {
  line_no: number;
  byte_offset: number;
  raw_bytes: number;
  raw_sha256: string;
  observed_at: number;
  harness: string;
  events: string;
}

export function lineDigest(line: string): string {
  return createHash("sha256").update(line, "utf8").digest("hex");
}

export function segmentDigest(lines: readonly Pick<ProjectedLine, "raw_sha256">[]): string {
  const hash = createHash("sha256");
  for (const line of lines) hash.update(line.raw_sha256);
  return hash.digest("hex");
}

export function encodeProjectedSegment(lines: readonly ProjectedLine[], meta: { beeId: string; harness: string; projectionVersion: number }): Buffer {
  if (lines.length === 0) throw new Error("A segment needs at least one line");
  const parts: string[] = [`${SEGMENT_FORMAT}\t${SEGMENT_FORMAT_VERSION}\t${meta.projectionVersion}\t${meta.beeId}\t${lines[0]!.line_no}\t${lines[lines.length - 1]!.line_no}\t${meta.harness}\n`];
  for (const line of lines) {
    if (line.events.includes("\n") || line.events.includes("\t")) throw new Error("Projected events must be single-line JSON");
    parts.push(`${line.line_no}\t${line.byte_offset}\t${line.raw_bytes}\t${line.raw_sha256}\t${line.observed_at}\t${line.events}\n`);
  }
  return Buffer.from(parts.join(""), "utf8");
}

export interface DecodedSegment {
  beeId: string;
  harness: string;
  projectionVersion: number;
  firstLine: number;
  lastLine: number;
  lines: ProjectedLine[];
}

export function decodeProjectedSegment(buffer: Buffer): DecodedSegment {
  const text = buffer.toString("utf8");
  const headerEnd = text.indexOf("\n");
  if (headerEnd < 0) throw new Error("Segment blob has no header");
  const header = text.slice(0, headerEnd).split("\t");
  if (header[0] !== SEGMENT_FORMAT || Number(header[1]) !== SEGMENT_FORMAT_VERSION || header.length < 7) throw new Error("Unknown segment format");
  const harness = header[6]!;
  const lines: ProjectedLine[] = [];
  for (let at = headerEnd + 1; at < text.length;) {
    const end = text.indexOf("\n", at);
    if (end < 0) throw new Error("Segment blob is truncated");
    const fields = text.slice(at, end).split("\t", 6);
    if (fields.length < 6) throw new Error("Segment line is malformed");
    const eventsStart = at + fields[0]!.length + fields[1]!.length + fields[2]!.length + fields[3]!.length + fields[4]!.length + 5;
    lines.push({ line_no: Number(fields[0]), byte_offset: Number(fields[1]), raw_bytes: Number(fields[2]), raw_sha256: fields[3]!, observed_at: Number(fields[4]), harness, events: text.slice(eventsStart, end) });
    at = end + 1;
  }
  return { beeId: header[3]!, harness, projectionVersion: Number(header[2]), firstLine: Number(header[4]), lastLine: Number(header[5]), lines };
}

export function compressSegment(bytes: Buffer): Buffer {
  return zstdCompressSync(bytes, { params: { [zlibConstants.ZSTD_c_compressionLevel]: ZSTD_LEVEL } });
}

export function decompressSegment(bytes: Buffer): Buffer {
  return zstdDecompressSync(bytes);
}

export interface ScannedLine {
  lineNo: number;
  byteOffset: number;
  nextByteOffset: number;
  rawBytes: number;
  rawSha256: string;
  text: string;
}

export interface LogScan {
  lines: ScannedLine[];
  consumedBytes: number;
}

export function scanLogLines(data: Buffer, startLineNo: number, startByteOffset: number): LogScan {
  const lines: ScannedLine[] = [];
  let cursor = 0;
  let lineNo = startLineNo;
  let byteOffset = startByteOffset;
  for (;;) {
    const newline = data.indexOf(10, cursor);
    if (newline < 0) break;
    const text = data.subarray(cursor, newline).toString("utf8").replace(/\r$/, "");
    if (text.trim().length > 0) {
      lineNo += 1;
      lines.push({ lineNo, byteOffset, nextByteOffset: byteOffset + newline + 1 - cursor, rawBytes: (newline > cursor && data[newline - 1] === 13 ? newline - 1 : newline) - cursor, rawSha256: lineDigest(text), text });
    }
    byteOffset += newline + 1 - cursor;
    cursor = newline + 1;
  }
  return { lines, consumedBytes: cursor };
}
