import { DaemonDownError, RpcClient } from "../../v2/cli/src/client.ts";

export async function readLiveUpdateOwner(socketPath, dataDir) {
  let client;
  try {
    client = await RpcClient.connect(socketPath, 3000, undefined, {
      caller: { dataDir, expectedInstanceId: null },
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
