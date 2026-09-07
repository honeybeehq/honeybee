import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { harness } from "./helpers.ts";
import type { CoreStore, DaemonLiveRuntime, I1RuntimeFact, RuntimeRow } from "../src/index.ts";

function createBee(store: CoreStore, id: string) {
  return store.createBee({ id, name: id, agent: "stub", substrate: "hsr", cwd: "/tmp" });
}

function liveRuntime(runtime: RuntimeRow | null): DaemonLiveRuntime {
  if (!runtime || runtime.state === "stopped") throw new Error("expected current live runtime");
  return {
    beeId: runtime.beeId,
    generation: runtime.generation,
    state: runtime.state,
    startedAt: runtime.startedAt,
    updatedAt: runtime.updatedAt,
    bootEvidence: runtime.bootEvidence,
  };
}

function i1Runtime(runtime: RuntimeRow | null): I1RuntimeFact {
  if (!runtime) throw new Error("expected current runtime");
  return {
    state: runtime.state,
    bootEvidence: runtime.bootEvidence,
    updatedAt: runtime.updatedAt,
  };
}

function withReturnArraysUnavailable<T>(operation: () => T): T {
  const probe = new DatabaseSync(":memory:");
  const statementPrototype = Object.getPrototypeOf(probe.prepare("SELECT 1"));
  const descriptor = Object.getOwnPropertyDescriptor(statementPrototype, "setReturnArrays");
  probe.close();
  assert.ok(descriptor && typeof descriptor.value === "function", "test requires native return-array support");
  Object.defineProperty(statementPrototype, "setReturnArrays", { ...descriptor, value: undefined });
  try {
    return operation();
  } finally {
    Object.defineProperty(statementPrototype, "setReturnArrays", descriptor);
  }
}

function withReturnArraysObserved<T>(operation: () => T): { value: T; calls: number } {
  const probe = new DatabaseSync(":memory:");
  const statementPrototype = Object.getPrototypeOf(probe.prepare("SELECT 1"));
  const descriptor = Object.getOwnPropertyDescriptor(statementPrototype, "setReturnArrays");
  probe.close();
  assert.ok(descriptor && typeof descriptor.value === "function", "test requires native return-array support");
  const native = descriptor.value;
  let calls = 0;
  Object.defineProperty(statementPrototype, "setReturnArrays", {
    ...descriptor,
    value: function (this: unknown, enabled: boolean) {
      calls += 1;
      assert.equal(enabled, true);
      return Reflect.apply(native, this, [enabled]);
    },
  });
  try {
    return { value: operation(), calls };
  } finally {
    Object.defineProperty(statementPrototype, "setReturnArrays", descriptor);
  }
}

function assertMalformedUrgency(operation: () => unknown): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, "CoreError");
    assert.equal(error.message, "daemon projection: malformed pending urgency");
    return true;
  });
}

test("native array and method-absent object rows project identical ordered daemon inputs", (t) => {
  const h = harness();
  t.after(() => h.cleanup());

  const seed = h.open();
  const z = createBee(seed, "z-stopped");
  seed.updateRuntimeState(z.bee.id, z.runtime.generation, "stopped", { exitCause: "clean" });
  const zFirst = seed.send(z.bee.id, "z first", { urgency: "idle" }).message;

  const a = createBee(seed, "a-live");
  seed.updateRuntimeState(a.bee.id, a.runtime.generation, "running", { synthetic: true });
  const aFirst = seed.send(a.bee.id, "a first", { urgency: "next" }).message;
  const zSecond = seed.send(z.bee.id, "z second", { urgency: "now" }).message;
  const aSecond = seed.send(a.bee.id, "a second", { urgency: "idle" }).message;
  seed.setFlag(z.bee.id, "resource_blocked", "ordered fixture");
  const aRuntime = seed.currentRuntime(a.bee.id);
  const zRuntime = seed.currentRuntime(z.bee.id);
  seed.close();

  const expectedI1 = [
    {
      beeId: a.bee.id,
      runtime: i1Runtime(aRuntime),
      hasActiveFlag: false,
      pending: [
        { id: aFirst.id, urgency: "next" as const, enqueuedAt: aFirst.enqueuedAt },
        { id: aSecond.id, urgency: "idle" as const, enqueuedAt: aSecond.enqueuedAt },
      ],
    },
    {
      beeId: z.bee.id,
      runtime: i1Runtime(zRuntime),
      hasActiveFlag: true,
      pending: [
        { id: zFirst.id, urgency: "idle" as const, enqueuedAt: zFirst.enqueuedAt },
        { id: zSecond.id, urgency: "now" as const, enqueuedAt: zSecond.enqueuedAt },
      ],
    },
  ];
  const expectedWork = [{ runtime: liveRuntime(aRuntime), pending: expectedI1[0]!.pending }];

  const observed = withReturnArraysObserved(() => {
    const nativeStore = h.open();
    try {
      return {
        inputs: nativeStore.readDaemonStepInputs(),
        work: nativeStore.readDaemonWork(),
      };
    } finally {
      nativeStore.close();
    }
  });
  const native = observed.value;
  assert.equal(observed.calls, 2);

  const fallback = withReturnArraysUnavailable(() => {
    const fallbackStore = h.open();
    try {
      return {
        inputs: fallbackStore.readDaemonStepInputs(),
        work: fallbackStore.readDaemonWork(),
      };
    } finally {
      fallbackStore.close();
    }
  });

  assert.deepEqual(native.inputs, { work: expectedWork, i1: expectedI1 });
  assert.deepEqual(native.work, expectedWork);
  assert.deepEqual(fallback, native);

  assert.strictEqual(native.inputs.work[0]!.pending, native.inputs.i1[0]!.pending);
  assert.strictEqual(native.inputs.work[0]!.pending[0], native.inputs.i1[0]!.pending[0]);
  assert.strictEqual(fallback.inputs.work[0]!.pending, fallback.inputs.i1[0]!.pending);
  assert.strictEqual(fallback.inputs.work[0]!.pending[0], fallback.inputs.i1[0]!.pending[0]);
  assert.notStrictEqual(fallback.inputs.i1[0]!.pending, native.inputs.i1[0]!.pending);
  assert.notStrictEqual(fallback.inputs.i1[0]!.pending[0], native.inputs.i1[0]!.pending[0]);
  assert.notStrictEqual(native.work[0]!.pending, native.inputs.work[0]!.pending);
  assert.notStrictEqual(fallback.work[0]!.pending, fallback.inputs.work[0]!.pending);
});

test("native array and method-absent object rows preserve malformed-value errors", (t) => {
  const h = harness();
  t.after(() => h.cleanup());

  const seed = h.open();
  const target = createBee(seed, "malformed-pending");
  const message = seed.send(target.bee.id, "not projected", { urgency: "next" }).message;
  seed.close();

  const fixture = new DatabaseSync(h.path);
  try {
    fixture.exec("PRAGMA ignore_check_constraints = ON");
    fixture.prepare("UPDATE mailbox SET urgency = 'invalid' WHERE id = ?").run(message.id);
  } finally {
    fixture.close();
  }

  const nativeStore = h.open();
  try {
    assertMalformedUrgency(() => nativeStore.readI1PendingSnapshot());
    assertMalformedUrgency(() => nativeStore.readDaemonWork());
  } finally {
    nativeStore.close();
  }

  withReturnArraysUnavailable(() => {
    const fallbackStore = h.open();
    try {
      assertMalformedUrgency(() => fallbackStore.readI1PendingSnapshot());
      assertMalformedUrgency(() => fallbackStore.readDaemonWork());
    } finally {
      fallbackStore.close();
    }
  });
});
