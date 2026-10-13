/**
 * Muse API-key runner. Muse owns its auth.json format (schema version, file
 * lock, other providers), so the key goes through Muse's own non-interactive
 * `muse auth set --provider meta --api-key-stdin` under the account's home
 * env, never through argv or a file Honeybee writes. Muse does not check the
 * key when saving it; it is verified on first use. The key lives in a local
 * variable for one submit and reaches only the child's stdin.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseMuseCredentials, recipeFor, resolveSpawnCommand, type IdentityRecipe, type LoginFieldDescriptor, type LoginFlowRow } from "../../../core/src/index.ts";
import { primaryCredentialFile } from "../activation.ts";
import { workerBaseEnv } from "./cliRunner.ts";
import { STATIC_DETAIL, err } from "./common.ts";
import { plausibleApiKey } from "./directKey.ts";
import type { LoginRunner, LoginRunnerHost } from "./runner.ts";

export const MUSE_AUTH_SET_ARGS = ["auth", "set", "--provider", "meta", "--api-key-stdin"] as const;
const AUTH_SET_TIMEOUT_MS = 30_000;

type AuthSetOutcome = { ok: true } | { ok: false; reason: "exit" | "timeout" | "spawn"; code: number | null };

export class MuseApiKeyRunner implements LoginRunner {
  readonly kind = "direct_key" as const;
  private readonly host: LoginRunnerHost;

  constructor(host: LoginRunnerHost) {
    this.host = host;
  }

  async start(): Promise<LoginFlowRow> {
    return this.host.patch({ phase: "waiting_input", detail: STATIC_DETAIL.input, inputFields: this.host.method.fields.map((f) => ({ ...f })) }, "fields requested");
  }

  async submit(values: Record<string, string>, _fields: readonly LoginFieldDescriptor[]): Promise<LoginFlowRow> {
    const host = this.host;
    const account = host.account;
    const apiKey = (values.apiKey ?? "").trim();
    if (!plausibleApiKey(apiKey)) return host.reask(err("invalid_input", "That does not look like an API key."));
    const recipe = recipeFor("muse") as IdentityRecipe;
    // Node config `agents.muse.login` names the Muse executable (an operator
    // override / the tests' fake CLI); its args stay a prefix of `auth set`.
    const configured = host.cfg.agents[account.harness]?.login;
    const env: Record<string, string> = {
      ...workerBaseEnv(process.env),
      ...(host.cfg.agents[account.harness]?.env ?? {}),
      ...host.accounts.homeEnvOf(account),
      MUSE_NO_AUTO_UPDATE: "1",
    };
    mkdirSync(account.homePath, { recursive: true, mode: 0o700 });
    const { command } = resolveSpawnCommand(configured?.command ?? recipe.login.command, { env });
    const outcome = await runAuthSet(command, [...(configured?.args ?? []), ...MUSE_AUTH_SET_ARGS], account.homePath, env, apiKey);
    if (!outcome.ok) {
      host.log(`account.login.muse_auth_set flow=${host.flowId} account=${account.id} outcome=${outcome.reason} code=${outcome.code ?? "-"}`);
      return host.fail(err("cli_failed", outcome.reason === "timeout" ? "Muse did not finish saving the key." : "Muse could not save the key."), true);
    }
    if (!host.stillActive()) return host.flow() as LoginFlowRow;
    const primary = primaryCredentialFile(recipe);
    let raw: string;
    try {
      raw = readFileSync(join(account.homePath, primary), "utf8");
    } catch {
      return host.fail(err("capture_failed", "Muse reported success but wrote no auth file in this account's home."), true);
    }
    if (parseMuseCredentials(raw)?.mechanism !== "api_key") {
      return host.fail(err("capture_failed", "Muse's auth file in this account's home holds no API key."), true);
    }
    const captured = host.accounts.persistCredentialCapture(account, primary, raw, {});
    if (!captured.ok) return host.fail(err("capture_failed", "The credential could not be saved into the account's vault."), true);
    host.log(`account.login.captured flow=${host.flowId} account=${account.id} by=muse_api_key files=${captured.captured.join(",")}`);
    return host.succeed("Saved. Muse checks the key on first use.");
  }

  tick(_now: number): void {}

  async stop(): Promise<void> {}

  workerStatus(): null {
    return null;
  }
}

/** Feed the key to `muse auth set` on stdin; the child's output is discarded, never logged. */
function runAuthSet(command: string, args: string[], cwd: string, env: Record<string, string>, apiKey: string): Promise<AuthSetOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (outcome: AuthSetOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "ignore", "ignore"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle({ ok: false, reason: "timeout", code: null });
    }, AUTH_SET_TIMEOUT_MS);
    child.once("error", () => settle({ ok: false, reason: "spawn", code: null }));
    child.once("exit", (code) => settle(code === 0 ? { ok: true } : { ok: false, reason: "exit", code }));
    child.stdin.once("error", () => {});
    child.stdin.end(`${apiKey}\n`);
  });
}
