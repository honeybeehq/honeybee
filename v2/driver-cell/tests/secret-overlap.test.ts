import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretOutput } from "../src/secretOutput.ts";
import { runCellExec } from "../src/exec.ts";
import { cellPaths } from "../src/layout.ts";

const fixtures = [
  { values: ["SYNTH-abcdef", "abcdef-TAIL"], text: "SYNTH-abcdef-TAIL" },
  { values: ["SYNTH-abc", "abc-def", "def-TAIL"], text: "SYNTH-abc-def-TAIL" },
  { values: ["SYNTH-é😀", "é😀-TAIL"], text: "SYNTH-é😀-TAIL" },
  { values: ["aaaa", "aaaab"], text: "aaaaaaaab" },
  { values: ["SYNTH-abcdef", "abcdef-TAIL"], text: "SYNTH-abcdef-TAIL|clear|SYNTH-abcdef-TAIL!", expected: "[REDACTED]|clear|[REDACTED]!" },
  { values: ["SYNTH-abcdef", "abcdef-TAIL"], text: "SYNTH-abcdef-TAI" },
];

test("union masking covers overlapping values across every three-chunk byte split", () => {
  let checks = 0;
  for (const fixture of fixtures) {
    const raw = Buffer.from(fixture.text);
    for (let first = 0; first <= raw.length; first++) for (let second = first; second <= raw.length; second++) {
      const output: Buffer[] = [];
      const redactor = new SecretOutput(fixture.values, bytes => output.push(Buffer.from(bytes)));
      redactor.push(Buffer.from("before|"));
      redactor.push(raw.subarray(0, first));
      redactor.push(raw.subarray(first, second));
      redactor.push(raw.subarray(second));
      redactor.finish();
      assert.equal(Buffer.concat(output).toString(), "before|" + (fixture.expected ?? "[REDACTED]"));
      redactor.dispose();
      checks++;
    }
  }
  console.log(JSON.stringify({ threeChunkChecks: checks, unmaskedMatchingBytes: 0 }));
});

test("overlap coverage survives emitted matches while the raw tail remains held", () => {
  for (const normal of [true, false]) {
    const output: Buffer[] = [];
    const redactor = new SecretOutput(fixtures[0]!.values, bytes => output.push(Buffer.from(bytes)));
    for (const byte of Buffer.from(fixtures[0]!.text)) redactor.push(Buffer.from([byte]));
    redactor.finish(normal);
    redactor.finish(normal);
    assert.equal(Buffer.concat(output).toString(), "[REDACTED]");
    redactor.dispose();
  }
});

for (const sandbox of process.platform === "linux" ? [false, null] : [false]) {
  test(`real runner masks overlapping synthetic values in both streams (sandbox=${sandbox})`, async () => {
    const root = mkdtempSync(join(tmpdir(), "secret-overlap-"));
    const paths = cellPaths(root, "wrap", "repo", "c1");
    mkdirSync(paths.spaceDir, { recursive: true });
    try {
      const result = await runCellExec(paths, {
        sandbox, nodeKind: "satellite", secretEnv: { FIRST: fixtures[0]!.values[0]!, SECOND: fixtures[0]!.values[1]! },
        argv: [process.execPath, "-e", "const fs=require('node:fs');const value=process.env.FIRST+process.env.SECOND.slice(6);for(const byte of Buffer.from(value)){fs.writeSync(1,Buffer.from([byte]));fs.writeSync(2,Buffer.from([byte]))}"],
      });
      assert.equal(result.status, "ok");
      assert.equal(result.stdout, "[REDACTED]");
      assert.equal(result.stderr, "[REDACTED]");
      console.log(JSON.stringify({ sandbox, status: result.status, stdoutBytes: result.stdout.length, stderrBytes: result.stderr.length, unmaskedMatchingBytes: 0 }));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("streaming union equals an independent whole-buffer interval oracle", () => {
  let seed = 79426;
  const random = (max: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  const alphabet = "abcde";
  const word = (length: number) => Array.from({ length }, () => alphabet[random(alphabet.length)]).join("");
  for (let attempt = 0; attempt < 1000; attempt++) {
    const values = Array.from({ length: 1 + random(5) }, () => word(1 + random(8)));
    const text = word(20 + random(80));
    const normal = attempt % 2 === 0;
    const covered = new Set<number>();
    for (const value of values) {
      for (let start = 0; start < text.length; start++) {
        if (text.startsWith(value, start) || normal && value.startsWith(text.slice(start))) {
          for (let index = start; index < Math.min(text.length, start + value.length); index++) covered.add(index);
        }
      }
    }
    const limit = normal ? text.length : Math.max(0, text.length - Math.max(...values.map(value => value.length - 1)));
    let expected = "";
    for (let index = 0; index < limit; index++) {
      if (!covered.has(index)) expected += text[index];
      else if (index === 0 || !covered.has(index - 1)) expected += "[REDACTED]";
    }
    const chunks: Buffer[] = [];
    const redactor = new SecretOutput(values, bytes => chunks.push(Buffer.from(bytes)));
    for (let start = 0; start < text.length;) {
      const end = Math.min(text.length, start + 1 + random(11));
      redactor.push(Buffer.from(text.slice(start, end)));
      start = end;
    }
    redactor.finish(normal);
    assert.equal(Buffer.concat(chunks).toString(), expected, `seeded case ${attempt}`);
    redactor.dispose();
  }
  console.log(JSON.stringify({ referenceCases: 1000, mismatches: 0 }));
});
