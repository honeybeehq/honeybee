import { join } from "node:path";
import { AGY_ADC_FILE, AGY_AUTH_FILE, type AgyAuthDocument, type LoginFieldDescriptor, type LoginFlowRow } from "../../../core/src/index.ts";
import { STATIC_DETAIL, err, writePrivateRaw } from "./common.ts";
import { plausibleApiKey } from "./directKey.ts";
import type { LoginRunner, LoginRunnerHost } from "./runner.ts";

const PROJECT_ID = /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/;
const LOCATION = /^[a-z0-9-]{2,40}$/;
const MAX_KEY_FILE_BYTES = 64 * 1024;

export function serviceAccountKey(raw: string): Record<string, unknown> | null {
  if (raw.length === 0 || raw.length > MAX_KEY_FILE_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const key = value as Record<string, unknown>;
  const text = (name: string) => typeof key[name] === "string" && (key[name] as string).length > 0;
  return key.type === "service_account" && text("client_email") && text("private_key") && text("token_uri") ? key : null;
}

export class AgyKeyRunner implements LoginRunner {
  readonly kind = "direct_key" as const;
  private readonly host: LoginRunnerHost;
  private readonly runner: "agy_api_key" | "agy_agent_platform";

  constructor(host: LoginRunnerHost, runner: "agy_api_key" | "agy_agent_platform") {
    this.host = host;
    this.runner = runner;
  }

  async start(): Promise<LoginFlowRow> {
    return this.host.patch({ phase: "waiting_input", detail: STATIC_DETAIL.input, inputFields: this.host.method.fields.map((f) => ({ ...f })) }, "fields requested");
  }

  async submit(values: Record<string, string>, _fields: readonly LoginFieldDescriptor[]): Promise<LoginFlowRow> {
    return this.runner === "agy_api_key" ? this.completeApiKey(values) : this.completeAgentPlatform(values);
  }

  private async completeApiKey(values: Record<string, string>): Promise<LoginFlowRow> {
    const host = this.host;
    const apiKey = (values.apiKey ?? "").trim();
    if (!plausibleApiKey(apiKey)) return host.reask(err("invalid_input", "That does not look like an API key."));
    const check = await host.transports.geminiKeyCheck(apiKey);
    if (check === "invalid") return host.reask(err("invalid_credential", "Google rejected that Gemini API key."));
    if (check === "unverified") return host.reask(err("network_error", "The Gemini API could not be reached to check the key. Try again."));
    if (!host.stillActive()) return host.flow() as LoginFlowRow;
    return this.save({ method: "gemini-api-key", apiKey }, "agy_api_key");
  }

  private async completeAgentPlatform(values: Record<string, string>): Promise<LoginFlowRow> {
    const host = this.host;
    const project = (values.project ?? "").trim();
    const location = (values.location ?? "").trim() || "global";
    if (!PROJECT_ID.test(project)) return host.reask(err("invalid_input", "Enter the Google Cloud project ID (lowercase letters, digits and hyphens)."));
    if (!LOCATION.test(location)) return host.reask(err("invalid_input", "Enter a location such as global or us-central1."));
    const key = serviceAccountKey((values.credentials ?? "").trim());
    if (!key) return host.reask(err("invalid_input", "Paste a service account key file (JSON with type service_account)."));
    if (!host.stillActive()) return host.flow() as LoginFlowRow;
    writePrivateRaw(join(host.account.homePath, AGY_ADC_FILE), `${JSON.stringify(key, null, 2)}\n`);
    return this.save({ method: "agent-platform", project, location }, "agy_agent_platform");
  }

  private save(document: AgyAuthDocument, by: string): LoginFlowRow {
    const host = this.host;
    const account = host.account;
    const raw = `${JSON.stringify(document, null, 2)}\n`;
    writePrivateRaw(join(account.homePath, AGY_AUTH_FILE), raw);
    const captured = host.accounts.persistCredentialCapture(account, AGY_AUTH_FILE, raw, {});
    if (!captured.ok) return host.fail(err("capture_failed", "The credential could not be saved into the account's vault."), true);
    host.log(`account.login.captured flow=${host.flowId} account=${account.id} by=${by} files=${captured.captured.join(",")}`);
    return host.succeed();
  }

  tick(_now: number): void {}

  async stop(): Promise<void> {}

  workerStatus(): null {
    return null;
  }
}
