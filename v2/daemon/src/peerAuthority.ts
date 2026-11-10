import { INBOX_AGENT, type CoreStore } from "../../core/src/index.ts";
import type { ProcessInspection } from "../../harness/src/processIdentity.ts";
import { peerOwner, type ConfinedAdmission, type PeerOwner } from "./confinedPeer.ts";
import { RpcError, type RpcVerb } from "./protocol.ts";
import type { RpcConn } from "./rpc.ts";
import { spawnCallerBee } from "./spawnLineage.ts";

export function peerOwnerOf(store: CoreStore, peer: NonNullable<RpcConn["localPeer"]>, inspect: (pid: number) => ProcessInspection): PeerOwner | null {
  const owner = spawnCallerBee(peer, pid => store.runtimesByPid(pid).map(runtime => {
    const binding = store.runtimeProcessIdentity(runtime.beeId, runtime.generation);
    return { beeId: runtime.beeId, generation: runtime.generation, substrate: runtime.substrate, identity: binding.kind === "bound" ? binding.identity : null, pid: runtime.stopped ? null : pid };
  }), inspect);
  return owner && { beeId: owner.beeId, generation: owner.generation, substrate: owner.substrate };
}

export function admitConfinedPeer(store: CoreStore, admission: ConfinedAdmission, verb: RpcVerb, params: Record<string, unknown>, conn: RpcConn): Record<string, unknown> {
  const owner = conn.ingress === "local_unix" ? peerOwner(conn) : null;
  const bee = owner ? store.getBee(owner.beeId) : null;
  const runtime = owner ? store.currentRuntime(owner.beeId) : null;
  if (!owner || !bee || bee.lifecycle !== "active" || !runtime || runtime.state === "stopped") throw new RpcError("confined_peer_refused", "Confined caller has no live owning bee");
  if (runtime.generation !== owner.generation || store.runtimeProcessIdentity(bee.id, runtime.generation).kind !== "bound") throw new RpcError("confined_peer_refused", "Confined caller generation is stale");
  return admission.admit(verb, params, {
    beeId: bee.id, generation: runtime.generation, parentId: bee.parentExternal ? null : bee.parentId,
    canSend: target => { const parent = store.getBee(target); return !!parent && parent.agent !== INBOX_AGENT; },
  });
}
