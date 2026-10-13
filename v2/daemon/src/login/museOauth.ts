/**
 * Muse OAuth runner — the device-code sign-in the Muse CLI itself performs
 * (`muse login`), run inside the daemon against Meta's OIDC device endpoints
 * with the CLI's public client: no muse process is started. The operator
 * opens the verification page anywhere and approves; the daemon polls the
 * token endpoint (honouring `interval` and `slow_down`), then stores the
 * grant as the CLI's own `muse/auth.json` (0600).
 *
 * Where the node can run Muse under an account home, the file lands in the
 * home (Muse reads and refreshes it there) and is captured into the vault.
 * Where the recipe's `unisolatedOn` refuses Muse (macOS: one Keychain login
 * per OS user, and Muse moves any file token it reads into it), the file is
 * kept in the account vault only, and the node leases it to nodes that run
 * Muse.
 *
 * The device code and tokens live in this object and the written file only;
 * they are never logged or put on the flow row.
 */
import { join } from "node:path";
import { parseMuseCredentials, recipeFor, safeAuthorizationUrl, type IdentityRecipe, type LoginFieldDescriptor, type LoginFlowRow } from "../../../core/src/index.ts";
import { primaryCredentialFile } from "../activation.ts";
import { STATIC_DETAIL, err, safeMessage, writePrivateRaw } from "./common.ts";
import type { LoginRunner, LoginRunnerHost } from "./runner.ts";
import type { MuseDevicePoll } from "./transports.ts";

/** RFC 8628 §3.5: each `slow_down` adds five seconds to the polling interval. */
const SLOW_DOWN_STEP_MS = 5_000;

/** The Muse CLI's auth.json for an OAuth device-code grant (Linux file format, `expires_at` in epoch seconds). */
export function museOauthDocument(grant: Extract<MuseDevicePoll, { kind: "granted" }>, nowMs: number): string {
  const meta = {
    mechanism: "oauth",
    access_token: grant.accessToken,
    ...(grant.refreshToken !== null ? { refresh_token: grant.refreshToken } : {}),
    expires_at: Math.floor(nowMs / 1000) + grant.expiresInSeconds,
    obtained_via: "device_code",
  };
  return `${JSON.stringify({ schema_version: 1, providers: { meta } }, null, 2)}\n`;
}

export class MuseOauthRunner implements LoginRunner {
  readonly kind = "muse_oauth" as const;
  private readonly host: LoginRunnerHost;
  private deviceCode: string | null = null;
  private intervalMs = 0;
  private deadline = 0;
  private nextPollAt = 0;
  private polling = false;
  private stopped = false;

  constructor(host: LoginRunnerHost) {
    this.host = host;
  }

  async start(): Promise<LoginFlowRow> {
    const host = this.host;
    const device = await host.transports.museDeviceAuthorize();
    if (!this.current()) return host.flow() as LoginFlowRow;
    if (!device.ok) {
      const message = device.status === 404
        ? "Meta's sign-in is not available right now. Retry later."
        : `Meta's sign-in could not be started (HTTP ${device.status}).`;
      return host.fail(err("provider_error", message), true);
    }
    const url = safeAuthorizationUrl(device.verificationUriComplete ?? device.verificationUri);
    if (!url) return host.fail(err("provider_error", "Meta's sign-in returned an unusable sign-in page address."), true);
    const now = host.now();
    this.deviceCode = device.deviceCode;
    this.intervalMs = device.intervalSeconds * 1000;
    this.deadline = now + device.expiresInSeconds * 1000;
    this.nextPollAt = now + this.intervalMs;
    const flow = host.flow();
    host.log(`account.login.muse_device flow=${host.flowId} account=${host.account.id} interval_s=${device.intervalSeconds} lifetime_s=${device.expiresInSeconds}`);
    return host.patch(
      {
        phase: "waiting_device",
        detail: device.verificationUriComplete ? STATIC_DETAIL.deviceConfirm : STATIC_DETAIL.device,
        authorizationUrl: url,
        userCode: device.userCode,
        // The flow ends when the code does (the service's tick expires it).
        ...(flow && flow.expiresAt > this.deadline ? { expiresAt: this.deadline } : {}),
      },
      "device code issued",
    );
  }

  async submit(_values: Record<string, string>, _fields: readonly LoginFieldDescriptor[]): Promise<LoginFlowRow> {
    // The method requests no input; the service refuses submits without requested fields.
    return this.host.flow() as LoginFlowRow;
  }

  tick(now: number): void {
    if (this.stopped || this.polling || this.deviceCode === null || now < this.nextPollAt) return;
    this.polling = true;
    void this.poll(this.deviceCode)
      .catch((error) => {
        if (this.current()) this.host.fail(err("network_error", `Meta's sign-in could not be reached: ${safeMessage(error)}`), true);
      })
      .finally(() => {
        this.polling = false;
      });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.deviceCode = null;
  }

  workerStatus(): null {
    return null;
  }

  /** Still the flow's live runner: not stopped, not superseded, flow not terminal. */
  private current(): boolean {
    return !this.stopped && this.host.isCurrent(this) && this.host.stillActive();
  }

  private async poll(deviceCode: string): Promise<void> {
    const host = this.host;
    if (host.now() >= this.deadline) {
      host.fail(err("timeout", "The sign-in code expired before it was approved. Retry to get a fresh code."), true);
      return;
    }
    const result = await host.transports.museDeviceToken(deviceCode);
    if (!this.current()) return;
    switch (result.kind) {
      case "pending":
        this.nextPollAt = host.now() + this.intervalMs;
        return;
      case "slow_down":
        this.intervalMs += SLOW_DOWN_STEP_MS;
        this.nextPollAt = host.now() + this.intervalMs;
        return;
      case "denied":
        host.fail(err("provider_error", "The sign-in was declined on Meta's page."), true);
        return;
      case "expired":
        host.fail(err("timeout", "The sign-in code expired before it was approved. Retry to get a fresh code."), true);
        return;
      case "unusable":
        host.fail(err("invalid_credential", "Meta approved the sign-in but returned no usable token."), true);
        return;
      case "refused":
        host.fail(err("provider_error", `Meta's sign-in failed (HTTP ${result.status}).`), true);
        return;
      case "granted":
        this.deviceCode = null;
        this.store(result);
        return;
    }
  }

  private store(grant: Extract<MuseDevicePoll, { kind: "granted" }>): void {
    const host = this.host;
    const account = host.account;
    const raw = museOauthDocument(grant, host.now());
    if (parseMuseCredentials(raw)?.mechanism !== "oauth") {
      host.fail(err("invalid_credential", "Meta returned an unusable credential."), true);
      return;
    }
    const primary = primaryCredentialFile(recipeFor("muse") as IdentityRecipe);
    const vaultOnly = host.accounts.isolationRefusal(account.harness) !== null;
    if (!vaultOnly) writePrivateRaw(join(account.homePath, primary), raw);
    const captured = host.accounts.persistCredentialCapture(account, primary, raw, { [primary]: raw });
    if (!captured.ok) {
      host.fail(err("capture_failed", "The credential could not be saved into the account's vault."), true);
      return;
    }
    host.log(`account.login.captured flow=${host.flowId} account=${account.id} by=muse_oauth refresh=${grant.refreshToken !== null} store=${vaultOnly ? "vault" : "home+vault"} files=${captured.captured.join(",")}`);
    host.succeed(vaultOnly ? "Signed in. Honeybee keeps this login in its account store and lends it to Linux computers that run Muse." : undefined);
  }
}
