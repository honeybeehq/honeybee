import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { atomicWriteFile, storeRoot } from "../src/fsx.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-fsx-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("storeRoot honors HIVE_STORE_ROOT and falls back to ~/.hive", () => {
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = "/tmp/honeybee-test";
  try {
    assert.equal(storeRoot(), "/tmp/honeybee-test");
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
  }
});

test("atomicWriteFile writes and creates parent dirs", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "nested/deeper/file.json");
    await atomicWriteFile(target, '{"hello":"world"}\n');
    const raw = await readFile(target, "utf8");
    assert.equal(raw, '{"hello":"world"}\n');
  });
});

test("atomicWriteFile honors mode option", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "secret.json");
    await atomicWriteFile(target, "{}", { mode: 0o600 });
    const { stat } = await import("node:fs/promises");
    const info = await stat(target);
    assert.equal(info.mode & 0o777, 0o600);
  });
});

test("atomicWriteFile tolerates concurrent same-destination writes without temp collisions", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "contended.json");
    const payloads = Array.from({ length: 20 }, (_, i) => `{"write":${i}}`);
    await Promise.all(payloads.map((data) => atomicWriteFile(target, data)));

    const final = await readFile(target, "utf8");
    assert.ok(payloads.includes(final), `unexpected final content: ${final}`);
    const leftovers = (await readdir(dir)).filter((entry) => entry.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  });
});
