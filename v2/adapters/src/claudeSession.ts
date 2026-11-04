export class ClaudeSessionIdError extends Error {
  readonly code = "invalid_session_id";
  constructor() {
    super("Claude session identifier is invalid; restore a valid conversation identifier before resuming");
    this.name = "ClaudeSessionIdError";
  }
}

export function assertClaudeSessionId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new ClaudeSessionIdError();
}
