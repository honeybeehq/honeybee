import type { CellRow } from "../../core/src/types.ts";
import { resolveCellSandboxPolicy, type NodeKind } from "../../driver-cell/src/sandbox.ts";

export type MirroredCellRow = CellRow & {effectiveSandbox?: boolean};

export function mirrorCellSandbox(cell: CellRow, nodeKind: NodeKind, configured: boolean | null): CellRow & {effectiveSandbox: boolean} {
  return {...cell, effectiveSandbox: resolveCellSandboxPolicy(nodeKind, cell.sandbox, configured).enabled};
}
