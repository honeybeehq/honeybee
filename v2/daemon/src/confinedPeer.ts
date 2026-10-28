import { accessSync, closeSync, constants, openSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import type { LocalPeer } from "./peerCredentials.ts";
import { RpcError } from "./protocol.ts";
import type { RpcConn } from "./rpc.ts";

export type Confinement = "confined" | "unconfined" | "unknown";
export interface ProcReader {
  open(pid: number): number;
  birth(fd: number): string;
  userns(fd: number): string;
  selfUserns(): string;
  children?(fd: number, pid: number): number[];
  close(fd: number): void;
}
export const procReader: ProcReader = {
  open: pid => openSync(`/proc/${pid}`, constants.O_RDONLY | constants.O_DIRECTORY),
  birth: fd => {
    const stat = readFileSync(`/proc/self/fd/${fd}/stat`, "utf8");
    const birth = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    if (!birth || !/^\d+$/.test(birth)) throw new Error("Process birth unavailable");
    return `linux:${birth}`;
  },
  userns: fd => readlinkSync(`/proc/self/fd/${fd}/ns/user`),
  selfUserns: () => readlinkSync("/proc/self/ns/user"),
  children: (fd, pid) => readFileSync(`/proc/self/fd/${fd}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number),
  close: closeSync,
};
export function peerUserNamespace(peer: LocalPeer | undefined, proc: ProcReader = procReader): "same" | "different" | "unavailable" {
  if (!peer?.processBirth) return "unavailable";
  let fd: number | undefined;
  try {
    fd = proc.open(peer.pid);
    if (proc.birth(fd) !== peer.processBirth) return "unavailable";
    const different = proc.userns(fd) !== proc.selfUserns();
    if (proc.birth(fd) !== peer.processBirth) return "unavailable";
    return different ? "different" : "same";
  } catch { return "unavailable"; }
  finally { if (fd !== undefined) proc.close(fd); }
}
export function runtimeUserNamespace(pid: number, proc: ProcReader = procReader, seen = new Set<number>()): "same" | "different" | "unavailable" {
  if (seen.size >= 64 || seen.has(pid)) return "unavailable";
  seen.add(pid);
  let fd: number | undefined;
  try {
    fd = proc.open(pid);
    const birth = proc.birth(fd);
    const own = proc.userns(fd) === proc.selfUserns() ? "same" : "different";
    const children = proc.children?.(fd, pid) ?? [];
    const result = children.length ? children.map(child => runtimeUserNamespace(child, proc, seen)) : [own];
    if (proc.birth(fd) !== birth || result.includes("unavailable")) return "unavailable";
    return result.every(value => value === "different") ? "different" : "same";
  } catch { return "unavailable"; }
  finally { if (fd !== undefined) proc.close(fd); }
}
export function peerConfinement(peer: LocalPeer | undefined, options: {
  platform?: string; proc?: ProcReader; substrate?: () => string | null; strict?: boolean; registered?: boolean;
} = {}): Confinement {
  if ((options.platform ?? process.platform) !== "linux") return "unknown";
  if (peerUserNamespace(peer, options.proc) !== "same") return "confined";
  try {
    const substrate = options.substrate?.() ?? null;
    if (substrate === "cell") return "confined";
    return options.strict && !options.registered && substrate === null ? "confined" : "unconfined";
  } catch { return "confined"; }
}
export function strictConfinementReasons(sandbox: boolean, setuid: boolean, namespace?: "same" | "different" | "unavailable"): string[] {
  return [...(!sandbox ? ["cell_sandbox_off"] : []), ...(setuid ? ["setuid_bwrap"] : []), ...(namespace !== undefined && namespace !== "different" ? ["cell_userns_unisolated"] : [])];
}
export function bwrapMode(): {path: string | null; setuid: boolean} {
  for (const directory of (process.env.PATH ?? "").split(":")) {
    try {
      const path = realpathSync(join(directory, "bwrap"));
      accessSync(path, constants.X_OK);
      const stat = statSync(path);
      if (stat.isFile()) return {path, setuid: (stat.mode & constants.S_ISUID) !== 0};
    } catch {}
  }
  return {path: null, setuid: false};
}
export function assertConfinedVerb(verb: string, confinement: Confinement): void {
  if (confinement === "confined" && (verb.startsWith("account.credentials.") || verb === "account.lease.export" || verb === "rpc.localTrust.challenge" || verb === "rpc.localTrust.register")) {
    throw new RpcError("confined_peer_refused", "Confined callers cannot acquire service authority or access host credentials");
  }
}
export function assertConfinedSpawn(params: Record<string, unknown>, conn: Pick<RpcConn, "confinement" | "spawnServiceAuthority" | "ingress">): void {
  if (conn.confinement !== "confined" || conn.spawnServiceAuthority) return;
  const cell = params.cell as {sandbox?: unknown} | null | undefined;
  if (params.cwd !== undefined || params.node !== undefined || params.nodeId !== undefined || params.relay !== undefined || conn.ingress === "node_relay" || cell?.sandbox === false
    || (params.agent !== "inbox" && params.substrate !== "cell")) {
    throw new RpcError("confined_spawn_refused", "Confined callers may only spawn sandboxed local Cells without an explicit cwd");
  }
}
