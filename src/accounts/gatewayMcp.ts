/** Legacy discovery adapter for the shared native MCP config writer. */
import { gatewaysAreDisabled, liveGateways, type GatewayRecord } from "../gateways.js";
import { nativeGatewayHome, seedGatewayMcp as reconcileGatewayMcp, type GatewayMcpSeedResult } from "./gatewayMcpSeed.ts";
export { nativeGatewayHome };
export type { GatewayMcpSeedResult, GatewayMcpStamp } from "./gatewayMcpSeed.ts";

export type SeedGatewayMcpOptions = {
  gateways?: GatewayRecord[];
  failOnError?: boolean;
};

export function seedGatewayMcp(homePath: string, harness: string, options: SeedGatewayMcpOptions = {}): Promise<GatewayMcpSeedResult> {
  return reconcileGatewayMcp(homePath, harness, {
    gateways: options.gateways ?? liveGateways(),
    disabled: options.gateways === undefined && gatewaysAreDisabled(),
    failOnError: options.failOnError,
  });
}

export async function seedGatewayMcpForAgent(harness: string, homePath?: string, options: SeedGatewayMcpOptions = {}): Promise<GatewayMcpSeedResult> {
  const home = homePath ?? nativeGatewayHome(harness);
  if (!home) return { status: "skipped", reason: `no gateway MCP home for ${harness}`, written: [] };
  return seedGatewayMcp(home, harness, options);
}
