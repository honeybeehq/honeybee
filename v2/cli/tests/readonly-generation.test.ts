import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { harness } from "../../core/tests/helpers.ts";
import { ReadOnlyStore } from "../src/readonly.ts";

test("a stale status derives its view from the returned runtime generation", () => {
  const h = harness();
  const core = h.open();
  core.createBee({ id: "bee", name: "bee", agent: "stub", substrate: "hsr", cwd: "/tmp" });
  core.close();
  const writer = new DatabaseSync(h.path);
  let advanced = false;
  class InterleavedReader extends ReadOnlyStore {
    override currentRuntime(id: string) {
      const runtime = super.currentRuntime(id);
      if (!advanced) {
        advanced = true;
        // Model another connection committing after this read completes.
        writer.exec("INSERT INTO runtimes(bee_id, generation, state, exit_cause, started_at, updated_at) VALUES('bee', 2, 'stopped', 'clean', 2, 2)");
      }
      return runtime;
    }
  }
  const reader = new InterleavedReader(h.path);
  try {
    const first = reader.view("bee");
    assert.equal(first.view.generation, first.runtime?.generation);
    assert.equal(first.view.runtimeState, first.runtime?.state);
    const next = reader.view("bee");
    assert.equal(next.runtime?.generation, 2, "the next status still reads fresh data");
    assert.equal(next.view.generation, 2);
    const missing = reader.view("missing");
    assert.equal(missing.runtime, null);
    assert.equal(missing.view.generation, null);
  } finally {
    reader.close();
    writer.close();
    h.cleanup();
  }
});
