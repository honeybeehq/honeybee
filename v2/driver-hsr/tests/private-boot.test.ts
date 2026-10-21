import { test } from "node:test";
import assert from "node:assert/strict";
import { decodePrivateBoot, PRIVATE_BOOT_ENCODED_MAX_BYTES } from "../src/privateBoot.ts";

test("encoded private boot accommodates a near-limit escaped dispatch and clears bytes", () => {
  const dispatch = JSON.stringify({path: "\u0001".repeat(Math.floor((2 * 1024 * 1024 - 1024) / 6))});
  const line = JSON.stringify({binding: {dispatch: JSON.parse(dispatch)}});
  const bytes = Buffer.from(JSON.stringify([line]));
  assert.ok(bytes.length > 2 * 1024 * 1024 + 16384);
  assert.deepEqual(decodePrivateBoot(bytes), [line]);
  assert.ok(bytes.every(byte => byte === 0));
  const oversized = Buffer.alloc(PRIVATE_BOOT_ENCODED_MAX_BYTES + 1, 1);
  assert.throws(() => decodePrivateBoot(oversized), /too large/);
  assert.ok(oversized.every(byte => byte === 0));
});
