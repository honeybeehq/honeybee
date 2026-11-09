import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { samePath } from "../../daemon/src/endpointRecord.ts";
import { serviceFileDataDir } from "../../daemon/src/service.ts";
import { socketConfigured, type ResolvedDaemonTarget } from "./target.ts";

export type ServiceScopeCode = "service_refused_in_cell" | "service_home_redirected" | "service_label_unpaired" | "service_data_dir_mismatch" | "service_socket_mismatch" | "service_not_installed" | "service_runtime_missing" | "daemon_identity_mismatch" | "daemon_stop_timeout";

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
  labelUnpaired: boolean;
  accountHome: string | null;
  homeRedirected: boolean;
  dataDirOwned: boolean;
  socketOwned: boolean;
}

function accountHomeOf(): string | null {
  try {
    return userInfo().homedir || null;
  } catch {
    return null;
  }
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
  const accountHome = accountHomeOf();
  const homeRedirected = accountHome === null || !samePath(homedir(), accountHome);
  const dataDirOwned = unitDataDir !== null && samePath(unitDataDir, target.cfg.dataDir);
  const socketOwned = !socketConfigured(target) || samePath(target.cfg.socketPath, target.expectedSocketPath);
  const labelUnpaired = Boolean(env.HIVE_V2_SERVICE_DIR) && !env.HIVE_V2_SERVICE_LABEL;
  return { servicePath, installed, unitDataDir, inCell: env.HIVE_CELL === "1", labelUnpaired, accountHome, homeRedirected, dataDirOwned, socketOwned };
}

export function isNodeDataDir(scope: ServiceScope, dir: string): boolean {
  if (scope.unitDataDir !== null && samePath(dir, scope.unitDataDir)) return true;
  return scope.accountHome !== null && samePath(dir, join(scope.accountHome, ".hive", "v2"));
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
    home: homedir(),
    accountHome: scope.accountHome,
  };
}

export function refuseNodeDaemon(scope: ServiceScope, target: ResolvedDaemonTarget, verb: string, dataDir: string): ServiceScopeError {
  const details = detailsOf(scope, target);
  if (!scope.installed) {
    return new ServiceScopeError("service_not_installed", `hive daemon ${verb}: no background service is installed for data dir ${dataDir}; run it in the foreground with: hive daemon run --data-dir ${dataDir}`, details);
  }
  return new ServiceScopeError("service_data_dir_mismatch", `hive daemon ${verb}: the background service runs data dir ${scope.unitDataDir ?? "(unknown)"}, not ${dataDir}; refusing to touch it. A daemon for ${dataDir} runs in the foreground with: hive daemon run --data-dir ${dataDir}`, details);
}

export function assertServiceOwned(scope: ServiceScope, target: ResolvedDaemonTarget, verb: string): void {
  const details = detailsOf(scope, target);
  if (scope.inCell) {
    throw new ServiceScopeError("service_refused_in_cell", `hive daemon ${verb}: refused inside a Cell (HIVE_CELL=1); the background service belongs to the node, not to a Cell. Run a scratch daemon with: hive daemon run --data-dir <dir>`, details);
  }
  if (scope.labelUnpaired) {
    throw new ServiceScopeError("service_label_unpaired", `hive daemon ${verb}: HIVE_V2_SERVICE_DIR points at ${scope.servicePath} but HIVE_V2_SERVICE_LABEL is not set, so the verb would drive the node's own service label from a sandbox unit. Set HIVE_V2_SERVICE_LABEL with it, or unset both`, details);
  }
  if (scope.homeRedirected) {
    throw new ServiceScopeError("service_home_redirected", `hive daemon ${verb}: HOME (${homedir()}) is not this account's home (${scope.accountHome ?? "unknown"}); the user service manager runs under the account home, so a service file under this HOME would never be the one it runs. Refusing to touch the service`, details);
  }
  if (!scope.socketOwned) {
    throw new ServiceScopeError("service_socket_mismatch", `hive daemon ${verb}: socket ${target.cfg.socketPath} (from ${target.socketSource}) is not the background service's socket ${target.expectedSocketPath}; refusing to touch the service`, details);
  }
  if (scope.dataDirOwned) return;
  if (verb === "install" && !scope.installed) return;
  throw refuseNodeDaemon(scope, target, verb, target.cfg.dataDir);
}
