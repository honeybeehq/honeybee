import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openCoreStore,
  type BeeRow,
  type CoreStore,
  type MessageRow,
} from "../../core/src/index.ts";
import {
  AUTO_TITLE_CONTEXT_PROBES_PER_TICK,
  AUTO_TITLE_RETRY_BACKOFF_MS,
  AUTO_TITLE_WATCHDOG_MS,
  contextSignature,
  createAutoTitleDispatcher,
  createStoreAutoTitleDispatcher,
  type AutoTitleBookkeeping,
  type AutoTitleDeps,
  type AutoTitleOutcome,
} from "../src/autoTitle.ts";
import { clampUserMessage, type TitleContext } from "../src/naming.ts";
import type { ResolvedNamingConfig } from "../src/config.ts";

const START = 1_000_000;

const NAMING: ResolvedNamingConfig = {
  auto: true,
  backend: "codex-app-server",
  tool: "codex",
  model: "gpt-5.6-luna",
  effort: "none",
  generatorCwd: "/tmp",
};

type Clock = { now: number };

type StoreTrace = {
  listBees: number;
  listMessages: string[];
  memberships: string[];
  getBees: string[];
};

function temporaryStore(start = START): {
  clock: Clock;
  dir: string;
  statePath: string;
  store: CoreStore;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "hb-auto-title-membership-"));
  const clock = { now: start };
  const store = openCoreStore(join(dir, "core.sqlite3"), {
    ephemeral: true,
    now: () => clock.now,
  });
  return {
    clock,
    dir,
    statePath: join(dir, "auto-title.json"),
    store,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function addBee(store: CoreStore, id: string, ordinal: number): BeeRow {
  return store.createBee({
    id,
    name: id,
    agent: "claude",
    substrate: "tmux",
    cwd: "/tmp/w",
    handle: `CL.${ordinal.toString(16).padStart(4, "0")}`,
  }).bee;
}

function instrumentStore(store: CoreStore): StoreTrace {
  const trace: StoreTrace = { listBees: 0, listMessages: [], memberships: [], getBees: [] };
  const listBees = store.listBees.bind(store);
  const listMessages = store.listMessages.bind(store);
  const readMailboxMembership = store.readMailboxMembership.bind(store);
  const getBee = store.getBee.bind(store);
  store.listBees = () => {
    trace.listBees += 1;
    return listBees();
  };
  store.listMessages = (beeId) => {
    trace.listMessages.push(beeId);
    return listMessages(beeId);
  };
  store.readMailboxMembership = (beeId) => {
    trace.memberships.push(beeId);
    return readMailboxMembership(beeId);
  };
  store.getBee = (beeId) => {
    trace.getBees.push(beeId);
    return getBee(beeId);
  };
  return trace;
}

function storeDispatcher(
  store: CoreStore,
  statePath: string,
  clock: Clock,
  enabled: { value: boolean },
  generate: (context: TitleContext) => Promise<string>,
) {
  return createStoreAutoTitleDispatcher(store, {
    naming: () => ({ ...NAMING, auto: enabled.value }),
    statePath,
    now: () => clock.now,
    generate,
  });
}

function stateBytes(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function readBookkeeping(path: string, beeId: string): AutoTitleBookkeeping {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("bookkeeping root is not an object");
  }
  const row: unknown = Reflect.get(parsed, beeId);
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    throw new Error(`missing bookkeeping for ${beeId}`);
  }
  const attempts: unknown = Reflect.get(row, "attempts");
  const lastAt: unknown = Reflect.get(row, "lastAt");
  const userTurns: unknown = Reflect.get(row, "userTurns");
  const deferred: unknown = Reflect.get(row, "deferred");
  const signature: unknown = Reflect.get(row, "signature");
  if (
    typeof attempts !== "number" ||
    typeof lastAt !== "number" ||
    typeof userTurns !== "number" ||
    typeof deferred !== "boolean" ||
    typeof signature !== "string"
  ) {
    throw new Error(`malformed bookkeeping for ${beeId}`);
  }
  return { attempts, lastAt, userTurns, deferred, signature };
}

function stateIds(path: string): string[] {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("bookkeeping root is not an object");
  }
  return Object.keys(parsed).sort();
}

function mapStateBytes(state: ReadonlyMap<string, AutoTitleBookkeeping>): string {
  const object: Record<string, AutoTitleBookkeeping> = {};
  for (const [beeId, bookkeeping] of state) object[beeId] = bookkeeping;
  return `${JSON.stringify(object)}\n`;
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("store cache reuses only unchanged defer and ignores delivery, urgency, and output", async (t) => {
  const rig = temporaryStore();
  t.after(() => rig.cleanup());
  const { bee, runtime } = rig.store.createBee({
    id: "quiet-thin",
    name: "quiet-thin",
    agent: "claude",
    substrate: "tmux",
    cwd: "/tmp/w",
    handle: "CL.1001",
  });
  const thin = rig.store.send(bee.id, "hi", { urgency: "idle" }).message;
  const trace = instrumentStore(rig.store);
  const enabled = { value: true };
  const dispatch = storeDispatcher(rig.store, rig.statePath, rig.clock, enabled, async () => {
    throw new Error("a thin opener must not generate");
  });

  assert.deepEqual(await dispatch(), []);
  assert.deepEqual(trace.listMessages, [bee.id]);
  assert.deepEqual(trace.memberships, [bee.id, bee.id]);
  const deferredBytes = stateBytes(rig.statePath);
  assert.notEqual(deferredBytes, "");

  assert.deepEqual(await dispatch(), []);
  assert.equal(trace.listMessages.length, 1, "warm unchanged defer skips the body read");
  assert.equal(trace.memberships.length, 3, "a quiet hit needs one membership read");

  assert.deepEqual(rig.store.expediteMessage(bee.id, thin.id, "now"), { applied: true });
  assert.deepEqual(await dispatch(), []);
  assert.equal(trace.listMessages.length, 1, "urgency does not invalidate membership");

  assert.deepEqual(rig.store.markDelivered(thin.id, runtime.generation), { applied: true });
  assert.deepEqual(await dispatch(), []);
  assert.equal(trace.listMessages.length, 1, "delivery only moves the row between aggregate arms");

  rig.store.recordOutput(bee.id);
  assert.deepEqual(await dispatch(), []);
  assert.equal(trace.listMessages.length, 1, "unrelated Bee output is outside the context signature");
  assert.equal(stateBytes(rig.statePath), deferredBytes, "quiet hits write no bookkeeping bytes");

  rig.store.send(bee.id, `<apiary-session>${"ignored ".repeat(200)}</apiary-session>`);
  assert.deepEqual(await dispatch(), []);
  assert.equal(trace.listMessages.length, 2, "a membership change forces one full read");
  assert.equal(stateBytes(rig.statePath), deferredBytes, "an envelope-only row preserves the exact decision");

  assert.deepEqual(await dispatch(), []);
  assert.equal(trace.listMessages.length, 2, "the changed membership was published before the defer branch");
});

test("mail changes reset retry state and exact expiry rebuilds the full launch context", async (t) => {
  const rig = temporaryStore();
  t.after(() => rig.cleanup());
  const bee = addBee(rig.store, "backoff-context", 0x1002);
  const task = `${"Full initial task segment. ".repeat(80)}TAIL-MARKER`;
  rig.store.send(
    bee.id,
    `<apiary-session>${"large injected envelope ".repeat(500)}</apiary-session>\n\n${task}`,
  );
  const trace = instrumentStore(rig.store);
  const contexts: TitleContext[] = [];
  const enabled = { value: true };
  const dispatch = storeDispatcher(rig.store, rig.statePath, rig.clock, enabled, async (context) => {
    contexts.push(context);
    throw new Error(`controlled provider failure ${contexts.length}`);
  });

  await dispatch();
  await settle();
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0]!.initialTask, task, "initialTask keeps the unclamped post-envelope body");
  assert.equal(contexts[0]!.userMessages[0], clampUserMessage(task));
  assert.equal(trace.listMessages.length, 1);
  assert.deepEqual(readBookkeeping(rig.statePath, bee.id), {
    attempts: 1,
    lastAt: START,
    userTurns: 1,
    deferred: false,
    signature: contextSignature(bee, [clampUserMessage(task)]),
  });

  assert.deepEqual(await dispatch(), [{ beeId: bee.id, ok: false, error: "controlled provider failure 1" }]);
  assert.equal(trace.listMessages.length, 1, "active backoff reuses the cached signature");

  rig.store.send(bee.id, "A new task detail arrives during backoff");
  assert.deepEqual(await dispatch(), []);
  await settle();
  assert.equal(contexts.length, 2, "changed membership bypasses the old backoff");
  assert.equal(contexts[1]!.initialTask, task);
  assert.deepEqual(contexts[1]!.userMessages, [
    clampUserMessage(task),
    "A new task detail arrives during backoff",
  ]);
  assert.equal(trace.listMessages.length, 2);
  const afterChange = readBookkeeping(rig.statePath, bee.id);
  assert.equal(afterChange.attempts, 1, "a changed signature starts a fresh retry budget");
  assert.equal(afterChange.userTurns, 2);

  rig.clock.now += AUTO_TITLE_RETRY_BACKOFF_MS - 1;
  assert.deepEqual(await dispatch(), [{ beeId: bee.id, ok: false, error: "controlled provider failure 2" }]);
  assert.equal(trace.listMessages.length, 2, "strictly before expiry stays quiet");

  rig.clock.now += 1;
  assert.deepEqual(await dispatch(), []);
  await settle();
  assert.equal(contexts.length, 3, "the exact expiry boundary performs the legacy retry");
  assert.equal(contexts[2]!.initialTask, task);
  assert.equal(trace.listMessages.length, 3, "expiry reconstructs context from full rows");
  assert.equal(readBookkeeping(rig.statePath, bee.id).attempts, 2);
});

test("lastAt zero remains falsy and cannot become a quiet backoff hit", async (t) => {
  const rig = temporaryStore(0);
  t.after(() => rig.cleanup());
  const bee = addBee(rig.store, "zero-last-at", 0x1003);
  rig.store.send(bee.id, "Generate a title even when the deterministic clock is zero");
  const trace = instrumentStore(rig.store);
  let calls = 0;
  const dispatch = storeDispatcher(rig.store, rig.statePath, rig.clock, { value: true }, async () => {
    calls += 1;
    throw new Error(`zero-clock failure ${calls}`);
  });

  await dispatch();
  await settle();
  assert.equal(readBookkeeping(rig.statePath, bee.id).lastAt, 0);
  assert.equal(calls, 1);

  assert.deepEqual(await dispatch(), [{ beeId: bee.id, ok: false, error: "zero-clock failure 1" }]);
  await settle();
  assert.equal(calls, 2, "the shared truthy-lastAt rule retries instead of reusing backoff");
  assert.equal(trace.listMessages.length, 2, "zero lastAt takes the full legacy path");
  assert.equal(readBookkeeping(rig.statePath, bee.id).attempts, 2);
});

test("outer and nested transaction scans neither consume nor publish a speculative id", async (t) => {
  const rig = temporaryStore();
  t.after(() => rig.cleanup());
  const bee = addBee(rig.store, "transaction-reuse", 0x1004);
  const trace = instrumentStore(rig.store);
  const dispatch = storeDispatcher(rig.store, rig.statePath, rig.clock, { value: true }, async () => {
    throw new Error("thin messages must defer");
  });

  await dispatch();
  await dispatch();
  assert.equal(trace.listMessages.length, 1, "the committed empty baseline is reusable");

  const boom = new Error("roll back speculative title input");
  const transactionScans: Array<Promise<AutoTitleOutcome[]>> = [];
  let speculativeId: number | null = null;
  assert.throws(
    () => rig.store.transact(() => {
      speculativeId = rig.store.send(bee.id, "hi").message.id;
      transactionScans.push(dispatch());
      rig.store.transact(() => {
        transactionScans.push(dispatch());
      });
      throw boom;
    }),
    (error: unknown) => error === boom,
  );
  assert.deepEqual(await Promise.all(transactionScans), [[], []]);
  assert.equal(trace.listMessages.length, 3, "both outer and nested scans take the full path");
  assert.equal(readBookkeeping(rig.statePath, bee.id).signature, contextSignature(bee, ["hi"]));
  assert.deepEqual(rig.store.listMessages(bee.id), []);
  if (speculativeId === null) assert.fail("the speculative send did not run");

  const durable = rig.store.send(bee.id, "hello").message;
  assert.equal(durable.id, speculativeId, "the rolled-back mailbox id is reused");
  const listsBeforeDurableScan = trace.listMessages.length;
  await dispatch();
  assert.equal(
    trace.listMessages.length,
    listsBeforeDurableScan + 1,
    "a transaction-open scan cannot publish the colliding membership pair",
  );
  assert.equal(readBookkeeping(rig.statePath, bee.id).signature, contextSignature(bee, ["hello"]));
  assert.deepEqual(await dispatch(), []);
  assert.equal(trace.listMessages.length, listsBeforeDurableScan + 1, "the committed refill is reusable");
});

test("full-roster pruning preserves an unvisited suffix and removes only scanned-away ids", async (t) => {
  const rig = temporaryStore();
  t.after(() => rig.cleanup());
  const bees: BeeRow[] = [];
  for (let index = 0; index < 10; index += 1) {
    bees.push(addBee(rig.store, `cache-${index.toString().padStart(2, "0")}`, 0x1100 + index));
  }
  const trace = instrumentStore(rig.store);
  const enabled = { value: true };
  const dispatch = storeDispatcher(rig.store, rig.statePath, rig.clock, enabled, async () => {
    throw new Error("empty and thin contexts must defer");
  });

  await dispatch();
  assert.equal(trace.listMessages.length, AUTO_TITLE_CONTEXT_PROBES_PER_TICK);
  assert.deepEqual(stateIds(rig.statePath), bees.slice(0, 8).map((row) => row.id));

  await dispatch();
  assert.equal(trace.listMessages.length, 10, "cached prefix leaves probe budget for the suffix");
  assert.deepEqual(stateIds(rig.statePath), bees.map((row) => row.id));
  await dispatch();
  assert.equal(trace.listMessages.length, 10, "the complete roster is warm");

  for (const target of bees.slice(0, 8)) rig.store.send(target.id, "hi");
  await dispatch();
  assert.equal(trace.listMessages.length, 18, "eight changed deferrals consume the exact probe cap");
  await dispatch();
  assert.equal(
    trace.listMessages.length,
    18,
    "unvisited suffix entries survive because pruning used the complete fresh roster",
  );

  const pruned = bees[9]!;
  rig.store.deleteBee(pruned.id);
  await dispatch();
  const afterAbsentScan = trace.listMessages.length;
  addBee(rig.store, pruned.id, 0x1109);
  await dispatch();
  assert.equal(trace.listMessages.length, afterAbsentScan + 1, "recreation refills after an actual absent-roster prune");

  const retainedWhileDisabled = bees[8]!;
  rig.store.deleteBee(retainedWhileDisabled.id);
  const rosterReadsBeforeDisabled = trace.listBees;
  enabled.value = false;
  await dispatch();
  assert.equal(trace.listBees, rosterReadsBeforeDisabled, "disabled calls do not scan or prune");
  addBee(rig.store, retainedWhileDisabled.id, 0x1108);
  enabled.value = true;
  const listsBeforeReenabled = trace.listMessages.length;
  await dispatch();
  assert.equal(
    trace.listMessages.length,
    listsBeforeReenabled,
    "a same-membership recreation may reuse an entry retained while scanning was disabled",
  );
});

test("supplied stale rosters bypass store reuse and keep getBee-or-candidate fallback", async (t) => {
  const rig = temporaryStore();
  t.after(() => rig.cleanup());
  const bee = addBee(rig.store, "supplied-stale", 0x1201);
  rig.store.send(bee.id, "hi");
  const stale = rig.store.getBee(bee.id);
  if (stale === null) assert.fail("fixture Bee is missing");
  const trace = instrumentStore(rig.store);
  const dispatch = storeDispatcher(rig.store, rig.statePath, rig.clock, { value: true }, async () => {
    throw new Error("thin contexts must defer");
  });

  await dispatch();
  await dispatch();
  const membershipReads = trace.memberships.length;
  const bodyReads = trace.listMessages.length;

  await dispatch([stale]);
  assert.equal(trace.memberships.length, membershipReads, "a supplied roster cannot consult membership reuse");
  assert.equal(trace.listMessages.length, bodyReads + 1, "a supplied current row keeps the full legacy read");
  assert.deepEqual(trace.getBees, [bee.id]);

  rig.store.deleteBee(bee.id);
  const getBeeReadsBeforeRemovedDispatch = trace.getBees.length;
  await dispatch([stale]);
  assert.equal(trace.memberships.length, membershipReads);
  assert.equal(trace.listMessages.length, bodyReads + 2, "a removed row falls back to the supplied candidate");
  assert.equal(
    trace.getBees.length,
    getBeeReadsBeforeRemovedDispatch + 1,
    "the supplied removed row gets one current-row lookup before candidate fallback",
  );
  assert.equal(readBookkeeping(rig.statePath, bee.id).signature, contextSignature(stale, []));
});

test("a changed bookkeeping signature forces a full read even when membership returns to baseline", async (t) => {
  const rig = temporaryStore();
  t.after(() => rig.cleanup());
  const bee = addBee(rig.store, "signature-mismatch", 0x1202);
  const trace = instrumentStore(rig.store);
  const dispatch = storeDispatcher(rig.store, rig.statePath, rig.clock, { value: true }, async () => {
    throw new Error("empty and thin contexts must defer");
  });

  await dispatch();
  await dispatch();
  assert.equal(trace.listMessages.length, 1);
  assert.equal(readBookkeeping(rig.statePath, bee.id).signature, contextSignature(bee, []));

  const thin = rig.store.send(bee.id, "hi").message;
  const fresh = rig.store.getBee(bee.id);
  if (fresh === null) assert.fail("fixture Bee disappeared");
  await dispatch([fresh]);
  assert.equal(readBookkeeping(rig.statePath, bee.id).signature, contextSignature(bee, ["hi"]));
  assert.deepEqual(rig.store.cancelMessage(bee.id, thin.id), { canceled: true });

  const readsBeforeFreshScan = trace.listMessages.length;
  await dispatch();
  assert.equal(
    trace.listMessages.length,
    readsBeforeFreshScan + 1,
    "matching count/max alone cannot reuse a baseline tied to different bookkeeping",
  );
  assert.equal(readBookkeeping(rig.statePath, bee.id).signature, contextSignature(bee, []));
  await dispatch();
  assert.equal(trace.listMessages.length, readsBeforeFreshScan + 1, "the replacement baseline is reusable");
});

test("store-backed and general factories produce the same deterministic outcome stream", async (t) => {
  const optimized = temporaryStore();
  const legacy = temporaryStore();
  t.after(() => optimized.cleanup());
  t.after(() => legacy.cleanup());
  const beeId = "differential-stream";
  const optimizedBee = addBee(optimized.store, beeId, 0x1203);
  const legacyBee = addBee(legacy.store, beeId, 0x1203);
  optimized.store.send(beeId, "hi");
  legacy.store.send(beeId, "hi");
  const optimizedTrace = instrumentStore(optimized.store);
  const optimizedContexts: TitleContext[] = [];
  const legacyContexts: TitleContext[] = [];
  const enabled = { value: true };
  const optimizedDispatch = storeDispatcher(
    optimized.store,
    optimized.statePath,
    optimized.clock,
    enabled,
    async (context) => {
      optimizedContexts.push(context);
      return "Differential Title";
    },
  );
  const legacyState = new Map<string, AutoTitleBookkeeping>();
  const legacyDeps: AutoTitleDeps = {
    enabled: () => true,
    naming: () => NAMING,
    listBees: () => legacy.store.listBees(),
    listMessages: (id) => legacy.store.listMessages(id),
    getBee: (id) => legacy.store.getBee(id),
    setTitle: (id, title) => legacy.store.setBeeTitle(id, title, "auto"),
    loadState: (id) => legacyState.get(id),
    saveState: (id, state) => legacyState.set(id, state),
    generate: async (context) => {
      legacyContexts.push(context);
      return "Differential Title";
    },
    now: () => legacy.clock.now,
    log: () => undefined,
  };
  const legacyDispatch = createAutoTitleDispatcher(legacyDeps);
  const optimizedOutcomes: AutoTitleOutcome[] = [];
  const legacyOutcomes: AutoTitleOutcome[] = [];
  const scanBoth = async () => {
    const optimizedNext = await optimizedDispatch();
    const legacyNext = await legacyDispatch();
    optimizedOutcomes.push(...optimizedNext);
    legacyOutcomes.push(...legacyNext);
    assert.deepEqual(optimizedNext, legacyNext);
    assert.equal(stateBytes(optimized.statePath), mapStateBytes(legacyState));
  };

  await scanBoth();
  await scanBoth();
  assert.equal(optimizedTrace.listMessages.length, 1, "only the optimized warm deferral skips its body read");

  const substantive = "Implement deterministic automatic-title membership reuse";
  optimized.store.send(beeId, substantive);
  legacy.store.send(beeId, substantive);
  await scanBoth();
  await settle();
  await scanBoth();

  assert.deepEqual(optimizedOutcomes, legacyOutcomes);
  assert.deepEqual(optimizedContexts, legacyContexts);
  assert.deepEqual(optimizedContexts, [{
    beeId,
    initialTask: substantive,
    userMessages: ["hi", substantive],
  }]);
  assert.equal(optimized.store.getBee(optimizedBee.id)?.title, "Differential Title");
  assert.equal(legacy.store.getBee(legacyBee.id)?.title, "Differential Title");
  assert.deepEqual(optimized.store.listMessages(beeId), legacy.store.listMessages(beeId));
});

test("general dependencies retain exact callback order during synchronous reentry", async () => {
  let row: BeeRow = {
    id: "custom-reentry",
    name: "custom-reentry",
    agent: "claude",
    substrate: "tmux",
    cwd: "/tmp",
    title: null,
    tags: [],
    sessionLogPath: null,
    lifecycle: "active",
    createdAt: 1,
    archivedAt: null,
    lastOutputAt: null,
    providerSessionId: null,
    env: {},
    importedFrom: null,
    spawnFailures: 0,
    args: null,
    parentId: null,
    parentExternal: false,
    forkedFrom: null,
    forkSeed: null,
    account: null,
    handle: "CL.1202",
    placementVersion: 0,
    activeMoveId: null,
    cellId: null,
  };
  const message: MessageRow = {
    id: 1,
    beeId: row.id,
    sender: "operator",
    body: "Preserve custom callback ordering",
    priority: 0,
    urgency: "next",
    enqueuedAt: 1,
    deliveredAt: null,
    deliveredGeneration: null,
  };
  const trace: string[] = [];
  const bookkeeping = new Map<string, AutoTitleBookkeeping>();
  let dispatch: ReturnType<typeof createAutoTitleDispatcher>;
  let reentry: Promise<AutoTitleOutcome[]> | null = null;
  let didReenter = false;
  const deps: AutoTitleDeps = {
    enabled: () => {
      trace.push("enabled");
      return true;
    },
    naming: () => NAMING,
    listBees: () => {
      trace.push("listBees");
      return [row];
    },
    listMessages: () => {
      trace.push("listMessages:start");
      if (!didReenter) {
        didReenter = true;
        reentry = dispatch([]);
      }
      trace.push("listMessages:end");
      return [message];
    },
    getBee: () => {
      trace.push("getBee");
      return row;
    },
    setTitle: (_beeId, title) => {
      trace.push("setTitle");
      row = { ...row, title };
      return { applied: true };
    },
    loadState: (beeId) => {
      trace.push("loadState");
      return bookkeeping.get(beeId);
    },
    saveState: (beeId, state) => {
      trace.push("saveState");
      bookkeeping.set(beeId, state);
    },
    generate: async () => {
      trace.push("generate");
      return "Preserve Callback Order";
    },
    now: () => {
      trace.push("now");
      return START;
    },
    log: () => trace.push("log"),
  };
  dispatch = createAutoTitleDispatcher(deps);

  assert.deepEqual(await dispatch(), []);
  if (reentry === null) assert.fail("listMessages did not reenter the dispatcher");
  assert.deepEqual(await reentry, []);
  await settle();
  assert.deepEqual(trace, [
    "enabled",
    "now",
    "listBees",
    "listMessages:start",
    "enabled",
    "now",
    "listMessages:end",
    "loadState",
    "saveState",
    "generate",
    "getBee",
    "setTitle",
    "log",
  ]);
  assert.deepEqual(await dispatch(), [{ beeId: row.id, ok: true, title: "Preserve Callback Order" }]);
});

test("store dispatcher preserves one generation slot, watchdog fencing, and roster launch order", async (t) => {
  const rig = temporaryStore();
  t.after(() => rig.cleanup());
  const first = addBee(rig.store, "slot-a", 0x1301);
  const second = addBee(rig.store, "slot-b", 0x1302);
  rig.store.send(first.id, "Generate the first ordered title");
  rig.store.send(second.id, "Generate the second ordered title");
  const trace = instrumentStore(rig.store);
  const contexts: TitleContext[] = [];
  const resolves: Array<(title: string) => void> = [];
  const dispatch = storeDispatcher(rig.store, rig.statePath, rig.clock, { value: true }, (context) => {
    contexts.push(context);
    return new Promise((resolve) => resolves.push(resolve));
  });

  await dispatch();
  await settle();
  assert.deepEqual(contexts.map((context) => context.beeId), [first.id]);
  assert.deepEqual(trace.listMessages, [first.id]);
  const stateWhileHeld = stateBytes(rig.statePath);
  const rosterReadsWhileHeld = trace.listBees;
  const membershipReadsWhileHeld = trace.memberships.length;

  assert.deepEqual(await dispatch(), []);
  assert.equal(trace.listBees, rosterReadsWhileHeld, "an occupied slot does not scan or prune");
  assert.equal(trace.memberships.length, membershipReadsWhileHeld);
  assert.equal(stateBytes(rig.statePath), stateWhileHeld);

  rig.clock.now += AUTO_TITLE_WATCHDOG_MS + 1;
  const watchdog = await dispatch();
  await settle();
  assert.equal(watchdog.length, 1);
  assert.equal(watchdog[0]?.beeId, first.id);
  assert.equal(watchdog[0]?.error?.includes("watchdog"), true);
  assert.deepEqual(contexts.map((context) => context.beeId), [first.id, first.id]);
  assert.deepEqual(trace.listMessages, [first.id, first.id], "watchdog retry rebuilds the full context");

  resolves[0]!("Stale First Title");
  await settle();
  assert.equal(rig.store.getBee(first.id)?.title, null, "the stale generation token cannot write");
  resolves[1]!("Fresh First Title");
  await settle();
  assert.equal(rig.store.getBee(first.id)?.title, "Fresh First Title");

  assert.deepEqual(await dispatch(), [{ beeId: first.id, ok: true, title: "Fresh First Title" }]);
  await settle();
  assert.deepEqual(contexts.map((context) => context.beeId), [first.id, first.id, second.id]);
  assert.equal(contexts[2]!.initialTask, "Generate the second ordered title");
  resolves[2]!("Second Title");
  await settle();
  assert.deepEqual(await dispatch(), [{ beeId: second.id, ok: true, title: "Second Title" }]);
});
