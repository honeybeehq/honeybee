import { createHash } from "node:crypto";
import { validateSecretEnv } from "../../driver-cell/src/secretOutput.ts";
import { RpcError, type SecretExecutionContext } from "./protocol.ts";

export function secretArgvDigest(argv: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(argv), "utf8").digest("hex");
}

export function admitSecretExecution(params: Record<string, unknown>, raw: unknown, registeredNodeId: string | undefined, now = Date.now()): SecretExecutionContext {
  const refuse = (): never => { throw new RpcError("invalid_request", "secret_execution_invalid"); };
  if (Object.keys(params).some(key => !["beeId", "cellId", "executionId", "idempotencyKey", "argv", "cwd", "timeoutMs", "expiresAt", "argvDigest", "nodeId"].includes(key))) refuse();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) refuse();
  const ctx = raw as SecretExecutionContext;
  if (Object.keys(ctx).some(key => !["env", "nodeId", "beeId", "cellId", "executionId", "argvDigest", "expiresAt"].includes(key))) refuse();
  for (const key of ["nodeId", "beeId", "cellId", "executionId", "argvDigest"] as const) {
    if (typeof ctx[key] !== "string" || !/^[A-Za-z0-9_.:-]{1,256}$/.test(ctx[key]) || ctx[key] !== params[key]) refuse();
  }
  if (!registeredNodeId || ctx.nodeId !== registeredNodeId || params.idempotencyKey !== ctx.executionId) refuse();
  if (!Array.isArray(params.argv) || !params.argv.length || params.argv.some(arg => typeof arg !== "string" || arg.includes("\0")) || secretArgvDigest(params.argv) !== ctx.argvDigest) refuse();
  if (!Number.isSafeInteger(ctx.expiresAt) || ctx.expiresAt !== params.expiresAt || ctx.expiresAt <= now || ctx.expiresAt > now + 30_000) refuse();
  if (params.cwd !== undefined && typeof params.cwd !== "string" || params.timeoutMs !== undefined && (typeof params.timeoutMs !== "number" || !Number.isFinite(params.timeoutMs))) refuse();
  try { return { ...ctx, env: validateSecretEnv(ctx.env) }; } catch { return refuse(); }
}
