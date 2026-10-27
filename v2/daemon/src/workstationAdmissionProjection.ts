import { rewritePath } from "./answerTriggerProjection.ts";

function omitBasis(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("admissionBasis" in value)) return value;
  const { admissionBasis: _basis, ...rest } = value;
  return rest;
}

/** Keep pre-capability mirror leaf shapes unchanged; never rewrite user content. */
export function projectWorkstationAdmission(value: unknown, capabilities: readonly string[]): unknown {
  if (capabilities.includes("workstation.admission.v1")) return value;
  let result = value;
  for (const path of ["bee", "view", "views[].bee", "views[].view", "children[].bee", "children[].view", "result.bee", "result.view", "result.views[].bee", "result.views[].view", "result.children[].bee", "result.children[].view", "result.rows[].payload.bee", "rows[].payload.bee", "events[].payload.bee"]) result = rewritePath(result, path.split("."), omitBasis);
  return result;
}
