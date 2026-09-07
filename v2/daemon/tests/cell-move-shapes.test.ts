import { test } from "node:test";
import assert from "node:assert/strict";
import { toBeeMoveView } from "../../core/src/cellMove.ts";
import type { BeeMoveRow, BeeMoveView, CellRow } from "../../core/src/types.ts";
import { RPC_ERROR_CODES, RPC_VERBS } from "../src/protocol.ts";
import type { BeeMoveParams, BeeMoveResult, CellExecParams, CellExecResult, CellRetainedRemoveParams } from "../src/protocol.ts";
import type * as Apiary from "./fixtures/apiary-cell-move-shapes.ts";
import { CELL_MOVE_ERROR_CODES } from "./fixtures/apiary-cell-move-shapes.ts";

type Shape<T> = { [K in keyof T]: T[K] };
type Equal<A, B> = (<T>() => T extends Shape<A> ? 1 : 2) extends
  (<T>() => T extends Shape<B> ? 1 : 2) ? true : false;
const wireShapesMatch: [
  Equal<BeeMoveView, Apiary.BeeMoveView>,
  Equal<BeeMoveResult, Apiary.BeeMoveResult>,
  Equal<CellExecResult, Apiary.CellExecResult>,
  Equal<CellRow, Apiary.CellRow>,
  Apiary.BeeMoveParams extends BeeMoveParams ? true : false,
  Apiary.CellExecParams extends CellExecParams ? true : false,
  Apiary.CellRetainedRemoveParams extends CellRetainedRemoveParams ? true : false,
] = [true, true, true, true, true, true, true];

test("Cell move wire matches Apiary's consumer and excludes operational row fields", () => {
  assert.ok(wireShapesMatch.every(Boolean));
  const row: BeeMoveRow = {
    id: "move", beeId: "bee", phase: "starting", sourceGeneration: 4,
    from: { version: 0, mode: "cell", substrate: "cell", cwd: "/cell" },
    to: { version: 1, mode: "checkout", substrate: "hsr", cwd: "/checkout" },
    retainedCellId: "cell", failure: null,
    idempotencyKey: "request", requestHash: "hash",
    stopCommandKey: "stop", reviveCommandKey: "revive",
    instructionsPending: true, instructionsApplied: false,
    createdAt: 10, observedHead: "head",
  };
  const view = toBeeMoveView(row);
  assert.deepEqual(Object.keys(view).sort(), [
    "id", "beeId", "phase", "sourceGeneration", "from", "to", "retainedCellId", "failure",
  ].sort());
  assert.deepEqual(view.from, row.from);
  assert.deepEqual(view.to, row.to);
  for (const verb of ["bee.move", "bee.move.get", "cell.exec", "cell.retained.remove"]) {
    assert.ok((RPC_VERBS as readonly string[]).includes(verb), verb);
  }
  for (const code of CELL_MOVE_ERROR_CODES) assert.ok(RPC_ERROR_CODES.includes(code), code);
});
