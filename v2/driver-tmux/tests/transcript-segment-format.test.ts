import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  SEGMENT_FORMAT,
  compressSegment,
  decodeProjectedSegment,
  decompressSegment,
  encodeProjectedSegment,
  lineDigest,
  scanLogLines,
  segmentDigest,
  type ProjectedLine,
} from "../src/transcript-segment-format.ts";

test("format: scanLogLines numbers only non-blank lines, keeps byte offsets across blanks and CRLF, and leaves a torn tail", () => {
  const data = Buffer.from('{"a":1}\n\n{"b":2}\r\n   \n{"c":3}\n{"torn', "utf8");
  const scan = scanLogLines(data, 10, 1000);
  assert.deepEqual(scan.lines.map((l) => [l.lineNo, l.byteOffset, l.nextByteOffset, l.rawBytes, l.text]), [
    [11, 1000, 1008, 7, '{"a":1}'],
    [12, 1009, 1018, 7, '{"b":2}'],
    [13, 1022, 1030, 7, '{"c":3}'],
  ]);
  assert.equal(scan.lines[1]!.rawSha256, createHash("sha256").update('{"b":2}', "utf8").digest("hex"), "the digest covers the line without its CR");
  assert.equal(scan.consumedBytes, 30, "the torn tail waits for its newline");
  assert.equal(lineDigest("x"), createHash("sha256").update("x").digest("hex"));
});

test("format: the projected segment encodes and decodes losslessly, matches Apiary's header, and digests the raw line hashes in order", () => {
  const lines: ProjectedLine[] = [
    { line_no: 4, byte_offset: 120, raw_bytes: 7, raw_sha256: lineDigest("a"), observed_at: 1_000, harness: "claude", events: JSON.stringify([{ kind: "message", role: "assistant", text: "hi\tthere" }]) },
    { line_no: 5, byte_offset: 128, raw_bytes: 9, raw_sha256: lineDigest("b"), observed_at: 1_001, harness: "claude", events: "[]" },
  ];
  const encoded = encodeProjectedSegment(lines, { beeId: "bee-1", harness: "claude", projectionVersion: 7 });
  const header = encoded.toString("utf8").split("\n")[0];
  assert.equal(header, `${SEGMENT_FORMAT}\t1\t7\tbee-1\t4\t5\tclaude`);
  const decoded = decodeProjectedSegment(decompressSegment(compressSegment(encoded)));
  assert.equal(decoded.beeId, "bee-1");
  assert.equal(decoded.projectionVersion, 7);
  assert.deepEqual(decoded.lines, lines);
  assert.equal(segmentDigest(lines), createHash("sha256").update(lines[0]!.raw_sha256).update(lines[1]!.raw_sha256).digest("hex"));
  assert.throws(() => encodeProjectedSegment([], { beeId: "b", harness: "h", projectionVersion: 1 }));
  assert.throws(() => encodeProjectedSegment([{ ...lines[0]!, events: "[\n]" }], { beeId: "b", harness: "h", projectionVersion: 1 }), /single-line/);
  assert.throws(() => decodeProjectedSegment(Buffer.from("nope\t1\n")), /Unknown segment format/);
});
