import { dirname, join } from "node:path";
import { readLiveEndpointRecord, samePath } from "../../../daemon/src/endpointRecord.ts";
import { ownedPrivateDir } from "../../../core/src/socketPath.ts";
import { inspectProcess } from "../../../harness/src/processIdentity.ts";
import type { RuntimeStatusResult } from "../../../daemon/src/protocol.ts";
import { DaemonDownError, RpcClient } from "../client.ts";

function liveEndpoint(dataDir: string) {
  const record = readLiveEndpointRecord(dataDir);
  if (!record || !record.instanceId || !samePath(record.dataDir, dataDir) || !ownedPrivateDir(dirname(record.socketPath))) return null;
  const live = inspectProcess(record.pid);
  if (live.kind !== "present" || live.state !== "live" || live.birth !== record.processBirth || live.bootId !== record.bootId) return null;
  return record;
}

export function recordedSocketPath(dataDir: string): string {
  return liveEndpoint(dataDir)?.socketPath ?? join(dataDir, "hived.sock");
}

export async function readLiveRuntimeStatus(socketPath: string, dataDir: string): Promise<{ kind: "offline" } | { kind: "live"; status: RuntimeStatusResult }> {
  let client: RpcClient;
  try {
    client = await RpcClient.connect(socketPath, 3000, undefined, { caller: { dataDir, expectedInstanceId: liveEndpoint(dataDir)?.instanceId ?? null } });
  } catch (error) {
    if (error instanceof DaemonDownError && (error.reason === "ENOENT" || error.reason === "ECONNREFUSED")) return { kind: "offline" };
    throw error;
  }
  try {
    return { kind: "live", status: await client.request<RuntimeStatusResult>("runtime.status") };
  } finally {
    client.close();
  }
}
