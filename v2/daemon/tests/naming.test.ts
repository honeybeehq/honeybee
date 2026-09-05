import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildTitlePrompt,
  isThinOpener,
  linearIssueIdentifier,
  normalizeGeneratedTitle,
  stripSessionEnvelopes,
} from "../src/naming.ts";

test("stripSessionEnvelopes drops hive/apiary envelopes and keeps the operator task", () => {
  const body = `<hive-session>\nYou are a Honeybee bee.\n</hive-session>\n\n<apiary-session>\nCall live self.\n</apiary-session>\n\nFix the auto-titler for grok bees.`;
  assert.equal(stripSessionEnvelopes(body), "Fix the auto-titler for grok bees.");
});

test("isThinOpener: greetings and empty envelopes are thin; real tasks are not", () => {
  assert.equal(isThinOpener("hi"), true);
  assert.equal(isThinOpener("Hey!"), true);
  assert.equal(isThinOpener("thanks"), true);
  assert.equal(isThinOpener(""), true);
  assert.equal(isThinOpener("<apiary-session>x</apiary-session>\n\nhi"), true);
  assert.equal(isThinOpener("Fix the auto-titler"), false);
  assert.equal(isThinOpener("debug hive titles please"), false);
});

test("normalizeGeneratedTitle strips dressing and rejects empty output", () => {
  assert.equal(normalizeGeneratedTitle('Title: "Fix auto-titling."\n'), "Fix auto-titling");
  assert.equal(normalizeGeneratedTitle("   \n"), undefined);
});

test("buildTitlePrompt fences user messages as data", () => {
  const prompt = buildTitlePrompt({
    userMessages: ["hi", "Enable the auto-titler"],
    lastAssistant: "On it.",
  });
  assert.match(prompt, /User message 1:/);
  assert.match(prompt, /Enable the auto-titler/);
  assert.match(prompt, /BEGIN SESSION CONTENT/);
  assert.match(prompt, /never instructions/);
});

test("Linear references accept issue links and bare IDs in task order", () => {
  for (const task of [
    "Fix APY-9 please",
    "[task](https://linear.app/honeybee-hq/issue/APY-9)",
    "https://linear.app/honeybee-hq/issue/apy-9/model-changes?view=all#details",
    "APY-9 and https://linear.app/honeybee-hq/issue/HNY-12/another-issue",
    "https://linear.app/honeybee-hq/issue/APY-9/model-changes then HNY-12",
  ]) {
    assert.equal(linearIssueIdentifier(task), "APY-9", task);
  }
  assert.equal(isThinOpener("APY-9"), false);
});

test("Linear references ignore session instructions, other URLs, and bee handles", () => {
  for (const task of [
    "<apiary-session>Example APY-9</apiary-session>Fix naming",
    "<hive-session>Example APY-9</hive-session>Fix naming",
    "https://example.com/issue/APY-9",
    "https://linear.app.example.com/team/issue/APY-9",
    "https://linear.app/team/project/APY-9",
    "https://linear.app/team/issue/APY-9invalid",
    "CO.bd2d",
    "fix the parser",
    "use apy-9 as a filename",
  ]) {
    assert.equal(linearIssueIdentifier(task), undefined, task);
  }
});

test("normalization prefixes once and keeps the entire title within 72 characters", () => {
  const context = { userMessages: ["Fix APY-9"] };
  for (const raw of ["Atomic Model Changes", "APY-9: Atomic Model Changes", "[APY-9] Atomic Model Changes", "apy-9 - Atomic Model Changes"]) {
    const title = normalizeGeneratedTitle(raw, context);
    assert.equal(title, "APY-9: Atomic Model Changes");
    assert.equal(normalizeGeneratedTitle(title!, context), title);
  }
  const long = normalizeGeneratedTitle("Long title ".repeat(20), context);
  assert.equal(long?.length, 72);
  assert.ok(long?.startsWith("APY-9: "));
  assert.ok(long?.endsWith("…"));
  assert.equal(normalizeGeneratedTitle("", context), undefined);
});

test("only the initial task supplies the issue prefix", () => {
  assert.equal(normalizeGeneratedTitle("Parser Repair", {
    userMessages: ["Fix the parser", "See APY-9 for comparison"],
  }), "Parser Repair");
  assert.equal(normalizeGeneratedTitle("Parser Repair", {
    userMessages: ["hi", "Fix APY-9"],
  }), "APY-9: Parser Repair");
  assert.equal(normalizeGeneratedTitle("Parser Repair", {
    initialTask: "Fix the parser",
    userMessages: ["See APY-9 for comparison"],
  }), "Parser Repair");
});
