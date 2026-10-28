import type { ProcessIdentity, ProcessInspection } from "../../harness/src/processIdentity.ts";
import { sameProcess } from "../../harness/src/processIdentity.ts";
import { RpcError } from "./protocol.ts";

export function spawnCallerBee(
  peer: { pid: number; uid: number; processBirth: string | null },
  runtimes: ReadonlyArray<{ beeId: string; identity: ProcessIdentity | null; pid?: number | null }>,
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
    const owner = runtimes.find(runtime => runtime.identity ? sameProcess(runtime.identity, value) : runtime.pid === value.pid);
    if (owner && !owner.identity) throw new RpcError("caller_not_trusted", "Spawning bee process identity is unresolved");
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

export function bindSpawnParent(params: Record<string, unknown>, callerBeeId: string | null, serviceAuthority = false): Record<string, unknown> {
  if (callerBeeId === null) {
    if (!serviceAuthority && (params.parentId !== undefined || params.parentExternal === true)) throw new RpcError("caller_not_trusted", "Explicit, empty, and external parent claims require the registered Apiary service");
    return params;
  }
  if (params.parentExternal === true && params.parentId === callerBeeId) return { ...params, parentId: callerBeeId, parentExternal: true };
  if (params.parentExternal === true || params.parentId !== undefined && params.parentId !== callerBeeId) {
    throw new RpcError("caller_not_trusted", "A bee spawn must use its authenticated caller as the local parent; --no-parent and external or different parents are refused");
  }
  return { ...params, parentId: callerBeeId, parentExternal: false };
}
