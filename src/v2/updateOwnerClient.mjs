import { readLiveEndpointRecord, samePath } from "../../v2/daemon/src/endpointRecord.ts";
import { ownedPrivateDir } from "../../v2/core/src/socketPath.ts";
import { inspectProcess } from "../../v2/harness/src/processIdentity.ts";
export { inspectProcess };
import { dirname, join } from "node:path";
function liveEndpoint(dataDir) {
  const record = readLiveEndpointRecord(dataDir);
  if (!record || !record.instanceId || !samePath(record.dataDir, dataDir) || !ownedPrivateDir(dirname(record.socketPath))) return null;
  const live = inspectProcess(record.pid);
  if (live.kind !== "present" || live.state !== "live" || live.birth !== record.processBirth || live.bootId !== record.bootId) return null;
  return record;
}
export function recordedSocketPath(dataDir) {
  return liveEndpoint(dataDir)?.socketPath ?? join(dataDir, "hived.sock");
}
import { DaemonDownError, RpcClient } from "../../v2/cli/src/client.ts";

export async function readLiveUpdateOwner(socketPath, dataDir) {
  let client;
  try {
    client = await RpcClient.connect(socketPath, 3000, undefined, {
      updateOwnerCompatibility: true,
      caller: { dataDir, expectedInstanceId: liveEndpoint(dataDir)?.instanceId ?? null },
    });
  } catch (error) {
    if (error instanceof DaemonDownError && (error.reason === "ENOENT" || error.reason === "ECONNREFUSED")) {
      return { kind: "offline" };
    }
    throw error;
  }
  try {
    return { kind: "live", owner: await client.request("update.status") };
  } finally {
    client.close();
  }
}
