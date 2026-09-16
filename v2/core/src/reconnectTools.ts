import type { CommandRow } from "./types.ts";

export interface ReconnectToolsReceipt {
  outcome: "reloaded" | "stale_generation";
  threadId: string | null;
  targets: string[];
  /** Reload installs the new configuration at the next normal turn boundary. */
  modelTools: "refresh_pending_next_turn" | "not_refreshed";
}

export interface ReconnectToolsError { code: string; message: string }

export interface ReconnectToolsResult {
  commandId: number;
  beeId: string;
  generation: number;
  state: CommandRow["status"];
  receipt: ReconnectToolsReceipt | null;
  error: ReconnectToolsError | null;
}

export function reconnectToolsResult(command: CommandRow): ReconnectToolsResult {
  const result = command.args.reconnectResult as Pick<ReconnectToolsResult, "receipt" | "error"> | undefined;
  return {
    commandId: command.id, beeId: command.beeId, generation: command.targetGeneration!,
    state: command.status, receipt: result?.receipt ?? null, error: result?.error ?? null,
  };
}
