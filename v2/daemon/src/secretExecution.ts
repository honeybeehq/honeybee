import { createHash } from "node:crypto";
import { validateSecretEnv } from "../../driver-cell/src/secretOutput.ts";
import { RpcError, type SecretExecutionContext } from "./protocol.ts";

export function secretArgvDigest(argv: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(argv), "utf8").digest("hex");
}

export function admitSecretExecution(params: Record<string, unknown>, raw: unknown, registeredNodeId: string | undefined, now = Date.now()): SecretExecutionContext & { env: Record<string, string> } {
  const refuse = (): never => { throw new RpcError("invalid_request", "secret_execution_invalid"); };
  if (Object.keys(params).some(key => !["beeId", "cellId", "executionId", "idempotencyKey", "argv", "cwd", "timeoutMs", "expiresAt", "argvDigest", "nodeId", "outputCapture"].includes(key))) refuse();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) refuse();
  const ctx = raw as SecretExecutionContext;
  if (Object.keys(ctx).some(key => !["env", "nodeId", "beeId", "cellId", "executionId", "argvDigest", "expiresAt", "outputCapture"].includes(key))) refuse();
  for (const key of ["nodeId", "beeId", "cellId", "executionId", "argvDigest"] as const) {
    if (typeof ctx[key] !== "string" || !/^[A-Za-z0-9_.:-]{1,256}$/.test(ctx[key]) || ctx[key] !== params[key]) refuse();
  }
  if (!registeredNodeId || ctx.nodeId !== registeredNodeId || params.idempotencyKey !== ctx.executionId) refuse();
  if (!Array.isArray(params.argv) || !params.argv.length || params.argv.some(arg => typeof arg !== "string" || arg.includes("\0")) || secretArgvDigest(params.argv) !== ctx.argvDigest) refuse();
  if (!Number.isSafeInteger(ctx.expiresAt) || ctx.expiresAt !== params.expiresAt || ctx.expiresAt <= now || ctx.expiresAt > now + 30_000) refuse();
  if (params.cwd !== undefined && typeof params.cwd !== "string" || params.timeoutMs !== undefined && (typeof params.timeoutMs !== "number" || !Number.isFinite(params.timeoutMs))) refuse();
  if (ctx.outputCapture !== undefined) {
    const capture = ctx.outputCapture;
    if (!capture || typeof capture !== "object" || Array.isArray(capture) || Object.keys(capture).sort().join(",") !== "expiresAt,leaseId,maxBytes,name") refuse();
    if (typeof capture.name !== "string" || (capture.name.length < 1 || capture.name.length > 120 || capture.name.includes("\0")) || typeof capture.leaseId !== "string" || !/^[A-Za-z0-9_.:-]{1,256}$/.test(capture.leaseId)) refuse();
    if (!Number.isSafeInteger(capture.maxBytes) || capture.maxBytes < 1 || capture.maxBytes > 16384 || !Number.isSafeInteger(capture.expiresAt) || capture.expiresAt <= now || capture.expiresAt > now + 30_000) refuse();
    const metadata = params.outputCapture as typeof capture;
    if (!metadata || Object.keys(metadata).length !== 4 || Object.keys(capture).some(key => capture[key as keyof typeof capture] !== metadata[key as keyof typeof capture]) || ctx.env !== undefined) refuse();
    return { ...ctx, env: {}, outputCapture: { ...capture } };
  }
  if (params.outputCapture !== undefined) refuse();
  try { return { ...ctx, env: validateSecretEnv(ctx.env) }; } catch { return refuse(); }
}
