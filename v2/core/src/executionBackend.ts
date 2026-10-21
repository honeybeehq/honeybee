export type ExecutionBackend = "cli" | "champion_sdk";
export class ExecutionBackendRefusal extends Error {
  readonly code = "champion_sdk_refused";
}
export function executionBackendOf(bee: { tags?: readonly string[] } | null | undefined): ExecutionBackend {
  const selectors = (bee?.tags ?? []).filter(tag => tag.startsWith("execution_backend="));
  if (selectors.length === 0) return "cli";
  if (selectors.length !== 1) throw new ExecutionBackendRefusal("Conflicting execution backend tags");
  switch (selectors[0]) {
    case "execution_backend=cli": return "cli";
    case "execution_backend=champion_sdk": return "champion_sdk";
    default: throw new ExecutionBackendRefusal("Unknown execution backend tag");
  }
}
