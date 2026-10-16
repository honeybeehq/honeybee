import { nativeNodeEnv } from "./runtimeEnvironment.ts";
export { nativeNodeEnv, withoutInspectorArgs } from "./runtimeEnvironment.ts";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface NodePin {
  path: string;
  version: string;
  sha256: string;
}

export function nodePinFile(dataDir: string): string {
  return join(resolve(dataDir, ".."), "node-runtime.json");
}

export function probeNativeNode(path: string): NodePin {
  if (!isAbsolute(path) || /\.app[/\\]Contents[/\\]MacOS[/\\]/i.test(path)) throw new Error("HIVE_NODE_PATH must be an absolute native Node executable, never Electron");
  const real = realpathSync(path);
  if (/\.app[/\\]Contents[/\\]MacOS[/\\]/i.test(real)) throw new Error("HIVE_NODE_PATH refuses an Electron app executable");
  accessSync(real, constants.X_OK);
  const sha256 = createHash("sha256").update(readFileSync(real)).digest("hex");
  let identity: { node?: unknown; electron?: unknown; execPath?: unknown };
  try {
    identity = JSON.parse(execFileSync(real, ["--eval", "process.stdout.write(JSON.stringify({node:process.versions.node,electron:process.versions.electron,execPath:process.execPath}))"], {
      env: nativeNodeEnv(), timeout: 5000, maxBuffer: 4096, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }));
  } catch { throw new Error("HIVE_NODE_PATH identity probe failed; a native Node executable is required"); }
  if (identity.electron !== undefined || typeof identity.node !== "string" || !/^\d+\.\d+\.\d+$/.test(identity.node)
    || typeof identity.execPath !== "string" || realpathSync(identity.execPath) !== real) throw new Error("HIVE_NODE_PATH identity probe refused Electron or an invalid Node identity");
  return { path: real, version: identity.node, sha256 };
}

function checkPin(value: unknown): NodePin {
  if (value == null || typeof value !== "object" || !("path" in value) || !("version" in value) || !("sha256" in value)
    || typeof value.path !== "string" || !isAbsolute(value.path) || typeof value.version !== "string"
    || !/^\d+\.\d+\.\d+$/.test(value.version) || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error("invalid persisted Honeybee Node pin");
  return { path: value.path, version: value.version, sha256: value.sha256 };
}

export function resolveNodePin(dataDir: string, env: NodeJS.ProcessEnv = process.env, interpreter?: string, allowMigration = false): NodePin {
  const file = nodePinFile(dataDir);
  const recorded = existsSync(file) ? checkPin(JSON.parse(readFileSync(file, "utf8"))) : undefined;
  const selected = interpreter ?? env.HIVE_NODE_PATH ?? recorded?.path;
  if (!selected) throw new Error("HIVE_NODE_PATH required: supply an absolute managed, versioned native Node executable before installing or deploying Honeybee");
  const migrating = allowMigration && env.HIVE_NODE_PATH !== undefined && env.HIVE_NODE_PATH !== recorded?.path;
  const expected = recorded && !migrating ? recorded : undefined;
  const pin = probeNativeNode(selected);
  if (migrating && realpathSync(env.HIVE_NODE_PATH ?? selected) !== pin.path) throw new Error("HIVE_NODE_PATH and service interpreter must select the same native Node pin");
  if ((expected && (expected.path !== pin.path || expected.version !== pin.version || expected.sha256 !== pin.sha256))
    || (env.HIVE_NODE_VERSION && env.HIVE_NODE_VERSION !== pin.version)
    || (env.HIVE_NODE_SHA256 && env.HIVE_NODE_SHA256 !== pin.sha256)) throw new Error("Honeybee Node pin identity drift: path, version or sha256 differs from the recorded pin");
  return pin;
}

export function writeNodeRuntimeState(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, file);
  const directory = openSync(dirname(file), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

export function persistNodePin(dataDir: string, pin: NodePin): void {
  writeNodeRuntimeState(nodePinFile(dataDir), pin);
}

export function nodeRepairFile(dataDir: string): string {
  return join(dirname(nodePinFile(dataDir)), "node-runtime-held.json");
}

export function readNodeRepair(dataDir: string): unknown {
  const file = nodeRepairFile(dataDir);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

export function validateDaemonNode(dataDir: string, actualProcess = false): string | null {
  try {
    const pin = resolveNodePin(dataDir);
    if (actualProcess && (process.versions.electron || realpathSync(process.execPath) !== pin.path || process.versions.node !== pin.version)) throw new Error("running daemon interpreter differs from the recorded native Node pin");
    rmSync(nodeRepairFile(dataDir), { force: true });
    return null;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    writeNodeRuntimeState(nodeRepairFile(dataDir), { state: "held", reason: "node_pin_invalid", detail, at: new Date().toISOString() });
    return detail;
  }
}

export function nodePinEnv(pin: NodePin): Record<string, string> {
  return { HIVE_NODE_PATH: pin.path, HIVE_NODE_VERSION: pin.version, HIVE_NODE_SHA256: pin.sha256 };
}

export function childNodePath(): string {
  const env = process.env;
  const dataDir = env.HIVE_V2_DATA_DIR ?? join(env.HIVE_STORE_ROOT ?? join(homedir(), ".hive"), "v2");
  if (env.HIVE_NODE_PATH || env.HIVE_NODE_VERSION || env.HIVE_NODE_SHA256 || existsSync(nodePinFile(dataDir))) {
    return resolveNodePin(dataDir).path;
  }
  if (process.versions.electron) throw new Error("HIVE_NODE_PATH required: Electron cannot launch Honeybee Node children");
  return realpathSync(process.execPath);
}

