import { test } from "node:test";
import assert from "node:assert/strict";
import { matchAccount, resolveAccount } from "../src/index.ts";

const accounts = [
  { id: "claude-personal", harness: "claude", label: "owner@gmail.com" },
  { id: "claude-work", harness: "claude", label: "owner@example.com" },
  { id: "codex-personal", harness: "codex", label: "coder@gmail.com" },
  { id: "codex-work", harness: "codex", label: "claude-personal" },
] as const;

test("account selector: exact id/label precede unique case-insensitive substring matches", () => {
  const id = matchAccount(accounts, "CLAUDE-PERSONAL");
  assert.equal(id.ok && id.account.id, "claude-personal", "an id outranks another account's equal label");

  const label = matchAccount(accounts, "OWNER@EXAMPLE.COM");
  assert.equal(label.ok && label.account.id, "claude-work");

  const partial = matchAccount(accounts, "example");
  assert.equal(partial.ok && partial.account.id, "claude-work");
  assert.equal(partial.ok && partial.kind, "substring");
});

test("account selector: `<harness>-<query>` scopes fuzzy matching and ambiguity never picks by order", () => {
  const scoped = matchAccount(accounts, "claude-gmail");
  assert.equal(scoped.ok && scoped.account.id, "claude-personal");
  assert.equal(scoped.ok && scoped.scopedHarness, "claude");

  const ambiguous = matchAccount(accounts, "gmail");
  assert.equal(ambiguous.ok, false);
  if (!ambiguous.ok) {
    assert.equal(ambiguous.reason, "ambiguous");
    assert.deepEqual(ambiguous.matches.map((account) => account.id), ["claude-personal", "codex-personal"]);
  }

  const missing = matchAccount(accounts, "claude-nowhere");
  assert.deepEqual(missing, { ok: false, reason: "not_found", matches: [], scopedHarness: null });
});

test("account selector: an exact id is one keyed read and never lists accounts; every other selector lists once and matches as before", () => {
  const listed = { times: 0 };
  const source = {
    byId: (id: string) => accounts.find((account) => account.id === id) ?? null,
    all: () => { listed.times += 1; return accounts; },
  };

  for (const account of accounts) assert.deepEqual(resolveAccount(source, account.id), matchAccount(accounts, account.id));
  assert.equal(listed.times, 0);

  for (const selector of ["CLAUDE-PERSONAL", "OWNER@EXAMPLE.COM", "example", "claude-gmail", "gmail", "claude-nowhere"]) {
    const listedBefore: number = listed.times;
    assert.deepEqual(resolveAccount(source, selector), matchAccount(accounts, selector), selector);
    assert.equal(listed.times, listedBefore + 1, selector);
  }

  const preferred = resolveAccount(source, "gmail", "codex");
  assert.equal(preferred.ok && preferred.account.id, "codex-personal");
  assert.deepEqual(resolveAccount(source, "gmail", "grok"), matchAccount(accounts, "gmail"));
});
