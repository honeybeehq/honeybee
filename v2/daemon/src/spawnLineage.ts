import type { ProcessIdentity, ProcessInspection } from "../../harness/src/processIdentity.ts";
import { sameProcess } from "../../harness/src/processIdentity.ts";
import { RpcError } from "./protocol.ts";

export function spawnCallerBee(
  peer: { pid: number; uid: number; processBirth: string | null },
  runtimes: ReadonlyArray<{ beeId: string; identity: ProcessIdentity }>,
  inspect: (pid: number) => ProcessInspection,
): string | null {
  const chain: Extract<ProcessInspection, { kind: "present" }>[] = [];
  let pid = peer.pid;
  for (let depth = 0; depth < 256; depth++) {
    const value = inspect(pid);
    if (value.kind !== "present" || value.state !== "live"
      || depth === 0 && (value.birth !== peer.processBirth || value.uid !== peer.uid) || chain.some(item => item.pid === pid)) {
      throw new RpcError("caller_not_trusted", "Spawn caller process ancestry is unavailable");
    }
    chain.push(value);
    const owner = runtimes.find(runtime => sameProcess(runtime.identity, value));
    if (owner || value.ppid === 0) {
      if (chain.some(item => {
        const current = inspect(item.pid);
        return !sameProcess(item, current) || current.ppid !== item.ppid || current.state !== "live";
      })) throw new RpcError("caller_not_trusted", "Spawn caller process ancestry changed");
      return owner?.beeId ?? null;
    }
    pid = value.ppid;
  }
  throw new RpcError("caller_not_trusted", "Spawn caller process ancestry exceeds the supported depth");
}

export function bindSpawnParent(params: Record<string, unknown>, callerBeeId: string | null): Record<string, unknown> {
  if (callerBeeId === null) return params;
  if (params.parentExternal === true || params.parentId !== undefined && params.parentId !== callerBeeId) {
    throw new RpcError("caller_not_trusted", "A bee spawn must use its authenticated caller as the local parent; --no-parent and external or different parents are refused");
  }
  return { ...params, parentId: callerBeeId, parentExternal: false };
}
