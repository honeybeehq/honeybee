import { dirname, join } from "node:path";
import { readLiveEndpointRecord, samePath } from "../../../daemon/src/endpointRecord.ts";
import { ownedPrivateDir } from "../../../core/src/socketPath.ts";
import { inspectProcess } from "../../../harness/src/processIdentity.ts";

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
