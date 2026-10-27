import { lstat, readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { isAbsolute, join, relative, resolve } from "node:path";
import { atomicWriteFile } from "./fsx.js";

async function readConfig(path: string): Promise<Record<string, unknown>> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return {};
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("deploy: config must be a regular file");
  const config: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("deploy: invalid node config");
  return config as Record<string, unknown>;
}

export async function provisionQuestionWithdrawal(dataDir: string) {
  const path = join(dataDir, "config.json");
  const config = await readConfig(path);
  const before = config.rpcLocalTrust;
  if (before !== undefined && (!before || typeof before !== "object" || Array.isArray(before))) throw new Error("deploy: invalid rpcLocalTrust");
  const trust = (before ?? {}) as Record<string, unknown>;
  if (trust.requireObservationCaller === false) return { enabled: false, restore: async () => {} };
  if (trust.requireObservationCaller !== undefined && trust.requireObservationCaller !== true) throw new Error("deploy: invalid rpcLocalTrust.requireObservationCaller");
  const keyFile = trust.registrationKeyFile ?? join(dataDir, "rpc-private", "registration.key");
  if (typeof keyFile !== "string" || !isAbsolute(keyFile)) throw new Error("deploy: registration key must be absolute and inside the data directory");
  const keyRelative = relative(resolve(dataDir), resolve(keyFile));
  if (!keyRelative || keyRelative === ".." || keyRelative.startsWith("../") || isAbsolute(keyRelative)) throw new Error("deploy: registration key must be inside the data directory");
  const after = { ...trust, requireObservationCaller: true,
    registrationKeyFile: keyFile };
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  if (changed) await atomicWriteFile(path, `${JSON.stringify({ ...config, rpcLocalTrust: after }, null, 2)}\n`, { mode: 0o600 });
  return {
    enabled: true,
    restore: async () => {
      if (!changed) return;
      const current = await readConfig(path);
      if (JSON.stringify(current.rpcLocalTrust) !== JSON.stringify(after)) throw new Error("deploy: trust config changed during activation; refusing to overwrite it");
      if (before === undefined) delete current.rpcLocalTrust;
      else current.rpcLocalTrust = before;
      await atomicWriteFile(path, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
    },
  };
}

export async function verifyQuestionWithdrawal(dataDir: string): Promise<void> {
  const config = await readConfig(join(dataDir, "config.json"));
  const socketPath = typeof config.socketPath === "string" ? config.socketPath : join(dataDir, "hived.sock");
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    const finish = (error?: Error) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error("deploy: withdrawal capability probe timed out")), 3000);
    socket.setEncoding("utf8");
    socket.on("error", finish);
    socket.on("end", () => finish(new Error("deploy: withdrawal capability probe disconnected")));
    socket.on("data", chunk => {
      buffer += chunk;
      if (buffer.length > 65536) return finish(new Error("deploy: invalid daemon hello"));
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const hello = JSON.parse(buffer.slice(0, newline));
        if (hello.protocol !== "v2/1" || !Array.isArray(hello.capabilities) || !hello.capabilities.includes("question.withdraw.v1")) {
          throw new Error("deploy: question.withdraw.v1 unavailable after approved provisioning");
        }
        finish();
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
  });
}
