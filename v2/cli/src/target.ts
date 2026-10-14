import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadNodeConfig, type ResolvedNodeConfig } from "../../daemon/src/config.ts";
import { canonicalPath, readLiveEndpointRecord, samePath } from "../../daemon/src/endpointRecord.ts";
import { RpcError } from "../../daemon/src/protocol.ts";
import type { DaemonInstance } from "./client.ts";

export type DataDirSource = "flag" | "env" | "default";
export type SocketSource = "flag" | "env" | "record" | "config";

export interface DaemonTargetInputs {
  dataDirFlag?: string;
  socketFlag?: string;
  configPath?: string;
}

export interface ResolvedDaemonTarget {
  cfg: ResolvedNodeConfig;
  recordInstanceId: string | null;
  dataDirSource: DataDirSource;
  socketSource: SocketSource;
  expectedSocketPath: string;
}

export interface DaemonTargetJson {
  dataDir: string;
  dataDirSource: DataDirSource;
  socketPath: string;
  socketSource: SocketSource;
  instanceId: string | null;
  daemonDataDir: string | null;
  connected: boolean;
}

function envValue(env: Record<string, string | undefined>, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

export function callerDataDir(env: Record<string, string | undefined> = process.env): string | null {
  const dataDir = envValue(env, "HIVE_V2_DATA_DIR");
  return dataDir ? canonicalPath(dataDir) : null;
}

export function resolveDaemonTarget(inputs: DaemonTargetInputs, env: Record<string, string | undefined> = process.env): ResolvedDaemonTarget {
  const envDataDir = envValue(env, "HIVE_V2_DATA_DIR");
  const dataDirSource: DataDirSource = inputs.dataDirFlag ? "flag" : envDataDir ? "env" : "default";
  const dataDir = resolve(inputs.dataDirFlag ?? envDataDir ?? join(homedir(), ".hive", "v2"));
  const cfg = loadNodeConfig(dataDir, inputs.configPath);
  const record = readLiveEndpointRecord(dataDir);
  const expectedSocketPath = resolve(record?.socketPath ?? cfg.socketPath);
  const envSocket = envValue(env, "HIVE_V2_SOCKET_PATH");
  const useEnvSocket = !inputs.socketFlag && !inputs.dataDirFlag && envSocket !== undefined;
  const socketSource: SocketSource = inputs.socketFlag ? "flag" : useEnvSocket ? "env" : record ? "record" : "config";
  const socketPath = resolve(inputs.socketFlag ?? (useEnvSocket ? envSocket : expectedSocketPath));
  return { cfg: { ...cfg, socketPath }, recordInstanceId: record?.instanceId ?? null, dataDirSource, socketSource, expectedSocketPath };
}

export function socketConfigured(target: ResolvedDaemonTarget): boolean {
  return target.socketSource === "flag" || target.socketSource === "env";
}

export function dataDirGiven(target: ResolvedDaemonTarget): boolean {
  return target.dataDirSource === "flag" || target.dataDirSource === "env";
}

function mismatch(target: ResolvedDaemonTarget, message: string, extra: Record<string, unknown>): RpcError {
  return new RpcError("socket_mismatch", message, {
    dataDir: target.cfg.dataDir,
    dataDirSource: target.dataDirSource,
    socketPath: target.cfg.socketPath,
    socketSource: target.socketSource,
    ...extra,
  });
}

export function assertSocketMatchesDataDir(target: ResolvedDaemonTarget): void {
  if (!socketConfigured(target) || !dataDirGiven(target)) return;
  if (samePath(target.cfg.socketPath, target.expectedSocketPath)) return;
  throw mismatch(target,
    `socket ${target.cfg.socketPath} (from ${target.socketSource}) is not the socket recorded for data dir ${target.cfg.dataDir} (${target.expectedSocketPath})`,
    { expectedSocketPath: target.expectedSocketPath });
}

export function assertInstanceMatchesDataDir(target: ResolvedDaemonTarget, instance: DaemonInstance | null): void {
  if (!instance || !dataDirGiven(target)) return;
  if (samePath(instance.dataDir, target.cfg.dataDir)) return;
  throw mismatch(target,
    `daemon at ${target.cfg.socketPath} serves data dir ${instance.dataDir}, not ${target.cfg.dataDir}`,
    { daemonDataDir: instance.dataDir, instanceId: instance.id });
}

export function assertSameInstance(target: ResolvedDaemonTarget, seen: DaemonInstance | null, next: DaemonInstance | null): void {
  if (!seen || !next || seen.id === next.id) return;
  throw mismatch(target,
    `daemon instance changed within one command (${seen.id} then ${next.id})`,
    { instanceId: seen.id, nextInstanceId: next.id });
}

export function daemonTargetJson(target: ResolvedDaemonTarget, instance: DaemonInstance | null, connected: boolean): DaemonTargetJson {
  return {
    dataDir: target.cfg.dataDir,
    dataDirSource: target.dataDirSource,
    socketPath: target.cfg.socketPath,
    socketSource: target.socketSource,
    instanceId: instance?.id ?? null,
    daemonDataDir: instance?.dataDir ?? null,
    connected,
  };
}
