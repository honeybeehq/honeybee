import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { hashActionEnqueueRequest, openCoreStore, type CoreStore } from "../../core/src/index.ts";
import { DaemonCore } from "../src/loops.ts";
import { FakeDriver } from "./helpers.ts";

const HALF_HOUR = 30 * 60_000;
type Sample = { scenario: string; size: number; round: number; ineligibleQuestionReads: number; parity: boolean; error?: string };
const samples: Sample[] = [];
after(() => {
  const output = process.env.HIVE_REMINDER_READS_RECEIPT;
  if (!output) return;
  const sources = Object.fromEntries([
    "../src/loops.ts", "../../core/src/actions.ts", "../../core/src/store.ts", "./helpers.ts", "./action-reminder-reads.test.ts",
  ].map((path) => [path, createHash("sha256").update(readFileSync(new URL(path, import.meta.url))).digest("hex")]));
  const complete = samples.length === 24 && samples.every((s) => s.parity && !s.error);
  writeFileSync(output, JSON.stringify({
    workload: "action-reminder-reads", seriesId: "action-reminder-reads-v1", capturedAt: new Date().toISOString(),
    host: hostname(), node: process.version, load: loadavg(), sources, complete, samples,
    results: [{ metric: "ineligibleQuestionReads", samples: samples.map((s) => s.ineligibleQuestionReads),
      invariantHolds: complete && samples.every((s) => s.ineligibleQuestionReads === 0) }],
    limits: "getQuestion call counts over ten DaemonCore steps with FakeDriver. No timing, CPU, RSS, physical I/O or provider claim. Eligible timing and other action controls are separate tests.",
  }, null, 2) + "\n");
});

function fixture(run: (store: CoreStore, core: DaemonCore, driver: FakeDriver, clock: { now: number }, step: (n?: number) => void) => void) {
  const dir = mkdtempSync(join(tmpdir(), "hb-reminder-reads-"));
  let store: CoreStore | undefined;
  try {
    const clock = { now: 1000 };
    const now = () => clock.now;
    store = openCoreStore(join(dir, "core.sqlite3"), { now, ephemeral: true });
    const driver = new FakeDriver(now);
    const core = new DaemonCore({ store, driver, now, log: () => undefined, policy: { bootHangTimeoutSteps: 50, commandsPerStep: 8 } });
    core.boot();
    const step = (n = 1) => { for (let i = 0; i < n; i += 1) { clock.now += 1; core.step(); } };
    run(store, core, driver, clock, step);
  } finally {
    try { store?.close(); } finally { rmSync(dir, { recursive: true, force: true }); }
  }
}

function answeredAction(store: CoreStore, driver: FakeDriver, step: (n?: number) => void, id: string, kind: "fix" | "commit") {
  store.createBee({ id, name: id, agent: "claude", substrate: "hsr", cwd: "/fixture" });
  store.enqueueCommand("spawn", id);
  step(3);
  assert.equal(store.currentRuntime(id)?.state, "idle");
  const items = [{ kind, version: null, inputs: {}, clientRef: null, title: null }];
  const action = store.enqueueActions({ beeId: id, idempotencyKey: id, requestHash: hashActionEnqueueRequest({ beeId: id, items }), items }).actions[0]!;
  step();
  const token = /--attempt (\d+) --token ([0-9a-f]+)/.exec(driver.deliveredBodies.at(-1)!);
  assert.ok(token);
  const result = store.reportAction({ actionId: action.id, attempt: Number(token[1]), token: token[2]!, reporter: { beeId: id }, kind: "question", question: { text: "continue?" } });
  const questionId = result.question!.id;
  store.answerQuestion(questionId, "yes");
  step(2);
  assert.equal(store.getAction(action.id)?.questionId, questionId, "answered question remains linked");
  return { id: action.id, questionId };
}

for (const scenario of ["fix", "already-reminded"] as const) for (const size of [0, 1, 12, 120]) for (let round = 0; round < 3; round += 1) {
  test(`reminder reads: ${scenario}, ${size} bees, round ${round}`, () => {
    const sample: Sample = { scenario, size, round, ineligibleQuestionReads: 0, parity: false };
    samples.push(sample);
    try {
      fixture((store, _core, driver, clock, step) => {
        const actions = Array.from({ length: size }, (_, i) => answeredAction(store, driver, step, `bee-${i}`, scenario === "fix" ? "fix" : "commit"));
        if (scenario === "already-reminded") {
          clock.now += HALF_HOUR;
          step(2);
          for (const action of actions) assert.ok(store.getAction(action.id)?.dispatch?.nudgedAt != null);
        }
        const getQuestion = store.getQuestion.bind(store);
        const facts = () => ({ actions: actions.map((a) => store.getAction(a.id)), questions: actions.map((a) => getQuestion(a.questionId)), delivered: [...driver.deliveredBodies], audit: store.auditTail(0, 100_000) });
        const before = facts();
        store.getQuestion = (id) => { sample.ineligibleQuestionReads += 1; return getQuestion(id); };
        try { step(10); } finally { store.getQuestion = getQuestion; }
        assert.deepEqual(facts(), before, "polling must preserve actions, questions, delivered mail and audit");
        sample.parity = true;
      });
    } catch (error) { sample.error = String(error); throw error; }
    assert.equal(sample.ineligibleQuestionReads, 0, "ineligible reminders must not read questions");
  });
}

test("eligible answered commit keeps reading current answer time and sends only one reminder", () => {
  fixture((store, _core, driver, clock, step) => {
    const action = answeredAction(store, driver, step, "eligible", "commit");
    const answeredAt = store.getQuestion(action.questionId)!.answeredAt!;
    const read = store.getQuestion.bind(store);
    let reads = 0;
    store.getQuestion = (id) => { reads += 1; return read(id); };
    try {
      clock.now = answeredAt + HALF_HOUR - 2;
      step();
      assert.equal(reads, 1, "eligible attempt still reads its question");
      assert.equal(store.getAction(action.id)?.dispatch?.nudgedAt, null);
      step();
      assert.equal(reads, 2);
      assert.equal(store.getAction(action.id)?.dispatch?.nudgedAt, answeredAt + HALF_HOUR);
      step(2);
      assert.equal(driver.deliveredBodies.filter((body) => body.startsWith("[Hive action] Reminder")).length, 1);
    } finally { store.getQuestion = read; }
  });
});
