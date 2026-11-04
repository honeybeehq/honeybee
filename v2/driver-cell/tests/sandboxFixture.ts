import { after } from "node:test";
import { createServer } from "node:net";
import { rmSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { SandboxPolicy } from "../src/sandbox.ts";

const root = mkdtempSync("/tmp/hb-cell-gateway-fixture-");
export const fixtureGatewaySocket = join(root, "gateway.sock");
const server = createServer(socket => socket.destroy());
await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(fixtureGatewaySocket, resolve); });
server.unref();
after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  try { rmSync(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 50}); } catch (error) { console.error("owned fixture cleanup failed", error); process.exitCode = 1; }
});
export const withFixtureGateway = (policy: SandboxPolicy): SandboxPolicy => ({ ...policy, gatewaySocketPath: policy.gatewaySocketPath ?? fixtureGatewaySocket });
