import { nativeNodeEnv } from "./runtimeEnvironment.ts";
export { nativeNodeEnv, withoutInspectorArgs } from "./runtimeEnvironment.ts";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
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

export function resolveNodePin(dataDir: string, env: NodeJS.ProcessEnv = process.env, interpreter?: string): NodePin {
  const file = nodePinFile(dataDir);
  const recorded = existsSync(file) ? checkPin(JSON.parse(readFileSync(file, "utf8"))) : undefined;
  const selected = interpreter ?? env.HIVE_NODE_PATH ?? recorded?.path;
  if (!selected) throw new Error("HIVE_NODE_PATH required: supply an absolute managed, versioned native Node executable before installing or deploying Honeybee");
  const pin = probeNativeNode(selected);
  const expected = recorded?.path === pin.path ? recorded : undefined;
  if ((expected && (expected.version !== pin.version || expected.sha256 !== pin.sha256))
    || (env.HIVE_NODE_VERSION && env.HIVE_NODE_VERSION !== pin.version)
    || (env.HIVE_NODE_SHA256 && env.HIVE_NODE_SHA256 !== pin.sha256)) throw new Error("Honeybee Node pin identity drift: version or sha256 differs from the recorded pin");
  return pin;
}

export function persistNodePin(dataDir: string, pin: NodePin): void {
  const file = nodePinFile(dataDir);
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}`;
  writeFileSync(temporary, JSON.stringify(pin) + "\n", { mode: 0o600, flag: "wx" });
  renameSync(temporary, file);
}

export function nodePinEnv(pin: NodePin): Record<string, string> {
  return { HIVE_NODE_PATH: pin.path, HIVE_NODE_VERSION: pin.version, HIVE_NODE_SHA256: pin.sha256 };
}

export function childNodePath(): string {
  const env = process.env;
  if (env.HIVE_NODE_PATH || env.HIVE_NODE_VERSION || env.HIVE_NODE_SHA256) {
    const dataDir = env.HIVE_V2_DATA_DIR ?? join(env.HIVE_STORE_ROOT ?? join(homedir(), ".hive"), "v2");
    return resolveNodePin(dataDir).path;
  }
  if (process.versions.electron) throw new Error("HIVE_NODE_PATH required: Electron cannot launch Honeybee Node children");
  return realpathSync(process.execPath);
}

