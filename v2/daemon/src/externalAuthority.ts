import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { externalConfig, record, type ExternalExecConfig } from "../../core/src/externalExec.ts";

export interface ExternalManagement {
  root: string;
  keyFile: string;
  endpointFile: string;
  socketPath: string;
}
function below(root: string, path: string): boolean {
  const rel = relative(resolve(root), path);
  return rel === "" || rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
export function privateManagementFile(path: string, root: string): Buffer {
  const uid = process.geteuid!();
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path || !below(root, path)) throw new Error("external_management_path_invalid");
  let cursor = dirname(path);
  while (true) {
    const stat = lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid && stat.uid !== 0 || (stat.mode & 0o022) !== 0 && !(stat.uid === 0 && (stat.mode & 0o1000) !== 0)) throw new Error("external_management_parent_unprotected");
    if (below(root, cursor) && (stat.uid !== uid || (stat.mode & 0o777) !== 0o700)) throw new Error("external_management_parent_unprotected");
    const parent = dirname(cursor); if (cursor === parent) break; cursor = parent;
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & 0o777) !== 0o600 || stat.size > 1024 * 1024) throw new Error("external_management_file_unprotected");
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
export function externalOwner(value: unknown, cellsRoot: string, dataDir = join(homedir(), ".hive", "v2")): { externalExec: ExternalExecConfig; externalManagement?: ExternalManagement } {
  if (value === undefined) return {externalExec: externalConfig(undefined)};
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error("external_management_owner_file_required");
  const root = dirname(value);
  if (below(root, join(homedir(), ".hive", "v2")) || below(root, dataDir) || below(root, cellsRoot) || below(cellsRoot, root) || /\/\.hive\/v2\/cells(?:\/|$)/.test(root)) throw new Error("external_management_must_be_outside_cell");
  const owner = record(JSON.parse(privateManagementFile(value, root).toString("utf8")));
  if (Object.keys(owner).sort().join(",") !== "externalExec,schema" || owner.schema !== "honeybee.external-owner.v1") throw new Error("external_management_config_invalid");
  const externalManagement = {root, keyFile: join(root, "management.key"), endpointFile: join(root, "endpoint.json"), socketPath: join(root, "hived.sock")};
  const key = privateManagementFile(externalManagement.keyFile, root);
  try { if (key.length !== 32) throw new Error("external_management_key_invalid"); } finally { key.fill(0); }
  if (Buffer.byteLength(externalManagement.socketPath) > 103) throw new Error("external_management_socket_too_long");
  return {externalExec: externalConfig(owner.externalExec), externalManagement};
}
