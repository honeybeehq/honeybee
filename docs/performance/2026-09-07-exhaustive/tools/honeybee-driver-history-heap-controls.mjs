// Disposable synthetic controls for the v2 driver-history heap analyzer.
// Four HsrDriver-named shapes in one LIVE snapshot (positive Map with
// in-smi-range numeric entries, null target, non-Map target, missing
// property) plus a RELEASED snapshot with every reference dropped.
// Synthetic only — no real host, no production code, no Mini.
import assert from "node:assert/strict";
import { writeHeapSnapshot } from "node:v8";
import { setImmediate as yieldTurn } from "node:timers/promises";

assert.equal(typeof globalThis.gc, "function", "run with --expose-gc");

class HsrDriver {
  constructor(shape) {
    if (shape === "map") {
      this.consumed = new Map();
      for (let id = 1; id <= 500; id++) this.consumed.set(id, 1); // smi keys/values
    } else if (shape === "null") {
      this.consumed = null;
    } else if (shape === "nonmap") {
      this.consumed = { rows: 500 }; // plain object, must classify not_map
    } // "missing": no consumed property at all
  }
}

globalThis.heapControlDrivers = [
  new HsrDriver("map"),
  new HsrDriver("null"),
  new HsrDriver("nonmap"),
  new HsrDriver("missing"),
];
assert.equal(globalThis.heapControlDrivers.length, 4);
assert.equal(globalThis.heapControlDrivers[0].consumed.size, 500);
writeHeapSnapshot("/tmp/honeybee-driver-history-heap-control-live.heapsnapshot");

globalThis.heapControlDrivers = null;
await yieldTurn();
globalThis.gc();
await yieldTurn();
writeHeapSnapshot("/tmp/honeybee-driver-history-heap-control-released.heapsnapshot");
console.log("controls written");
