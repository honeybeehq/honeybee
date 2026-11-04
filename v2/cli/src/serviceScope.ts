import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { samePath } from "../../daemon/src/endpointRecord.ts";
import { serviceFileDataDir } from "../../daemon/src/service.ts";
import { socketConfigured, type ResolvedDaemonTarget } from "./target.ts";

export type ServiceScopeCode = "service_refused_in_cell" | "service_data_dir_mismatch" | "service_socket_mismatch" | "service_not_installed" | "daemon_identity_mismatch" | "daemon_stop_timeout";

export class ServiceScopeError extends Error {
  readonly code: ServiceScopeCode;
  readonly details: Record<string, unknown>;
  constructor(code: ServiceScopeCode, message: string, details: Record<string, unknown>) {
    super(message);
    this.name = "ServiceScopeError";
    this.code = code;
    this.details = details;
  }
}

export interface ServiceScope {
  servicePath: string;
  installed: boolean;
  unitDataDir: string | null;
  inCell: boolean;
  dataDirOwned: boolean;
  socketOwned: boolean;
}

export function resolveServiceScope(target: ResolvedDaemonTarget, servicePath: string, env: Record<string, string | undefined> = process.env): ServiceScope {
  let contents: string | null = null;
  try {
    contents = readFileSync(servicePath, "utf8");
  } catch {
    contents = null;
  }
  const installed = contents !== null;
  const unitDataDir = contents === null ? null : serviceFileDataDir(contents);
  const dataDirOwned = unitDataDir !== null
    ? samePath(unitDataDir, target.cfg.dataDir)
    : samePath(target.cfg.dataDir, join(homedir(), ".hive", "v2"));
  const socketOwned = !socketConfigured(target) || samePath(target.cfg.socketPath, target.expectedSocketPath);
  return { servicePath, installed, unitDataDir, inCell: env.HIVE_CELL === "1", dataDirOwned, socketOwned };
}

function detailsOf(scope: ServiceScope, target: ResolvedDaemonTarget): Record<string, unknown> {
  return {
    dataDir: target.cfg.dataDir,
    dataDirSource: target.dataDirSource,
    socketPath: target.cfg.socketPath,
    socketSource: target.socketSource,
    servicePath: scope.servicePath,
    serviceInstalled: scope.installed,
    serviceDataDir: scope.unitDataDir,
  };
}

export function assertServiceOwned(scope: ServiceScope, target: ResolvedDaemonTarget, verb: string): void {
  const details = detailsOf(scope, target);
  if (scope.inCell) {
    throw new ServiceScopeError("service_refused_in_cell", `hive daemon ${verb}: refused inside a Cell (HIVE_CELL=1); the background service belongs to the node, not to a Cell. Run a scratch daemon with: hive daemon run --data-dir <dir>`, details);
  }
  if (!scope.socketOwned) {
    throw new ServiceScopeError("service_socket_mismatch", `hive daemon ${verb}: socket ${target.cfg.socketPath} (from ${target.socketSource}) is not the background service's socket ${target.expectedSocketPath}; refusing to touch the service`, details);
  }
  if (scope.dataDirOwned) return;
  if (verb === "install" && !scope.installed) return;
  if (scope.installed) {
    throw new ServiceScopeError("service_data_dir_mismatch", `hive daemon ${verb}: the background service runs data dir ${scope.unitDataDir ?? "(unknown)"}, not ${target.cfg.dataDir}; refusing to touch it. A daemon for ${target.cfg.dataDir} runs in the foreground with: hive daemon run --data-dir ${target.cfg.dataDir}`, details);
  }
  throw new ServiceScopeError("service_not_installed", `hive daemon ${verb}: no background service is installed for data dir ${target.cfg.dataDir}; run it in the foreground with: hive daemon run --data-dir ${target.cfg.dataDir}`, details);
}
