import { CredentialAuthorityError } from "../claudeCredentialAuthority.ts";
import { join } from "node:path";
import { parseMuseCredentials, recipeFor, type IdentityRecipe, type LoginFieldDescriptor, type LoginFlowRow } from "../../../core/src/index.ts";
import { primaryCredentialFile } from "../activation.ts";
import { STATIC_DETAIL, err, safeMessage, writePrivateRaw } from "./common.ts";
import type { LoginRunner, LoginRunnerHost } from "./runner.ts";
import type { MuseDevicePoll } from "./transports.ts";

const SLOW_DOWN_STEP_MS = 5_000;
const MAX_TRANSIENT_BACKOFF_MS = 60_000;
const MAX_HARD_ERRORS = 3;

export function museOauthDocument(grant: Extract<MuseDevicePoll, { kind: "granted" }>, nowMs: number): string {
  const meta = {
    mechanism: "oauth",
    access_token: grant.accessToken,
    ...(grant.refreshToken !== null ? { refresh_token: grant.refreshToken } : {}),
    ...(grant.expiresInSeconds !== null ? { expires_at: Math.floor(nowMs / 1000) + grant.expiresInSeconds } : {}),
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
  private overallDeadline = 0;
  private nextPollAt = 0;
  private polling = false;
  private transientErrors = 0;
  private hardErrors = 0;
  private stopped = false;
  private pendingGrant: { grant: Extract<MuseDevicePoll, { kind: "granted" }>; raw: string } | null = null;

  constructor(host: LoginRunnerHost) {
    this.host = host;
  }

  async start(): Promise<LoginFlowRow> {
    const host = this.host;
    this.overallDeadline = host.flow()?.expiresAt ?? host.now() + host.cfg.accounts.loginTimeoutMs;
    const device = await host.transports.museDeviceAuthorize();
    if (!this.current()) return host.flow() as LoginFlowRow;
    if (!device.ok) {
      const message = device.status === 404
        ? "Meta's sign-in is not available right now. Retry later."
        : `Meta's sign-in could not be started (HTTP ${device.status}).`;
      return host.fail(err("provider_error", message), true);
    }
    const url = host.sanitizeAuthorizationUrl(device.verificationUri, recipeFor("muse")!.loginFlow.authorizationUrl!);
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
        detail: STATIC_DETAIL.device,
        authorizationUrl: url,
        userCode: device.userCode,
        ...(flow && flow.expiresAt > this.deadline ? { expiresAt: this.deadline } : {}),
      },
      "device code issued",
    );
  }

  async submit(_values: Record<string, string>, _fields: readonly LoginFieldDescriptor[]): Promise<LoginFlowRow> {
    return this.host.flow() as LoginFlowRow;
  }

  tick(now: number): void {
    if (!this.stopped && !this.polling && this.pendingGrant && now >= this.nextPollAt) {
      this.polling = true;
      const { grant, raw } = this.pendingGrant;
      this.pendingGrant = null;
      void this.store(grant, raw).catch(error => {
        if (this.current()) this.host.fail(err("capture_failed", `The sign-in could not be saved: ${safeMessage(error)}`), true);
      }).finally(() => { this.polling = false; });
      return;
    }
    if (this.stopped || this.polling || this.deviceCode === null || now < this.nextPollAt) return;
    this.polling = true;
    void this.poll(this.deviceCode)
      .catch((error) => {
        if (this.current()) this.host.fail(err("capture_failed", `The sign-in could not be saved: ${safeMessage(error)}`), true);
      })
      .finally(() => {
        this.polling = false;
      });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.deviceCode = null;
    this.pendingGrant = null;
  }

  workerStatus(): null {
    return null;
  }

  private current(): boolean {
    return !this.stopped && this.host.isCurrent(this) && this.host.stillActive();
  }

  private async poll(deviceCode: string): Promise<void> {
    const host = this.host;
    if (host.now() >= this.deadline) {
      host.fail(err("timeout", "The sign-in code expired before it was approved. Retry to get a fresh code."), true);
      return;
    }
    let result: MuseDevicePoll;
    try {
      result = await host.transports.museDeviceToken(deviceCode);
    } catch (error) {
      if (this.current()) this.transient(`unreachable: ${safeMessage(error)}`);
      return;
    }
    if (!this.current()) return;
    if (result.kind === "unavailable") {
      this.transient(`HTTP ${result.status}`);
      return;
    }
    this.transientErrors = 0;
    if (result.kind !== "unusable" && result.kind !== "refused") this.hardErrors = 0;
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
        if (this.hardError()) host.fail(err("invalid_credential", "Meta approved the sign-in but returned no usable token."), true);
        return;
      case "refused":
        if (this.hardError()) host.fail(err("provider_error", `Meta's sign-in failed (HTTP ${result.status}).`), true);
        return;
      case "granted":
        this.deviceCode = null;
        await this.store(result);
        return;
    }
  }

  private transient(reason: string): void {
    this.transientErrors += 1;
    const backoff = Math.min(this.intervalMs * 2 ** this.transientErrors, MAX_TRANSIENT_BACKOFF_MS);
    this.nextPollAt = this.host.now() + Math.max(backoff, this.intervalMs);
    this.host.log(`account.login.muse_device_retry flow=${this.host.flowId} account=${this.host.account.id} transient=${this.transientErrors} reason=${JSON.stringify(reason)} next_s=${Math.round((this.nextPollAt - this.host.now()) / 1000)}`);
  }

  private hardError(): boolean {
    this.hardErrors += 1;
    if (this.hardErrors >= MAX_HARD_ERRORS) return true;
    this.nextPollAt = this.host.now() + this.intervalMs;
    return false;
  }

  private async store(grant: Extract<MuseDevicePoll, { kind: "granted" }>, approvedRaw?: string): Promise<void> {
    const host = this.host;
    const account = host.account;
    const raw = approvedRaw ?? museOauthDocument(grant, host.now());
    const credential = parseMuseCredentials(raw);
    if (credential?.mechanism !== "oauth") {
      host.fail(err("invalid_credential", "Meta returned an unusable credential."), true);
      return;
    }
    if (approvedRaw && credential.expiresAt !== null && credential.expiresAt <= host.now()) {
      host.fail(err("invalid_credential", "The approved sign-in expired while waiting. Sign in again."), true);
      return;
    }
    const authority = host.accounts.authorityFor(account);
    if (authority?.enabled(account)) {
      try {
        const state = await authority.relogin(account, JSON.parse(raw), null, { allowDifferentAccount: host.replaceAccount(), stillWanted: () => this.current(), nativeRaw: raw });
        host.log(`account.login.captured flow=${host.flowId} account=${account.id} by=muse_oauth central=in_place generation=${state.generation}`);
        if (this.current()) host.succeed();
      } catch (error) {
        if (this.current() && error instanceof CredentialAuthorityError && error.retryAt !== undefined) {
          if (error.retryAt >= this.overallDeadline) {
            host.fail(err("credential_unavailable", `Credential renewal is delayed beyond this sign-in window. Retry after ${new Date(error.retryAt).toISOString()}.`), true);
          } else {
            this.pendingGrant = { grant, raw };
            this.nextPollAt = error.retryAt;
            host.patch({ phase: "validating", expiresAt: this.overallDeadline, detail: "Sign-in approved. Waiting for the account credential renewal window." }, "credential renewal paced");
          }
          return;
        }
        if (this.current()) host.fail(err("credential_unavailable", safeMessage(error)), true);
      }
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
    host.log(`account.login.captured flow=${host.flowId} account=${account.id} by=muse_oauth refresh=${grant.refreshToken !== null} expires_in_s=${grant.expiresInSeconds ?? "none"} store=${vaultOnly ? "vault" : "home+vault"} files=${captured.captured.join(",")}`);
    host.succeed(vaultOnly ? "Signed in. Honeybee keeps this login in its account store and lends it to Linux computers that run Muse." : undefined);
  }
}
