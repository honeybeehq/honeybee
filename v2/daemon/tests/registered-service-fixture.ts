import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RpcVerb, RpcRequestContext } from "../src/protocol.ts";
import type { RpcClient } from "../../cli/src/client.ts";
import { localTrustMessage, type LocalTrustChallenge } from "../src/localRpcTrust.ts";
import { makeDaemonDir, type DaemonConfigOverrides } from "./helpers.ts";

export function makeRegisteredServiceDir(overrides: DaemonConfigOverrides = {}): ReturnType<typeof makeDaemonDir> {
  return makeDaemonDir({ ...overrides, rpcLocalTrust: { requireObservationCaller: true } });
}

export async function registerService(client: RpcClient, dir: string): Promise<void> {
  const challenge = await client.request<LocalTrustChallenge>("rpc.localTrust.challenge");
  const key = readFileSync(join(dir, "rpc-private", "registration.key"));
  let token: string;
  try {
    token = createHmac("sha256", key).update(localTrustMessage(challenge)).digest("hex");
  } finally {
    key.fill(0);
  }
  await client.request("rpc.localTrust.register", { pid: process.pid, challengeId: challenge.challengeId, token });
}

export function serviceRequest(client: RpcClient): RpcClient["request"] {
  return <T>(verb: RpcVerb, params: Record<string, unknown> = {}, timeoutMs = 10_000, context?: RpcRequestContext) => client.request<T>(verb, params, timeoutMs,
    context ?? (["spawn", "bee.fork", "thread.fork", "thread.handoff"].includes(verb) ? { serviceIntent: "service" } : undefined));
}
