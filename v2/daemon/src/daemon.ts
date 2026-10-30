import { assertConfinedSpawn, ConfinedAdmission, assertConfinedVerb, bwrapMode, peerConfinement, runtimeUserNamespace, strictConfinementReasons } from "./confinedPeer.ts";
import { admitSecretExecution } from "./secretExecution.ts";
import type { BeeTellParams, BeeReactParams, HumanOutputMode, BeeTellResult, BeeReactResult, SetHumanOutputModeResult } from "../../core/src/humanOutputTypes.ts";
import type { AutomationKind, HumanChatAdmission } from "../../core/src/types.ts";
import { isQuotaTextFallback } from "../../adapters/src/quota.ts";
import { isFableModel, autoswapDisabled } from "../../core/src/index.ts";
export { autoswapDisabled } from "../../core/src/index.ts";
import {IdentityRecovery} from "./identityRecovery.ts";
import {inspectProcess, sameProcess, type ProcessInspection} from "../../harness/src/processIdentity.ts";
import { bindSpawnParent, spawnCallerBee } from "./spawnLineage.ts";
import type { ExecutionStart } from "../../core/src/executionStart.ts";
import { ExecutionFenceError, type ExecutionRequest } from "../../core/src/executionFence.ts";
import { type PhoneOriginRequest, parsePhoneOrigin } from "../../core/src/phoneOrigin.ts";
const AUTOMATION_REFERENCE = Symbol("automationReference");
const PHONE_CONTEXT = Symbol("phoneOrigin");
const PHONE_LANE = Symbol("phoneLane");
const PHONE_DIGEST = Symbol("phoneDigest");
const PHONE_CARRIER_DIGEST = Symbol("phoneCarrierDigest");
import { knownAccountLease } from "../../core/src/accountLease.ts";
import { effectVerb } from "../../core/src/effectResolve.ts";
import { APIARY_SWAP_CAPABILITY, ApiarySwapError, parseApiarySwapAcquire, parseApiarySwapSettle, parseApiarySwapRecover } from "../../../src/apiarySwap.ts";
import { canonicalDigest } from "../../../src/comb/canonical.ts";
import { parseComponentIdentity, type ComponentIdentity } from "../../../src/release/index.ts";
import { withoutRpcCaller } from "../../core/src/rpcAuditContext.ts";
import { applyObservation, observationReadRequest, discardObservation } from "./limitsObservation.ts";
import { reconnectToolsResult, type ReconnectToolsResult } from "../../core/src/reconnectTools.ts";
import { withFileLock } from "../../../src/lock.ts";
import { readBuildIdentity } from "../../../src/release/buildIdentity.ts";
import { installedV2Identity } from "../../../src/cliRoute.ts";
import { SCHEMA_VERSION } from "../../core/src/schema.ts";
import { ThreadOperations } from "./threadOperations.ts";
import { carryCodexHistory, codexSwapHistoryPath, validateCodexSwapPath } from "./codexSwapHistory.ts";
import { codexHistoryPath, pinThreadHistory, readThreadHistory } from "./threadHistory.ts";
import { threadOperationView, type ThreadOperationRow } from "../../core/src/threadOperation.ts";
/**
 * HiveDaemon — the real v2 daemon (spec 04). Hosts the WP1 store (sole
 * writer), the WP3 HsrDriver + adapters, and the DaemonCore loops over wall
 * time; serves every client through the RPC surface (rpc.ts / protocol.ts).
 *
 * Spec mapping:
 *  - behavior 1 (loops)            → DaemonCore.step() on a yielding tick loop
 *  - behavior 2 (boot sequence)    → start(): open store (boot replay) →
 *    adoptSurvivors() (pid + start-time re-adoption from the STORE's recorded
 *    identities) → DaemonCore.boot() (snapshotLive → reconcileAtBoot → orphan
 *    reap → wake sweep). Zero failed states minted (B7).
 *  - behavior 3 (scale-to-zero)    → policy.idleWindowSteps from config
 *  - behavior 4 (flag policy)      → DaemonCore.applyEvidence (spec 03 rules)
 *  - behavior 5 (I1 telemetry)     → onI1Violation → i1_violations table +
 *    ledger-shaped log line; deadline floor-clamped policy-aware (config.ts)
 *  - behavior 6 (service mgmt)     → service.ts (wired by the CLI)
 *  - behavior 7 (config)           → config.ts
 */
import { closeSync, copyFileSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, rmSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import type { InterruptOutcome } from "../../harness/src/driver.ts";
import { appendFileSync } from "node:fs";
import { homedir, tmpdir, hostname } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { canonicalPath, removeEndpointRecord, samePath, writeEndpointRecord } from "./endpointRecord.ts";
import { placeDaemonSockets } from "./socketPath.ts";
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import { getSystemErrorMap } from "node:util";
import { GatewayMcpSeedLockError } from "../../../src/accounts/gatewayMcpSeed.ts";
import {
  accountIdFor,
  isAccountId,
  matchAccount,
  homeEnvFor,
  exportTemplate,
  importFromFrozen,
  importLocalConfig,
  importTemplate,
  beeTaskList,
  isTaskStatus,
  isTaskTransitionAction,
  MAIL_HISTORY_MAX_LIMIT,
  MESSAGE_URGENCIES,
  SENDER_KINDS,
  INBOX_AGENT,
  isInboxAgent,
  filterMailbox,
  ContinuationUnsupportedError,
  MOVE_CONTINUATION_AGENTS,
  BEE_HANDOFF_STOP_AT,
  HANDOFF_TRANSCRIPT_TAIL_BYTES,
  composeDeveloperInstructions,
  hashBeeHandoffRequest,
  hashBeeMoveRequest,
  segmentSessionLogPath,
  hashCellOpRequest,
  openCoreStore,
  placementContextText,
  toBeeHandoffView,
  toBeeMoveView,
  ACTION_STATUSES,
  BUILTIN_ACTION_DEFINITIONS,
  emptyActionCounts,
  hashActionEnqueueRequest,
  toActionQueueView,
  deriveActionControls,
  toActionView,
  type ActionQueueView,
  type ActionStatus,
  recipeFor,
  requireBeeId,
  resolveExecutable,
  resolveSpawnCommand,
  TASK_TRANSITION_ACTIONS,
  serializePackage,
  type AccountPause,
  type AccountRow,
  type AuthRestoreSource,
  AUTH_INTERRUPTION_RETENTION_MS,
  type AuditRow,
  type BeeHandoffRow,
  type BeeHandoffStopAt,
  type BeeMoveRow,
  type BeeRow,
  type MessageRow,
  type HandoffContext,
  type HandoffContextTurn,
  type TranscriptSegmentRow,
  type CellOpRow,
  type CellRow,
  type CommandRow,
  type CoreStore,
  type MirrorAccountRow,
  pauseLabel,
  publicAuditRow,
  mirrorBeeRow,
  toPublicBee,
  operatorLocalBee,
  publicBeeResult,
  type RowSource,
  type Scope,
  type Urgency,
  type SenderKind,
} from "../../core/src/index.ts";
import {
  AccountsService,
  ResetLimitsRefusal,
  LeaseRefusal,
  type AccountsServiceOptions,
  type AccountAdmissionClaim,
  type AccountReadiness,
  type AccountAllocationAuthority,
  type AccountAllocationContext,
  type AccountAllocationReceipt,
  type CaptureOutcome,
  type LimitsFetchers,
  describeWeeklyCeilingBreach,
} from "./accountsService.ts";
import { AccountConfigImportRefusal, AccountConfigImportService } from "./accountConfigImport.ts";
import { dirHasCredentials } from "./activation.ts";
import { LoginFlowService, type LoginTransports } from "./loginFlows.ts";
import type { PtySpawner } from "./loginWorker.ts";
import type { KeychainReader, KeychainWriter } from "./keychain.ts";
import type { CellCaptureExecutor, FlagEvidenceLike, UsageEvidenceLike } from "./loops.ts";
import { CellRetentionService } from "./cellRetention.ts";
import { CredentialAuthorityError, credentialErrorDetails } from "./claudeCredentialAuthority.ts";
import { realPreflightProbes } from "./import-probes.ts";
import { HsrDriver, pidAlive, verifyProcessIdentity, type SpawnSpec } from "../../driver-hsr/src/index.ts";
import {
  darwinUserTempDir,
  CellDeleteRefused,
  CellDriver,
  CellHeadMovedError,
  CellRuntimeLiveError,
  cellPaths,
  deleteCell,
  dirtyCauses,
  evictCellWrapper,
  unparkCellWrapper,
  readUpstreamMirror,
  upstreamRootFor,
  hasCommit,
  restoreEnvFiles,
  restoreKeptPaths,
  localRepoIdentity,
  parseSpaceName,
  readLedger,
  reserveCell,
  revParse,
  resolveCellBase,
  DEFAULT_UPSTREAM_REFRESH,
  type CellBase,
  isAncestor,
  currentBranch,
  sandboxWritableDirectory,
  sandboxEnabled,
  DEFAULT_SANDBOX_TMPFS_BYTES,
  runCellExec,
  sanitizeComponent,
  type CellSpec,
  type ReserveRequest,
  type SandboxWritableDirectory,
} from "../../driver-cell/src/index.ts";
import { deliveryContentRoot } from "./multilineFallback.ts";
import { DeliveryFiles } from "./deliveryFile.ts";
import {
  relocateClaudeSession,
  TranscriptConflictError,
  TranscriptUnavailableError,
} from "./relocateSession.ts";
import { SubstrateRouter } from "./substrates.ts";
import { REMOTE_SENDER_RE, isPeerSender } from "./envelope.ts";
import { TmuxDriver, claudeProjectKey, renderTranscriptLines } from "../../driver-tmux/src/index.ts";
import { tmuxSpawnSpec } from "./tmuxHarness.ts";
import {
  agyAdapter,
  agyArgGrammar,
  claudeAdapter,
  claudeArgGrammar,
  codexAdapter,
  codexArgGrammar,
  grokAdapter,
  kimiAdapter,
  kimiSpawnPlan,
  museAdapter,
  museArgGrammar,
  museSpawnPlan,
  grokArgGrammar,
  grokSpawnPlan,
  codexSpawnPlan,
  composeArgv,
  stubAdapter,
  type ArgGrammar,
  type HarnessAdapter,
  type GrokMcpServerStdio,
} from "../../adapters/src/index.ts";
import { liveGateways, type LiveGateway } from "./gateways.ts";
import { DaemonCore, type BootReport, type I1ViolationEvent } from "./loops.ts";
import { QuotaRecovery } from "./quotaRecovery.ts";
import { AuthResume, type CredentialValidatedReceipt } from "./authResume.ts";
import {
  ConfigError,
  loadNodeConfig,
  patchNamingConfig,
  publicNamingConfig,
  validateNodeStatePaths,
  type AgentSpecConfig,
  type NamingConfig,
  type ResolvedNamingConfig,
  type ResolvedNodeConfig,
} from "./config.ts";
import {
  argValue,
  claudeContextLaunch,
  claudeHomeModel,
  claudeLaunchFacts,
  NO_LAUNCH_FACTS,
  contextPolicyFacts,
  contextPolicyOf,
  ContextPolicyError,
  CONTEXT_ROLES,
  effectiveContextPolicy,
  isContextRole,
  roleContextPolicy,
  roleOfTags,
  ROLE_TAG_PREFIX,
  sameContextPolicy,
  storedContextPolicy,
  validWorkspaceId,
  workspaceOfTags,
  writeContextPolicy,
  type ClaudeContextLaunch,
  type ContextPolicy,
  type ContextPolicyConfig,
  type ContextPolicyScope,
  type ContextRole,
} from "./contextPolicy.ts";
import { createStoreAutoTitleDispatcher, type AutoTitleOutcome } from "./autoTitle.ts";
import { TitleGeneratorService } from "./namingService.ts";
import { TelemetryStore, formatI1Violation } from "./telemetry.ts";
import {
  createPerformanceProfiler,
  type PerformanceProfiler,
  type PerformanceSpan,
} from "./performance.ts";
import { RpcServer, assertAutomationSend, assertLocalHandoffRpc, type RpcConn } from "./rpc.ts";
import { applyDaemonTmpPolicy, beeTmpPaths, describeBeeTmpPolicy, ensureBeeTmpEnv, removeBeeTmpDir, resolveBeeTmpPolicy, sweepBeeTmpDirs, type BeeTmpPolicy } from "./beeTmp.ts";
import {
  DAEMON_VERSION,
  BUILD_IDENTITY,
  UPDATE_RECOVERY_CONTRACT,
  PROTOCOL,
  RpcError,
  SPAWN_SUBSTRATES,
  type AccountAddResult,
  type AccountConfigImportResult,
  type AccountConfigPreviewResult,
  type AccountBackfillResult,
  type AccountLeaseResult,
  type AccountLeaseInstallParams,
  type AccountLeaseInstallResult,
  type AccountAdmissionAcquireResult,
  type AccountAdmissionConfirmResult,
  type AccountAdmissionReleaseResult,
  type AccountActivityResult,
  type AccountCaptureResult,
  type AccountCredentialsRestoredResult,
  type AccountInterruptionsResult,
  type AccountLoginCancelResult,
  type AccountLoginGetResult,
  type AccountLoginRetryResult,
  type AccountLoginSelectMethodResult,
  type AccountLoginStartResult,
  type AccountLoginSubmitResult,
  DAEMON_CAPABILITIES,
  type AccountGetResult,
  type AccountImportRegistryResult,
  type AccountLimitsResult,
  type AccountResetLimitsResult,
  type AccountListResult,
  type AccountRemoveResult,
  type AccountUpdateResult,
  type AccountVerifyResult,
  type AuditTailResult,
  type SwapAccountResult,
  type BeeMoveResult,
  type BeeHandoffResult,
  type BeeHandoffGetResult,
  type ActionCancelResult,
  type ActionClaimResult,
  type ActionDefinitionsResult,
  type ActionEnqueueResult,
  type ActionGetResult,
  type ActionListResult,
  type ActionQueueControlResult,
  type ActionQueueGetResult,
  type ActionReorderResult,
  type ActionReportOutcome,
  type ActionReportResult,
  type ActionRetryResult,
  type ActionCompleteResult,
  type CellCaptureMode,
  type CellCaptureResult,
  type CellEvictResult,
  type CellParkResult,
  type CellExecResult,
  type CellGcResult,
  type CellRemoveResult,
  type CellRetainedRemoveResult,
  type ChildrenResult,
  type ConfigGetResult,
  type ConfigPatchResult,
  type ContextPolicyResult,
  type ContextPolicySetResult,
  type DeployInfoResult,
  type ForkResult,
  type HarnessFact,
  type HealthResult,
  type InterruptResult,
  type NodeHarnessesResult,
  type ListResult,
  type MailHistoryParams,
  type MailHistoryResult,
  type MailPendingResult,
  type MutationResult,
  type QuestionAnswerResult,
  type QuestionAskResult,
  type QuestionWithdrawResult,
  type QuestionDismissResult,
  type QuestionListResult,
  type RenameResult,
  type RpcVerb,
  type SealCreateResult,
  type SealGetResult,
  type SealListResult,
  type TaskAddResult,
  type TaskClaimResult,
  type TaskEditResult,
  type TaskGetResult,
  type TaskListResult,
  type TaskListsResult,
  type TaskMoveResult,
  type TaskSupplyGetResult,
  type TaskSupplySetResult,
  type TaskTransitionResult,
  type SetArgsResult,
  type TagResult,
  type ImportFromFrozenResult,
  type ImportLocalConfigResult,
  type SendRpcResult,
  type SnapshotResult,
  type SpawnCellParams,
  type SpawnResult,
  type SpawnSubstrate,
  type TemplateDeleteResult,
  type TemplateExportResult,
  type TemplateGetResult,
  type TemplateImportResult,
  type TemplateListResult,
  type TemplatePutResult,
  type ViewResult,
} from "./protocol.ts";

const ADAPTER_NAMES = ["agy", "claude", "codex", "grok", "kimi", "muse", "stub"] as const;

const FOREIGN_GUARDED_VERBS = new Set<RpcVerb>([
  "spawn", "revive", "bee.fork", "bee.reconfigure", "bee.move", "bee.handoff", "bee.swapAccount",
  "thread.fork", "thread.handoff", "thread.operation.retry",
  "account.login", "account.login.start", "account.login.retry", "account.verify", "account.capture",
]);

/**
 * Adapter for a bee. `providerSessionId` (bee row, spec 07 §F) selects the
 * harness-native resume path: claude via argv (`resumeArgs`, applied by
 * resolveSpawnSpec), codex via its handshake (`thread/resume`). The stub has
 * no resume path — a revived stub restarts fresh, like any harness without one.
 * `model` (codex only) is the `-m/--model` lifted off the composed argv into
 * the thread request — the app-server ignores TUI flags. `forkSeed` (v6, a
 * fork's first runtime, no session of its own yet) selects the fork path
 * instead: codex `thread/fork {threadId: seed}`; claude via `forkArgs`.
 */
function adapterFor(
  name: string,
  cwd: string,
  providerSessionId: string | null,
  model?: string,
  forkSeed?: string | null,
  grokMcpServers: readonly GrokMcpServerStdio[] = [],
  placementInstruction?: string | null,
): HarnessAdapter | null {
  switch (name) {
    case "agy":
      return agyAdapter;
    case "claude":
      return claudeAdapter;
    case "codex": {
      const developerInstructions = composeDeveloperInstructions(null, placementInstruction);
      return codexAdapter({
        cwd,
        ...(providerSessionId ? { resumeThreadId: providerSessionId } : forkSeed ? { forkThreadId: forkSeed } : {}),
        ...(model ? { model } : {}),
        ...(developerInstructions ? { developerInstructions } : {}),
      });
    }
    case "grok":
      return grokAdapter({
        cwd,
        mcpServers: grokMcpServers,
        ...(providerSessionId ? { resumeSessionId: providerSessionId } : {}),
      });
    case "stub":
      return stubAdapter;
    case "kimi":
      return kimiAdapter({ cwd, mcpServers: grokMcpServers, ...(providerSessionId ? { resumeSessionId: providerSessionId } : {}) });
    case "muse":
      return museAdapter({ cwd, mcpServers: grokMcpServers, ...(providerSessionId ? { resumeSessionId: providerSessionId } : {}) });
    default:
      return null;
  }
}

/** The argv grammar an adapter's CLI speaks (unknown adapters: no de-dup, verbatim concat). */
const NO_GRAMMAR: ArgGrammar = { valueFlags: new Set(), booleanFlags: new Set(), keyedFlags: new Set(), aliases: {} };
function grammarFor(adapterName: string): ArgGrammar {
  switch (adapterName) {
    case "agy":
      return agyArgGrammar;
    case "claude":
      return claudeArgGrammar;
    case "codex":
      return codexArgGrammar;
    case "grok":
      return grokArgGrammar;
    case "muse":
      return museArgGrammar;
    default:
      return NO_GRAMMAR;
  }
}

/**
 * The composed argv + adapter for a bee's next runtime — pure, exported for
 * tests. Precedence (adapters/args.ts): spec.args (harness plumbing) <
 * spec.defaultArgs (node per-agent defaults) < bee.args (per bee, schema v5)
 * < resume args (`--resume <id>`, claude). Repeated valued flags: later wins;
 * boolean flags idempotent; unknown tokens/positionals verbatim in place.
 * codex: `-m/--model` and the approval/sandbox flags are lifted off argv into
 * the thread request (the app-server ignores TUI flags); `-c k=v` stays.
 */
const APIARY_TAG_PREFIX = "apiary:";

function withoutRoleTags(tags: readonly string[]): string[] {
  return tags.filter((tag) => !tag.startsWith(ROLE_TAG_PREFIX));
}

export function composeSpawn(
  spec: AgentSpecConfig,
  adapterName: string,
  bee: { cwd: string; args: string[] | null; providerSessionId: string | null; forkSeed?: string | null },
  grokMcpServers: readonly GrokMcpServerStdio[] = [],
  placementInstruction?: string | null,
): { adapter: HarnessAdapter | null; args: string[]; model: string | undefined } {
  const grammar = grammarFor(adapterName);
  // v6 fork: a fork with no session of its own yet forks the SOURCE's
  // conversation (`--resume <seed> --fork-session` / thread/fork) into a new
  // one; once its own id is recorded the seed is consumed and plain resume
  // takes over. A recorded session always wins over a stale seed.
  const forkSeed = bee.providerSessionId ? null : (bee.forkSeed ?? null);
  const base = adapterFor(adapterName, bee.cwd, bee.providerSessionId, undefined, forkSeed, grokMcpServers);
  const resume = bee.providerSessionId && base?.resumeArgs
    ? base.resumeArgs(bee.providerSessionId)
    : forkSeed && base?.forkArgs
      ? base.forkArgs(forkSeed)
      : [];
  const startup = adapterName === "claude" && placementInstruction
    ? ["--append-system-prompt", placementInstruction]
    : [];
  const composed = composeArgv(grammar, [spec.args, spec.defaultArgs, bee.args, resume, startup]);
  if (adapterName === "kimi") {
    const plan = kimiSpawnPlan(composed);
    return {
      adapter: kimiAdapter({ cwd: bee.cwd, model: plan.model, mode: plan.mode, mcpServers: grokMcpServers,
        ...(bee.providerSessionId ? { resumeSessionId: bee.providerSessionId } : {}) }),
      args: plan.argv, model: plan.model,
    };
  }
  if (adapterName === "muse") {
    const plan = museSpawnPlan(composed);
    return {
      adapter: museAdapter({ cwd: bee.cwd, model: plan.model, effort: plan.effort, approvalMode: plan.approvalMode, mcpServers: grokMcpServers,
        ...(bee.providerSessionId ? { resumeSessionId: bee.providerSessionId } : {}) }),
      args: plan.argv, model: plan.model,
    };
  }
  if (adapterName === "codex") {
    const plan = codexSpawnPlan(composed);
    return {
      adapter: adapterFor(adapterName, bee.cwd, bee.providerSessionId, plan.model, forkSeed, grokMcpServers, placementInstruction),
      args: plan.argv,
      model: plan.model,
    };
  }
  if (adapterName === "grok") {
    const plan = grokSpawnPlan(composed);
    return { adapter: adapterFor(adapterName, bee.cwd, bee.providerSessionId, undefined, forkSeed, grokMcpServers), args: plan.argv, model: plan.model };
  }
  return { adapter: base, args: composed, model: undefined };
}

/**
 * v6 — the honeybee-owned identity env every runtime is stamped with, AFTER
 * every other env source (agent spec, per-bee env) so nothing can override
 * it. HIVE_BEE / HIVE_BEE_ID are what agents' skills read (`hive v2 ask`,
 * `hive v2 seal`, `hive v2 spawn` fill their bee/parent from them), while
 * HIVE_V2_DATA_DIR binds those identity stamps to this daemon authority;
 * HIVE_PARENT is set iff the bee was spawned by another bee — the child's
 * "you were spawned by <parent>; report back to it" fact.
 */
export function beeIdentityEnv(
  bee: { id: string; name: string; parentId: string | null },
  dataDir?: string,
  socketPath?: string,
): Record<string, string> {
  return {
    HIVE_BEE: bee.name,
    HIVE_BEE_ID: bee.id,
    ...(dataDir ? { HIVE_V2_DATA_DIR: dataDir } : {}),
    ...(socketPath ? { HIVE_V2_SOCKET_PATH: socketPath } : {}),
    ...(bee.parentId ? { HIVE_PARENT: bee.parentId } : {}),
  };
}

const OP_LOG_TAIL = 40;
/** `account.lease` margin requests above a day are a caller bug: no Claude access token lives that long. */
const MAX_LEASE_MIN_TTL_MS = 24 * 60 * 60_000;
const MIN_TICK_YIELD_MS = 1;
/**
 * Boot observations are polled from runner files at the tick, so a booted
 * runtime waits on average half a cadence to become a fact. While a runtime is
 * booting the loop ticks at this bound instead; boots last a second or two, so
 * the extra ticks are few and the fact lands within the driver's 50 ms pump.
 */
const BOOTING_TICK_MS = 25;
/** How often the tick runs the (synchronous, roster-wide) auto-title scan. */
const AUTO_TITLE_SCAN_MS = 1000;
const WEEKLY_CEILING_SWEEP_MS = 15_000;
const WEEKLY_CEILING_RETRY_MS = 10 * 60_000;

export function weeklyCeilingMoveNote(from: string, to: string, why: string): string {
  return [
    `Hive moved you from account ${from} to ${to}: ${why}.`,
    "Your process restarted, so background shells, monitors and subagents from before the move have stopped.",
    "Restart any you still need and carry on. If nothing was pending, reply \"ok\" and stop.",
  ].join(" ");
}

/**
 * Delay from tick completion, not tick start. A repeating interval can remain
 * perpetually overdue when synchronous tick work exceeds tickMs, starving the
 * RPC accept loop behind back-to-back callbacks. A full completion-relative
 * delay gives pending socket work a real poll window under sustained overload.
 */
export function nextTickDelayMs(tickMs: number): number {
  return Math.max(MIN_TICK_YIELD_MS, tickMs);
}

export interface ShutdownOptions {
  /** Production default: detached runtimes survive for the successor daemon. */
  preserveRuntimes?: boolean;
}

/** v7: injectable transports for in-process tests (the daemon binary uses the defaults). */
export interface HiveDaemonDeps {
  keychainReader?: KeychainReader;
  keychainWriter?: KeychainWriter;
  fetchers?: LimitsFetchers;
  /** v16: login-flow provider transports (token exchange / key checks) and the PTY backend, injectable for tests. */
  loginTransports?: Partial<LoginTransports>;
  loginSpawner?: PtySpawner | null;
  loginTmuxExec?: (args: string[]) => { status: number | null; stdout: string };
  /** Hermetic test seam for account-home native MCP reconciliation. */
  gatewayMcpSeeder?: AccountsServiceOptions["gatewayMcpSeeder"];
  /**
   * v23: optional LLM-backed refinement of the extractive handoff context.
   * Absent = the deterministic extractive artifact is the seed.
   */
  summarizeHandoff?: (input: { handoff: BeeHandoffRow; bee: BeeRow; base: HandoffContext }) => Promise<HandoffContext>;
  /** v31 tests: substitute the retention inspection worker entrypoint. */
  retentionWorkerUrl?: URL;
  /** v31 tests: delay before the first automatic retention pass (default 5 min). */
  retentionInitialDelayMs?: number;
  /** P7 tests: free-space check cadence (default 60 s). */
  retentionDiskCheckMs?: number;
  /** P7 tests: wait after a floor_unmet pass (default 30 min). */
  retentionPressureRetryMs?: number;
  /** P7 tests: substitute the Cells volume measurement. */
  retentionStatfs?: (path: string) => { totalBytes: number; freeBytes: number };
  /**
   * Outbox forwarder hook for mailbox-only bees: called after a `send` to an
   * `inbox` bee commits. A future webhook or email push plugs in here; it runs
   * off the RPC transaction and its failures never affect the accepted mail.
   * See docs/design/mailbox-only-bees.md.
   */
  forwardMailboxOnlyMail?: MailboxOnlyForwarder;
}

export type MailboxOnlyForwarder = (input: { bee: BeeRow; message: MessageRow }) => void | Promise<void>;

type AccountActivationState = {
  key: string;
  status: "pending" | "ready" | "failed";
  task: Promise<void>;
  error?: string;
};


function gatewayActivationRevision(gateways: readonly LiveGateway[]): string {
  const namesOnly = gateways.map((gateway) => ({
    name: gateway.name,
    command: gateway.shim.command,
    args: gateway.shim.args,
    envNames: Object.keys(gateway.env).sort(),
    envVars: gateway.envVars ?? [],
  }));
  return createHash("sha256").update(JSON.stringify(namesOnly)).digest("hex");
}

const SYSTEM_ERROR_CODES = new Set([...getSystemErrorMap().values()].map(([name]) => name));

export function activationFailureName(error: unknown): string {
  if (error instanceof GatewayMcpSeedLockError) return error.diagnostic;
  if (error instanceof RpcError && error.code === "login_method_unsupported") return error.message;
  if (!(error instanceof Error)) return "unknown_error";
  const code = (error as NodeJS.ErrnoException).code;
  // Both name and code are writable strings on arbitrary errors. Only emit
  // known errno values; never copy arbitrary exception text into daemon logs.
  return code && SYSTEM_ERROR_CODES.has(code) ? `Error(${code})` : "Error";
}

/** Rate-limit cause classifier for resource_blocked evidence (spec 08 rotation trigger). */
export function isRateLimitCause(detail: string): boolean {
  return isQuotaTextFallback(detail);
}


function isAccountConfigImportResult(value: unknown): value is AccountConfigImportResult {
  if (value === null || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return typeof result.accountId === "string" &&
    Array.isArray(result.imported) && result.imported.every((path) => typeof path === "string") &&
    Array.isArray(result.skipped) && result.skipped.every((path) => typeof path === "string");
}

/** Verbs whose result `status` is the verb's own report, not a command status (see withIdempotency). */
const OWN_STATUS_VERBS: ReadonlySet<RpcVerb> = new Set<RpcVerb>([
  "cell.capture",
  "cell.remove",
  "cell.evict",
  "cell.park",
  "bee.move",
  "cell.exec",
  "cell.retained.remove",
  "bee.handoff",
]);

export class HiveDaemon {
  cfg: ResolvedNodeConfig;
  private readonly deliveryFiles = new DeliveryFiles();
  private store: CoreStore | null = null;
  private readonly secretExecutions = new Map<string, {beeId: string; cellId: string; nodeId: string; controller: AbortController}>();
  private integrityCheck: Promise<{ ok: boolean; results: string[]; durationMs: number }> | null = null;
  private integrityCheckAt = -Infinity;
  private threadOperations: ThreadOperations | null = null;
  /** The substrate router DaemonCore drives; `.hsr` / `.cell` / `.tmux` are the substrate drivers. */
  private driver: SubstrateRouter | null = null;
  private core: DaemonCore | null = null;
  private telemetry: TelemetryStore | null = null;
  private rpc: RpcServer | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private tickRequested = false;
  /** Event-loop delay histogram: stalls anywhere (tick, RPC handler, fs) starve the accept loop. */
  private loopDelay: IntervalHistogram | null = null;
  private readonly identityRecovery = new IdentityRecovery();
  private identityWarningAt = 0;
  private identityRecoveryTimer: NodeJS.Timeout | null = null;
  private loopDelayTimer: NodeJS.Timeout | null = null;
  private readonly startedAt = Date.now();
  readonly instanceId = randomUUID();
  private ticks = 0;
  private tickErrors = 0;
  private lastTickAt: number | null = null;
  private lastAutoTitleAt = 0;
  private lastBoot: BootReport | null = null;
  private stopping = false;
  private publishedSeq = 0;
  private readonly opLog: string[] = [];
  private accounts: AccountsService | null = null;
  private loginFlows: LoginFlowService | null = null;
  private quotaRecovery: QuotaRecovery | null = null;
  private authResume: AuthResume | null = null;
  /** v31 — Cell disk retention pass + `cell.gc` / `cell.evict`. */
  private retention: CellRetentionService | null = null;
  /** Tracked filesystem readiness; no lock wait runs inside the core/store writer. */
  private readonly accountActivations = new Map<string, AccountActivationState>();
  private accountActivationCandidates = new Map<string, { commandId: number; attempts: number; enqueuedAt: number }>();
  /** Due start commands held because their account cannot authenticate here; value = the refusal code last logged. */
  private readonly runtimeStartHolds = new Map<string, string>();
  private readonly runtimeStartProbeAt = new Map<string, { at: number; attempts: number; revision: string }>();
  /** Allocator claims refused for account readiness inside a transaction, awaiting their post-rollback fence + release. */
  private readonly refusedClaims = new Map<string, AccountAdmissionClaim>();
  private gatewayActivationRevision = "";
  private activationRevisionEpoch = -1;
  private tickEpoch = 0;
  private readonly accountConfigImport: AccountConfigImportService;
  private readonly deps: HiveDaemonDeps;
  /** v7 rotation bound: one attempt per (bee, generation) exhaustion event. */
  private readonly rotatedGenerations = new Map<string, number>();
  private lastWeeklyCeilingSweepAt = 0;
  private readonly weeklyCeilingMoves = new Map<string, { account: string; at: number }>();
  private readonly weeklyCeilingNotes = new Map<string, { afterGeneration: number; body: string }>();
  /** In-flight async idempotent verbs by key: a concurrent duplicate joins the first execution instead of re-running it. */
  private effectInFlight?: Map<string, { verb: "spawn"; fingerprint: string; promise: Promise<SpawnResult> }>;
  private readonly asyncInFlight = new Map<string, Promise<object>>();
  private naming: ResolvedNamingConfig;
  private contextPolicy: ContextPolicyConfig;
  private autoTitle: ((bees?: BeeRow[]) => Promise<AutoTitleOutcome[]>) | null = null;
  private titleGenerator: TitleGeneratorService | null = null;
  private readonly performance: PerformanceProfiler;
  private activeStartupPhase: PerformanceSpan | null = null;
  private readonly beeTmp: BeeTmpPolicy | null;
  private runnerSocketDir: string;
  private tmuxSocketPath = "";
  private readonly beeTmpOverrideLogged = new Set<string>();

  constructor(cfg: ResolvedNodeConfig, deps: HiveDaemonDeps = {}) {
    validateNodeStatePaths(cfg);
    this.cfg = cfg;
    this.deps = deps;
    this.beeTmp = resolveBeeTmpPolicy(cfg.nodeKind, cfg.beeTmpRoot, process.env, undefined, cfg.dataDir);
    this.runnerSocketDir = tmpdir();
    this.naming = cfg.naming;
    this.contextPolicy = cfg.contextPolicy;
    this.performance = createPerformanceProfiler({ log: (op) => this.log(op) });
    this.accountConfigImport = new AccountConfigImportService();
  }

  /** The account plane (tests reach the selector / capture / importer through it). */
  get accountsService(): AccountsService {
    if (!this.accounts) throw new Error("daemon not started");
    return this.accounts;
  }

  /** v16: the login-flow plane (tests reach worker status / boot reconciliation through it). */
  get loginFlowService(): LoginFlowService {
    if (!this.loginFlows) throw new Error("daemon not started");
    return this.loginFlows;
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    const runtimeTarget = `${process.platform}-${process.arch}`;
    if (BUILD_IDENTITY.target !== runtimeTarget) throw new Error(`daemon: build target ${BUILD_IDENTITY.target} differs from runtime target ${runtimeTarget}; install an artifact built for this node`);
    mkdirSync(this.cfg.dataDir, { recursive: true, mode: 0o700 });
    const sockets = placeDaemonSockets(this.cfg.dataDir, this.cfg.socketPath, { runnerSocketDir: this.runnerSocketDir });
    this.cfg = { ...this.cfg, socketPath: sockets.socketPath };
    this.tmuxSocketPath = sockets.tmuxSocketPath;
    this.runnerSocketDir = sockets.runnerSocketDir;
    if (sockets.socketDir) this.log(`socket.relocated dir=${sockets.socketDir} socket=${sockets.socketPath} tmux=${sockets.tmuxSocketPath}`);
    mkdirSync(this.cfg.sessionLogDir, { recursive: true });
    mkdirSync(dirname(this.cfg.logPath), { recursive: true });
    if (this.beeTmp) applyDaemonTmpPolicy(this.beeTmp, process.env, (path, was) => this.log(`tmp.replaced path=${path} was=${was}`));
    this.log(describeBeeTmpPolicy(this.beeTmp));
    if (this.cfg.beeTmpRootInvalid) this.log(`tmp.policy_invalid reason=${JSON.stringify(this.cfg.beeTmpRootInvalid)}`);
    if (process.platform === "darwin") {
      const userTemp = darwinUserTempDir();
      this.log(userTemp ? `sandbox.scratch darwinUserTemp=${userTemp}` : "sandbox.scratch darwinUserTemp=unresolved fallback=/private/var/folders");
    }
    if (this.cfg.beeSandboxTmpBytesInvalid) this.log(`tmp.sandbox_cap_invalid reason=${JSON.stringify(this.cfg.beeSandboxTmpBytesInvalid)} using=${DEFAULT_SANDBOX_TMPFS_BYTES}`);
    this.performance.start();
    const startup = this.performance.startSpan("daemon.start.total");
    try {
      await this.startProfiled();
      startup.end();
    } catch (error) {
      this.activeStartupPhase?.end("error");
      this.activeStartupPhase = null;
      startup.end("error");
      this.performance.stop();
      throw error;
    }
  }

  private daemonProcessIdentity() {
    const identity = inspectProcess(process.pid);
    // Preserve degraded RPC service when the optional native bridge is unavailable.
    // Deploy readers require exact evidence and will not follow this record.
    return identity.kind === "present" ? { processBirth: identity.birth, bootId: identity.bootId } : {};
  }

  private async startProfiled(): Promise<void> {
    const storage = this.performance.startSpan("daemon.start.storage");
    this.activeStartupPhase = storage;
    this.telemetry = new TelemetryStore(this.cfg.telemetryPath);
    // Opening the store IS the single-daemon lock (B9): a second daemon on
    // this node dies right here with SecondWriterError.
    const store = openCoreStore(this.cfg.storePath, {
      buildIdentity: JSON.stringify(BUILD_IDENTITY),
      maxAttempts: this.cfg.maxAttempts,
      backoffBaseMs: this.cfg.backoffBaseMs,
    });
    this.store = store;
    const redaction = store.rpcIdempotencyRedactionReceipt;
    if (redaction) {
      this.log(`store.migration.rpc_idempotency_env seen=${redaction.seen} redacted=${redaction.redacted} skipped_unparseable=${redaction.skippedUnparseable} skipped_unrecognised=${redaction.skippedUnrecognised} complete=${redaction.complete} ms=${redaction.wallMs}`);
    }
    this.threadOperations = new ThreadOperations(store, beeId => this.resolveSpawnSpec(beeId));
    for (const operation of store.listThreadOperations()) if (operation.failure?.code === "successor_deleted") this.removeThreadArtifacts(operation.id);
    storage.end();
    this.activeStartupPhase = null;
    const services = this.performance.startSpan("daemon.start.services");
    this.activeStartupPhase = services;
    const codexSpec = this.cfg.agents.codex;
    this.titleGenerator = new TitleGeneratorService({
      log: (op) => this.log(op),
      recordUsage: (usage) => store.recordNamingUsage(usage),
      ...(codexSpec?.command ? { codexCommand: codexSpec.command } : {}),
      ...(codexSpec?.args ? { codexArgs: codexSpec.args } : {}),
    });
    this.autoTitle = createStoreAutoTitleDispatcher(store, {
      naming: () => this.naming,
      statePath: join(this.cfg.dataDir, "auto-title.json"),
      log: (op) => this.log(op),
      generate: (context) => this.titleGenerator!.generate(context, this.naming),
    });
    this.titleGenerator.warm(this.naming);
    this.accounts = new AccountsService({
      store,
      cfg: this.cfg,
      log: (op) => this.log(op),
      keychainReader: this.deps.keychainReader,
      keychainWriter: this.deps.keychainWriter,
      fetchers: this.deps.fetchers,
      ...(this.deps.gatewayMcpSeeder ? { gatewayMcpSeeder: this.deps.gatewayMcpSeeder } : {}),
      onCredentialValidated: (accountId, by) => this.credentialValidatedQuietly(accountId, by),
    });
    const accounts = this.accounts;
    this.quotaRecovery = new QuotaRecovery(store, row => this.recoverQuota(row.id));
    this.authResume = new AuthResume({
      store,
      log: (op) => this.log(op),
      accountForGeneration: (bee, generation) => accounts.accountForGeneration(bee, generation),
      credentialRevision: (account) => accounts.credentialRevision(account),
      material: (account) => accounts.authDeathMaterial(account),
    });
    this.loginFlows = new LoginFlowService({
      store,
      cfg: this.cfg,
      accounts: this.accounts,
      log: (op) => this.log(op),
      ...(this.deps.loginTransports ? { transports: this.deps.loginTransports } : {}),
      ...(this.deps.loginSpawner !== undefined ? { spawner: this.deps.loginSpawner } : {}),
      ...(this.deps.loginTmuxExec ? { tmuxExec: this.deps.loginTmuxExec } : {}),
      onCompleted: (accountId) => this.credentialValidatedQuietly(accountId, "login"),
    });
    services.end();
    this.activeStartupPhase = null;
    this.confinementBwrap = bwrapMode();
    for (const reason of strictConfinementReasons(this.confinementBwrap.setuid)) this.confinementReason(reason);
    this.log(`security.confinement strict=${this.confinementReasons.size > 0} bwrap=${JSON.stringify(this.confinementBwrap)}`);
    const drivers = this.performance.startSpan("daemon.start.drivers");
    this.activeStartupPhase = drivers;
    // v23: the bee row owns its CURRENT session log file (a handoff opens a
    // new transcript segment with its own file); drivers ask the store. Only
    // Honeybee-owned files (under sessionLogDir) are honored: a frozen import
    // records the OLD world's transcript path on the row, and the native
    // stream must never be appended to that file.
    const sessionLogPathFor = (beeId: string): string | null => this.ownedSessionLogPath(store.getBee(beeId)?.sessionLogPath ?? null);
    const hsrConfig = {
      sessionLogDir: this.cfg.sessionLogDir,
      sessionLogPathFor,
      stopKillGraceMs: this.cfg.stopKillGraceMs,
      adoptToleranceMs: this.cfg.adoptToleranceMs,
      onWriteLaneReady: () => this.requestTick(),
      runtimeIdentity: {...store.runtimeIdentityHooks(), unavailable: (beeId: string, generation: number) => this.retainProcessIdentity(beeId, generation)},
      onRuntimeReady: (beeId: string, pid: number | null) => this.observeCellRuntimeNamespace(beeId, pid),
      execution: store.executionRuntimeHooks(),
      executionStartFor: (beeId: string, generation: number) => store.existingExecutionStart(beeId,generation),
      executionHostFor: (start: ExecutionStart) => store.executionStartHost(start),
      resolveExecutionAdapter: (beeId: string) => {
        const bee = store.getBee(beeId), spec = bee ? this.cfg.agents[bee.agent] : null;
        if (!bee || !spec) throw new ExecutionFenceError("rpc_execution_history_unknown","Fenced adapter cannot be resolved read-only");
        const adapter = composeSpawn(spec,spec.adapter ?? bee.agent,bee,[],null).adapter;
        if (!adapter) throw new ExecutionFenceError("rpc_execution_history_unknown","Fenced adapter is unavailable");
        return adapter;
      },
      socketDir: this.runnerSocketDir,
    };
    const hsr = new HsrDriver({ ...hsrConfig, resolve: (beeId: string, generation?: number) => this.resolveSpawnSpec(beeId, generation) });
    // Cell substrate (spec 05): a CellDriver composed over its own inner
    // HsrDriver — pure delegation; the cell layer adds provisioning, cwd =
    // the space checkout, and the A4 sandbox. Same harness resolution.
    const cell = new CellDriver({
      cellsRoot: this.cfg.cellsRoot,
      nodeKind: this.cfg.nodeKind,
      resolveHarness: (beeId: string, generation?: number) => this.resolveSpawnSpec(beeId, generation),
      sandboxKvm: this.cfg.cellKvm,
      resolveCell: (beeId: string) => this.resolveCellSpec(beeId),
      resolveSandboxWritablePaths: (beeId: string) => this.resolveCellSandboxWritablePaths(beeId),
      ...(this.cfg.beeSandboxTmpBytes !== undefined ? { sandboxTmpfsBytes: this.cfg.beeSandboxTmpBytes } : {}),
      log: (op: string) => this.log(op),
      onCellMaterialized: (beeId: string, execution?: ExecutionStart) => this.onCellMaterialized(beeId,execution),
      ...(this.cfg.cellRetention.fetchUpstream ? { upstreamRefresh: { root: upstreamRootFor(this.cfg.dataDir) } } : {}),
      onUpstreamRefreshed: (originRepo, result) => {
        const sync = result.sync;
        if (sync == null) return;
        const error = sync.refresh.status === "failed" ? ` error=${JSON.stringify(sync.refresh.error)}` : "";
        const skipped = sync.skipped == null ? "" : ` skipped=${JSON.stringify(sync.skipped)}`;
        this.log(`cell.upstream origin=${originRepo} mirror=${sync.refresh.status} ref=${sync.trackingRef ?? "-"} before=${sync.before ?? "-"} after=${sync.after ?? "-"} ms=${sync.durationMs}${result.built > 0 ? ` pool_built=${result.built}` : ""}${skipped}${error}`);
      },
      hsr: hsrConfig,
      backgroundProvisioning: true,
      ...(this.cfg.cellWarmPoolFree > 0
        ? { warmPool: { targetFree: this.cfg.cellWarmPoolFree, maxSize: this.cfg.cellWarmPoolMaxSize } }
        : {}),
    });
    mkdirSync(join(this.cfg.dataDir, "tmux-events"), { recursive: true });
    const tmux = new TmuxDriver({
      cleanup: store.tmuxCleanupHooks(),
      runtimeIdentity: {...store.runtimeIdentityHooks(), unavailable: (beeId: string, generation: number) => this.retainProcessIdentity(beeId, generation)},
      doctor: counts => this.log(`doctor.runtime_identity non_destructive_legacy=${counts.nonDestructiveLegacy}`),
      socketPath: this.tmuxSocketPath,
      eventsDir: join(this.cfg.dataDir, "tmux-events"),
      sessionLogDir: this.cfg.sessionLogDir,
      sessionLogPathFor,
      resolve: (beeId: string, generation?: number) => this.resolveTmuxSpec(beeId, generation),
      stopKillGraceMs: this.cfg.stopKillGraceMs,
      adoptToleranceMs: this.cfg.adoptToleranceMs,
    });
    const driver = new SubstrateRouter({
      hsr,
      cell,
      tmux,
      substrateOf: (beeId: string) => store.getBee(beeId)?.substrate ?? null,
    });
    this.driver = driver;
    this.retention = new CellRetentionService({
      cellsRoot: this.cfg.cellsRoot,
      policy: this.cfg.cellRetention,
      store: () => this.mustStore(),
      now: () => Date.now(),
      log: (op) => this.log(op),
      cellInUse: (beeId, runtime, cellState) =>
        store.retainsMultilineRuntimeContent(beeId, canonicalPath(this.cfg.dataDir)) || (cellState === "retained"
          ? cell.hasProcess(beeId, runtime?.generation ?? 0)
          : (runtime != null && runtime.state !== "stopped") || (this.driver?.hasProcess(beeId, runtime?.generation ?? 0) ?? false)),
      opInFlight: (cellId) => {
        this.releaseAbsentCellOps(cellId);
        return this.cellHasInFlightOp(cellId);
      },
      forgetCell: (beeId) => cell.forgetCell(beeId),
      ...(this.deps.retentionWorkerUrl ? { workerUrl: this.deps.retentionWorkerUrl } : {}),
      ...(this.deps.retentionInitialDelayMs !== undefined ? { initialDelayMs: this.deps.retentionInitialDelayMs } : {}),
      ...(this.deps.retentionDiskCheckMs !== undefined ? { diskCheckMs: this.deps.retentionDiskCheckMs } : {}),
      ...(this.deps.retentionPressureRetryMs !== undefined ? { pressureRetryMs: this.deps.retentionPressureRetryMs } : {}),
      ...(this.deps.retentionStatfs ? { statfs: this.deps.retentionStatfs } : {}),
      dataDir: this.cfg.dataDir,
      audit: (kind, payload) => this.mustStore().recordCellRetentionEvent(kind, payload),
      clearBeeTmp: (beeId) => this.removeBeeTmp(beeId),
      lastRecordedPass: (kind) => this.mustStore().latestCellRetentionPass(kind ?? null),
      recentEvictionTimes: (sinceTs) => this.mustStore().cellRetentionEvictionTimes(sinceTs),
      lastDailyCapAt: () => this.mustStore().lastCellRetentionDailyCapAt(),
    });
    for (const warning of this.cfg.cellRetention.warnings) this.log(`config.retention.invalid ${warning}`);
    this.core = new DaemonCore({
      store,
      driver,
      multilineFallback: {
        files: this.deliveryFiles,
        root: canonicalPath(this.cfg.dataDir),
        rootForBee: bee => {
          const wrapper = cell.cellOf(bee.id)?.paths.wrapperDir;
          return deliveryContentRoot(canonicalPath(this.cfg.dataDir), bee.substrate, bee.substrate === "cell" && sandboxEnabled(this.cfg.nodeKind, this.resolveCellSpec(bee.id).sandbox), wrapper ? canonicalPath(wrapper) : null);
        },
        worktrees: bee => {
          const space = cell.cellOf(bee.id)?.paths.spaceDir;
          return [canonicalPath(bee.cwd), ...(space ? [canonicalPath(space)] : [])];
        },
      },
      policy: {
        bootHangTimeoutSteps: this.cfg.bootHangTimeoutMs,
        commandsPerStep: this.cfg.commandsPerTick,
        idleWindowSteps: this.cfg.idleWindowMs > 0 ? this.cfg.idleWindowMs : null,
        i1DeadlineSteps: this.cfg.i1DeadlineMs,
      },
      now: Date.now,
      log: (op) => this.log(op),
      onI1Violation: (v) => this.recordI1(v),
      removeSessionLog: (path) => rmSync(path, { force: true }),
      ...(this.beeTmp ? { removeBeeTmp: (beeId: string) => this.removeBeeTmp(beeId) } : {}),
      removeThreadArtifacts: operationId => this.removeThreadArtifacts(operationId),
      onFlagEvidence: (ev) => this.applyAccountPolicy(ev),
      beforeTurn: (beeId, generation) => this.admitProviderTurn(beeId, generation),
      onUsageEvidence: (ev) => this.applyUsageObservation(ev),
      performance: this.performance,
      sourceProcessAbsent: (beeId, generation) => this.sourceProcessAbsent(beeId, generation),
      relocateSession: (move, bee) => this.relocateMoveSession(move, bee),
      validatePlacement: (move, bee) => this.validateMoveDestination(move, bee),
      onIdentityUnresolved: (beeId, generation) => this.retainProcessIdentity(beeId, generation),
      blockedRuntimeStartBeeIds: () => this.prepareRuntimeStartCommands(),
      assertRuntimeStartReady: (command) => this.assertRuntimeStartReady(command),
      readHandoffTranscript: (bee, segments) => this.readHandoffTranscript(bee, segments),
      ...(this.deps.summarizeHandoff ? { summarizeHandoff: this.deps.summarizeHandoff } : {}),
      cellCaptureExecutor: this.cellCaptureExecutor(store),
      reconnectTools: command => driver.reconnectTools(command.beeId, command.targetGeneration!, command.id, async (apply, home) => {
        await this.accounts!.reconnectGatewayTools(home, async targets => {
          if (this.stopping) throw new Error("Daemon is shutting down");
          store.setReconnectTargets(command.id, targets);
          await apply(targets);
        });
      }),
    });
    drivers.end();
    this.activeStartupPhase = null;
    const reconcile = this.performance.startSpan("daemon.start.reconcile");
    this.activeStartupPhase = reconcile;
    // Behavior 2: re-adopt surviving runtimes by the identities core recorded
    // at spawn, so DaemonCore.boot()'s snapshotLive() sees them and
    // reconcileAtBoot keeps their rows live instead of stopping them.
    this.backfillCellRegistry(store);
    const unresolved = this.adoptSurvivors(store, driver);
    for (const row of unresolved) this.identityRecovery.retain({...row, since: store.runtimeIdentityUnresolvedSince(row.beeId, row.generation)});
    this.lastBoot = this.core.boot(unresolved);
    for (const { view } of store.listBeeViewRows()) {
      const flags = store.activeFlags(view.beeId).filter(row => row.detail.startsWith("account_credentials_unusable:") || row.detail.startsWith("runtime_start_held:"));
      if (flags.length === 0) continue;
      const pending = store.listCommands({ beeId: view.beeId }).some(command => command.status === "queued" && ["spawn", "revive", "send_wake"].includes(command.verb));
      if (!pending) this.clearRuntimeStartAttention(view.beeId);
    }
    this.identityRecoveryTimer = setInterval(() => this.retryProcessIdentities(), 1000);
    this.identityRecoveryTimer.unref();
    this.sweepBeeTmpAtBoot(store);
    this.reconcileCellOpsAtBoot();
    // v31: wrappers parked by an earlier pass are already evicted; finish deleting them.
    void this.retention.sweep();
    this.retention.reconcileKept();
    // v16: login workers do not survive a daemon restart (a PTY cannot be
    // re-adopted): settle their flows as interrupted, then remove the
    // retired tmux login seats this node's own daemons created.
    this.loginFlows.reconcileAtBoot();
    // HIVE-2: a restart mid-incident re-attempts coordinated recovery for any
    // Claude account left auth_needed, rather than stranding it until the next
    // periodic limits sweep.
    this.accounts?.scheduleRecoveryForAuthNeededClaude();
    store.pruneAuthInterruptions(Date.now() - AUTH_INTERRUPTION_RETENTION_MS);
    this.publishedSeq = store.lastAuditSeq();
    reconcile.end();
    this.activeStartupPhase = null;
    const rpc = this.performance.startSpan("daemon.start.rpc");
    this.activeStartupPhase = rpc;
    this.rpc = new RpcServer({
      admitConfined: (verb, params, conn) => this.admitConfined(verb, params, conn),
      peerConfinement: (peer, registered) => peerConfinement(peer, {strict: this.confinementReasons.size > 0, registered, substrate: () => {
        const id = peer ? this.spawnPeerBee(peer) : null;
        return id ? this.mustStore().getBee(id)?.substrate ?? null : null;
      }}),
      assertServiceCaller: peer => {
        if (this.spawnPeerBee(peer)) throw new RpcError("caller_not_trusted", "A bee runtime cannot register as the Apiary service");
      },
      socketPath: this.cfg.socketPath,
      dataDir: this.cfg.dataDir,
      instance: { id: this.instanceId, dataDir: canonicalPath(this.cfg.dataDir) },
      localTrust: this.cfg.rpcLocalTrust,
      securityAudit: (kind, payload) => store.recordLocalRpcEvent(kind as "rpc.peer_credentials_unavailable" | "rpc.local_refused" | "rpc.local_registered", payload),
      log: (op) => this.log(op),
      dispatch: (verb, params, conn) => this.dispatch(verb, params, conn),
      performance: this.performance,
    });
    try {
      await this.rpc.listen(() => writeEndpointRecord(this.cfg.dataDir, { instanceId: this.instanceId, dataDir: canonicalPath(this.cfg.dataDir), socketPath: resolve(this.cfg.socketPath), tmuxSocketPath: this.tmuxSocketPath, pid: process.pid, startedAt: this.startedAt, ...this.daemonProcessIdentity() }));
    } catch (error) {
      removeEndpointRecord(this.cfg.dataDir, this.instanceId);
      throw error;
    }
    cell.trackOrigins(this.recentCellOrigins(store));
    void this.accounts?.credentialHandoff.reconcileStartup().catch(() => this.log("account.credentials.handoff_reconcile_failed"));
    rpc.end();
    this.activeStartupPhase = null;
    this.scheduleTick(this.cfg.tickMs);
    // Loop-delay watch (2026-08-21): tick.slow attributes stalls inside the
    // tick; this catches the rest (sync RPC-handler work, keychain/tmux
    // shell-outs) — at most one log line per minute, when the loop stalled.
    this.loopDelay = monitorEventLoopDelay({ resolution: 20 });
    this.loopDelay.enable();
    this.loopDelayTimer = setInterval(() => {
      const h = this.loopDelay;
      if (!h) return;
      const maxMs = Math.round(h.max / 1e6);
      const p99Ms = Math.round(h.percentile(99) / 1e6);
      if (maxMs >= 500) this.log(`loop.stall max=${maxMs}ms p99=${p99Ms}ms window=60s`);
      h.reset();
    }, 60_000);
    this.loopDelayTimer.unref();
    this.log(`daemon.started pid=${process.pid} store=${this.cfg.storePath}`);
    if (this.naming.disabledReason) this.log(`naming.disabled reason=${JSON.stringify(this.naming.disabledReason)}`);
  }

  async shutdown(options: ShutdownOptions = {}): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.log(`daemon.stopping pid=${process.pid}`);
    try {
      if (this.tickTimer) clearTimeout(this.tickTimer);
      if (this.identityRecoveryTimer) clearInterval(this.identityRecoveryTimer);
      if (this.loopDelayTimer) clearInterval(this.loopDelayTimer);
      this.loopDelay?.disable();
      this.tickTimer = null;
      await this.quotaRecovery?.stop();
      await this.retention?.stop();
      this.titleGenerator?.close();
      this.titleGenerator = null;
      // v16: no login worker outlives the daemon (boot marks their flows interrupted).
      await this.loginFlows?.shutdown();
      await this.threadOperations?.shutdown();
      await this.rpc?.close();
      removeEndpointRecord(this.cfg.dataDir, this.instanceId);
      this.core?.detachReconnectOwner();
      if (options.preserveRuntimes === false) {
        // Test/ephemeral ownership only. Production never selects this path:
        // deploys must preserve runtimes for successor-daemon re-adoption.
        try { this.driver?.disposeAll(); } finally {
          this.store?.close();
          this.telemetry?.close();
        }
      } else {
        this.store?.close();
        this.telemetry?.close();
        // Children are NOT killed: detached runtimes survive daemon restarts by
        // design and the next boot re-adopts them (contract §3.2). Their pipe
        // handles must not pin our event loop, though — detach them so the
        // process can actually exit.
        this.driver?.detachAll();
      }
      this.log("daemon.stopped");
      this.log(`daemon.stop_complete pid=${process.pid}`);
    } finally {
      this.performance.stop();
    }
  }

  /**
   * Run the next tick as soon as the loop is free instead of at the cadence
   * boundary. A tick is synchronous, so a caller can never observe one in
   * progress: a null timer only means the daemon is not running.
   */
  private requestTick(): void {
    if (this.stopping || !this.tickTimer || this.tickRequested) return;
    this.tickRequested = true;
    clearTimeout(this.tickTimer);
    this.scheduleTick(nextTickDelayMs(0));
  }

  private scheduleTick(delayMs: number): void {
    this.tickTimer = withoutRpcCaller(() => setTimeout(() => {
      this.tickTimer = null;
      this.tickRequested = false;
      if (this.stopping) return;
      this.tick();
      if (!this.stopping) {
        this.scheduleTick(nextTickDelayMs(this.runtimeStartHolds.size > 0 ? Math.min(1000, this.cfg.tickMs) : this.store?.hasBootingRuntime() ? Math.min(BOOTING_TICK_MS, this.cfg.tickMs) : this.cfg.tickMs));
      }
    }, delayMs));
  }

  private tick(): void {
    const core = this.core;
    const store = this.store;
    if (!core || !store || this.stopping) return;
    this.tickEpoch += 1;
    this.performance.measureSync("daemon.tick.total", () =>
      this.tickProfiled(core),
    );
  }

  private accountActivationKey(
    bee: BeeRow,
    account: AccountRow,
    command: { commandId: number; attempts: number },
  ): string {
    return JSON.stringify([
      this.gatewayActivationRevision,
      command.commandId,
      command.attempts,
      account.id,
      account.harness,
      account.homePath,
      bee.cwd,
    ]);
  }

  /**
   * Start account filesystem readiness outside SQLite transactions. Promises
   * remain tracked; core skips only affected runtime-start commands while
   * other bees and non-start work continue.
   */
  private readonly executionStartHolds = new Set<string>();

  private refreshAccountActivations(): void {
    const store = this.store;
    const accounts = this.accounts;
    if (!store || !accounts) return;
    const candidates = new Map<string, { commandId: number; attempts: number; enqueuedAt: number }>();
    for (const command of store.listDueRuntimeStartCommands()) {
      if (!candidates.has(command.beeId)) {
        candidates.set(command.beeId, { commandId: command.id, attempts: command.attempts, enqueuedAt: command.enqueuedAt });
      }
    }
    this.accountActivationCandidates = candidates;
    for (const accountId of this.runtimeStartProbeAt.keys()) if (!store.getAccount(accountId)) this.runtimeStartProbeAt.delete(accountId);
    for (const beeId of this.runtimeStartHolds.keys()) {
      if (!candidates.has(beeId)) {
        this.runtimeStartHolds.delete(beeId);
        if (store.getBee(beeId)) {
          this.clearRuntimeStartAttention(beeId);
        }
      }
    }
    if (candidates.size === 0) {
      for (const [beeId, state] of this.accountActivations) {
        if (state.status !== "pending") this.accountActivations.delete(beeId);
      }
      return;
    }
    if (this.activationRevisionEpoch !== this.tickEpoch) {
      this.gatewayActivationRevision = gatewayActivationRevision(liveGateways());
      this.activationRevisionEpoch = this.tickEpoch;
    }

    for (const [beeId, command] of candidates) {
      let execution: ExecutionStart | null = null;
      try {
        const rt = store.currentRuntime(beeId);
        execution = store.prepareExecutionStart(beeId,rt && rt.state !== "stopped" ? rt.generation : (rt?.generation ?? 0)+1);
        if (execution) store.executionRuntimeHooks().check(execution,"account_selection");
        this.executionStartHolds.delete(beeId);
      } catch (error) {
        if (!(error instanceof ExecutionFenceError)) throw error;
        this.executionStartHolds.add(beeId); continue;
      }
      let bee = store.getBee(beeId);
      if (!bee?.account) {
        this.accountActivations.delete(beeId);
        continue;
      }
      let account = store.getAccount(bee.account);
      if (!account) continue;
      if (!execution && this.moveOffWeeklyCeiling(bee, account)) {
        bee = store.getBee(beeId);
        account = bee?.account ? store.getAccount(bee.account) : null;
        if (!bee || !account) continue;
      }
      if (this.holdRuntimeStart(bee, account, command.commandId)) continue;
      const key = this.accountActivationKey(bee, account, command);
      const current = this.accountActivations.get(beeId);
      if (current?.key === key) continue;
      // A stale preparation may still own the per-home filesystem lock. Let it
      // settle before starting the replacement key; the mismatched state keeps
      // this candidate blocked in the meantime.
      if (current?.status === "pending") continue;

      const state: AccountActivationState = {
        key,
        status: "pending",
        task: Promise.resolve(),
      };
      // Defer even the synchronous home-activation prefix until after this
      // executor turn. Slow filesystem work never holds the SQLite writer or
      // prevents unrelated commands in the same core step from progressing.
      const hooks = store.executionRuntimeHooks();
      const lease = execution ? hooks.begin(execution,"account_activation") : null;
      const task = Promise.resolve().then(() => {
        if (execution) hooks.check(execution,"account_activation");
        return accounts.activateForSpawn(account,bee);
      }).then(
        () => {
          if (execution && lease) { hooks.finish(execution,lease,true); hooks.check(execution,"account_activation_ready"); }
          if (this.accountActivations.get(beeId) !== state) return;
          state.status = "ready";
          // The blocked start command can claim immediately.
          this.requestTick();
        },
        (error: unknown) => {
          if (execution && lease) { try { hooks.finish(execution,lease,false); } catch {} }
          if (this.accountActivations.get(beeId) !== state) return;
          state.status = "failed";
          state.error = activationFailureName(error);
          this.log(`account.activate.gateways_failed bee=${beeId} account=${account.id} error=${state.error}`);
        },
      );
      state.task = task;
      this.accountActivations.set(beeId, state);
    }

    for (const [beeId, state] of this.accountActivations) {
      if (!candidates.has(beeId) && state.status !== "pending") this.accountActivations.delete(beeId);
    }
  }

  /** Refresh the bounded due-start set immediately before a command claim. */
  private prepareRuntimeStartCommands(): ReadonlySet<string> {
    this.authResume?.reconcile();
    this.refreshAccountActivations();
    const blocked = new Set([...this.blockedRuntimeStartBeeIds(),...this.executionStartHolds]);
    for (const row of this.mustStore().listLiveAuthInterruptions()) if (this.authResume?.holdsStoppedRuntime(row)) {
      blocked.add(row.beeId);
      if (this.runtimeStartHolds.get(row.beeId) !== "account_auth_needed") {
        this.runtimeStartHolds.set(row.beeId, "account_auth_needed");
        this.log(`runtime.start.held bee=${row.beeId} account=${row.account} code=account_auth_needed — Waiting for refreshed account material`);
      }
    }
    return blocked;
  }

  /**
   * The shared runtime-start boundary: a due spawn / revive / send_wake whose
   * account cannot authenticate on this node is HELD (the command stays
   * queued, the mail stays accepted) rather than started into a "Not logged
   * in" crash loop. A pause is not an auth fact and does not hold a restart.
   * Logged once per (bee, code) transition.
   */
  private holdRuntimeStart(bee: BeeRow, account: AccountRow, commandId: number): boolean {
    const readiness = this.runtimeStartReadiness(account);
    const previous = this.runtimeStartHolds.get(bee.id);
    if (readiness.ready) {
      this.clearRuntimeStartAttention(bee.id);
      this.runtimeStartProbeAt.delete(account.id);
      if (previous !== undefined) {
        this.runtimeStartHolds.delete(bee.id);
        this.log(`runtime.start.released bee=${bee.id} account=${account.id} command=${commandId}`);
      }
      return false;
    }
    if (previous !== readiness.code) {
      this.runtimeStartHolds.set(bee.id, readiness.code);
      this.mustStore().touchAccount(account.id, `runtime start held: ${readiness.code}`);
      this.log(`runtime.start.held bee=${bee.id} account=${account.id} command=${commandId} code=${readiness.code} — ${readiness.message}`);
    }
    const now = Date.now();
    if (readiness.code === "credential_file_damaged") {
      const revision = this.mustAccounts().credentialRevision(account);
      const prior = this.runtimeStartProbeAt.get(account.id);
      if (!prior || prior.revision !== revision || now >= prior.at) {
        const attempts = prior?.revision === revision ? prior.attempts + 1 : 1;
        this.runtimeStartProbeAt.set(account.id, { at: now + Math.min(30_000 * 2 ** Math.min(attempts - 1, 5), 15 * 60_000), attempts, revision });
        this.log(`runtime.start.verify account=${account.id} attempt=${attempts} nextAttemptAt=${this.runtimeStartProbeAt.get(account.id)!.at}`);
        this.mustAccounts().scheduleVerification([account.id]);
      }
    }
    const command = this.accountActivationCandidates.get(bee.id);
    if (command && now - command.enqueuedAt >= 60_000) {
      const credential = ["credential_file_damaged", "account_auth_needed", "account_credential_missing", "account_credential_invalid", "account_credential_expired"].includes(readiness.code);
      const kind = credential ? "auth_needed" : "resource_blocked";
      const detail = `${credential ? "account_credentials_unusable" : "runtime_start_held"}: ${readiness.code}: ${readiness.message}`;
      const flags = this.mustStore().activeFlags(bee.id);
      for (const owned of flags) if (owned.flag !== kind && (owned.detail.startsWith("account_credentials_unusable:") || owned.detail.startsWith("runtime_start_held:"))) this.mustStore().clearFlag(bee.id, owned.flag, "Runtime-start refusal changed");
      const flag = flags.find(row => row.flag === kind);
      if (!flag || (flag.detail.startsWith("account_credentials_unusable:") || flag.detail.startsWith("runtime_start_held:")) && flag.detail !== detail) this.mustStore().setFlag(bee.id, kind, detail);
    }
    return true;
  }

  private clearRuntimeStartAttention(beeId: string): void {
    for (const flag of this.mustStore().activeFlags(beeId)) if (flag.detail.startsWith("account_credentials_unusable:") || flag.detail.startsWith("runtime_start_held:")) this.mustStore().clearFlag(beeId, flag.flag, "Runtime-start hold released");
  }

  /** A pause is placement policy, not an auth fact: a restart on a paused account is judged on its credential alone. */
  private runtimeStartReadiness(account: AccountRow): AccountReadiness {
    return this.mustAccounts().credentialReadiness(account);
  }

  private blockedRuntimeStartBeeIds(): ReadonlySet<string> {
    const blocked = new Set<string>();
    const store = this.store;
    if (!store) return blocked;
    for (const [beeId, command] of this.accountActivationCandidates) {
      const bee = store.getBee(beeId);
      if (!bee?.account) continue;
      const account = store.getAccount(bee.account);
      if (!account) continue;
      if (this.runtimeStartHolds.has(beeId)) { blocked.add(beeId); continue; }
      const state = this.accountActivations.get(beeId);
      const current = state?.key === this.accountActivationKey(bee, account, command);
      if (!current || state.status === "pending") blocked.add(beeId);
    }
    return blocked;
  }

  private assertRuntimeStartReady(command: CommandRow): void {
    const store = this.mustStore();
    const beeId = command.beeId;
    const bee = store.getBee(beeId);
    if (!bee?.account) return;
    const account = store.getAccount(bee.account);
    if (!account) return;
    const readiness = this.runtimeStartReadiness(account);
    if (!readiness.ready) throw new Error(`account not ready: ${readiness.code}: ${readiness.message}`);
    const state = this.accountActivations.get(beeId);
    const key = this.accountActivationKey(bee, account, { commandId: command.id, attempts: command.attempts });
    if (state?.key === key && state.status === "ready") return;
    if (state?.key === key && state.status === "failed") {
      throw new Error(`account gateway activation failed: ${state.error ?? "unknown_error"}`);
    }
    throw new Error("account gateway activation is not ready");
  }

  private tickProfiled(core: DaemonCore): void {
    const t0 = Date.now();
    let tStep = t0;
    let tAccounts = t0;
    try {
      this.threadOperations?.tick();
      this.performance.measureSync("daemon.tick.core", () => {
        core.step();
        this.quotaRecovery?.reconcile();
        this.authResume?.reconcile();
      });
      tStep = Date.now();
      this.ticks += 1;
      this.lastTickAt = tStep;
      // v7: bounded in-daemon limits refresh; v16: login-flow expiry + credential landing.
      this.performance.measureSync("daemon.tick.accounts", () => {
        this.accounts?.periodicRefreshTick();
        void this.accounts?.credentialHandoff.reconcile().catch(() => this.log("account.credentials.handoff_reconcile_failed"));
        this.accounts?.centralRefreshRetryTick();
        this.accounts?.centralEarlyRefreshTick();
        this.enforceWeeklyCeilings();
        void this.accounts?.claudeKeychainRepairTick();
      });
      tAccounts = Date.now();
      this.performance.measureSync("daemon.tick.login", () =>
        this.loginFlows?.tick(),
      );
      // v31: at most one automatic retention pass per interval; the pass itself runs off-tick.
      this.retention?.tick();
      // This span covers synchronous auto-title kickoff only; title generation
      // stays detached. Once a second keeps the roster scan off most ticks.
      const autoTitle = this.autoTitle;
      if (autoTitle && tAccounts - this.lastAutoTitleAt >= AUTO_TITLE_SCAN_MS) {
        this.lastAutoTitleAt = tAccounts;
        this.performance.measureSync("daemon.tick.auto_title", () => {
          void autoTitle()
            .then((outcomes) => {
              for (const outcome of outcomes) {
                if (outcome.error) this.log(`autoTitle.error bee=${outcome.beeId} ${outcome.error}`);
              }
            })
            .catch((error) => {
              this.log(`autoTitle.error ${error instanceof Error ? error.message : String(error)}`);
            });
        });
      }
    } catch (err) {
      // A tick error is a bug, never a reason to abandon the node: the loops
      // are idempotent over durable state, so the next tick retries.
      this.tickErrors += 1;
      this.log(`tick.error ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    }
    const tWatch = Date.now();
    this.performance.measureSync("daemon.tick.watch", () =>
      this.flushWatchers(),
    );
    const tEnd = Date.now();
    // Accept-loop starvation attribution (2026-08-21): the daemon is single-
    // threaded, so any slow tick IS an RPC stall. Log the phase breakdown for
    // every tick that would eat a visible slice of a client's timeout budget.
    if (tEnd - t0 >= 250) {
      this.log(
        `tick.slow total=${tEnd - t0}ms step=${tStep - t0}ms accounts=${tAccounts - tStep}ms maintenance=${tWatch - tAccounts}ms flush=${tEnd - tWatch}ms`,
      );
    }
  }

  private flushWatchers(): void {
    const store = this.store;
    const rpc = this.rpc;
    if (!store || !rpc) return;
    const latest = store.lastAuditSeq();
    if (latest > this.publishedSeq) this.publishedSeq = latest;
    // maxBatch+1: one extra row is exactly enough to detect a gap without
    // materializing the backlog (the 2026-08-21 flush stall).
    rpc.flushWatch(latest, (fromSeq, includeHomes) => this.mirrorAuditRows(store.auditRows(fromSeq, this.cfg.watchMaxBatch + 1), includeHomes), this.cfg.watchMaxBatch);
  }

  private mirrorAuditRows(rows: AuditRow[], includeOperatorLocalHomes = false): AuditRow[] {
    const accounts = this.accounts;
    return rows.map((source) => {
      const row = this.publicConfirmationAudit(publicAuditRow(source, includeOperatorLocalHomes));
      if (row.kind === "thread_operation.put") return { ...row, payload: { operation: row.payload.operation } };
      if (!accounts) return row;
      if (row.kind !== "account.put") return row;
      const account = row.payload.account;
      if (!account || typeof account !== "object" || Array.isArray(account)) return row;
      return { ...row, payload: { ...row.payload, account: accounts.mirrorRow(account as AccountRow) } };
    });
  }

  private publicConfirmationAudit(row: AuditRow): AuditRow {
    if (!row.kind.startsWith("mail.confirmation_")) return row;
    const payload = { ...row.payload };
    for (const key of ["wireLine", "digest", "host", "priorDigest"]) delete payload[key];
    for (const key of ["row", "prior"]) {
      const value = payload[key];
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const { wireLine, digest, host, ...visible } = value as Record<string, unknown>;
        payload[key] = visible;
      }
    }
    return { ...row, payload };
  }

  private mirrorAccount(account: AccountRow): MirrorAccountRow {
    return this.mustAccounts().mirrorRow(account);
  }

  // -------------------------------------------------------------------------
  // agents
  // -------------------------------------------------------------------------

  /**
   * The spawn shape for a bee's NEXT runtime. Continuity (spec 07 §F): when
   * the bee row carries a provider session id, the harness is asked to resume
   * it — claude gets `--resume <id>` appended to the agent spec's args, codex
   * gets `thread/resume` in its handshake — so generation N+1 (revive after a
   * stop, scale-to-zero, crash, or an old-world import) continues the same
   * conversation. Per-bee env (the harness config home an imported session
   * lives under) layers over the agent spec env. Per-bee args (schema v5)
   * layer between the agent spec's args and the resume selector — see
   * composeSpawn for the precedence.
   */
  private stampRuntimeCredential(beeId: string, generation: number): void {
    const store = this.store, accounts = this.accounts;
    if (this.stopping || !store || !accounts) return;
    try {
      const runtime = store.currentRuntime(beeId);
      if (runtime?.generation !== generation || runtime.state !== "booting") return;
      const bee = store.getBee(beeId);
      const account = bee?.account ? store.getAccount(bee.account) : null;
      if (!bee || !account) return;
      const material = accounts.authDeathMaterial(account);
      if (material) store.stampRuntimeCredential(beeId, generation, { material, revision: accounts.credentialRevision(account), account: account.id, agent: bee.agent, cwd: bee.cwd, cellId: bee.cellId, controlFence: bee.authControlFence ?? 0 });
    } catch {
      this.log(`auth.material_stamp_unavailable bee=${beeId} gen=${generation}`);
    }
  }

  private resolveSpawnSpec(beeId: string, generation?: number): SpawnSpec {
    if (generation !== undefined) this.stampRuntimeCredential(beeId, generation);
    const store = this.mustStore();
    const bee = store.getBee(beeId);
    if (!bee) throw new Error(`resolve: bee ${beeId} not found`);
    const spec = this.cfg.agents[bee.agent];
    if (!spec) throw new Error(`resolve: no agent spec for '${bee.agent}'`);
    const adapterName = spec.adapter ?? bee.agent;
    const grokMcpServers: GrokMcpServerStdio[] = adapterName === "grok" || adapterName === "kimi" || adapterName === "muse"
      ? liveGateways().map((gateway) => ({
        name: gateway.name,
        command: gateway.shim.command,
        args: [...gateway.shim.args],
        env: Object.entries(gateway.env).map(([name, value]) => ({ name, value })),
      }))
      : [];
    const instructionMove = store.placementInstructionMove(beeId);
    const placementInstruction = instructionMove
      ? placementContextText({
        placementVersion: instructionMove.to.version,
        cwd: instructionMove.to.cwd,
        cellId: instructionMove.retainedCellId,
      })
      : null;
    const composed = composeSpawn(spec, adapterName, bee, grokMcpServers, placementInstruction);
    const operation = store.threadOperationForSuccessor(beeId);
    let adapter = operation && bee.providerSessionId === operation.successorProviderSessionId && adapterName === "codex"
      ? codexAdapter({ cwd: bee.cwd, model: composed.model, modelProvider: operation.source.modelProvider, resumeThreadId: bee.providerSessionId ?? undefined, resumePath: operation.sessionPath })
      : composed.adapter;
    let args = composed.args;
    if (!adapter) throw new Error(`resolve: no adapter for agent '${bee.agent}'`);
    // v7 (spec 08): a bound bee runs in its account's home. The env is derived
    // from the account row. The tracked pre-claim readiness gate has already
    // activated the home and reconciled its native MCP config.
    const env = { ...this.runtimeEnvOf(bee, spec, "resolve"), ...this.beeTmpEnv(bee, spec) };
    if (adapterName === "codex" && bee.providerSessionId && env.CODEX_HOME) {
      const path = codexSwapHistoryPath(env.CODEX_HOME, bee.id, bee.providerSessionId);
      if (existsSync(path)) {
        validateCodexSwapPath(env.CODEX_HOME, path);
        const boundary = pinThreadHistory(path, bee.providerSessionId);
        adapter = codexAdapter({ cwd: bee.cwd, model: composed.model, modelProvider: boundary.modelProvider, resumeThreadId: bee.providerSessionId, resumePath: path });
      }
    }
    // Absence is authoritative too: a root must not inherit a configured parent.
    if (!bee.parentId) delete env.HIVE_PARENT;
    if (adapterName === "claude") {
      const context = this.claudeContextLaunchFor(bee, args, env);
      args = composeArgv(grammarFor("claude"), [args, context.modelArgs]);
      this.applyContextEnv(env, context);
    }
    // F8 — one resolution rule: the bare harness command is resolved to an
    // absolute path at spawn time with the SAME core rule every probe uses
    // (PATH of the exact spawn env, then the fallback dirs). Nothing found
    // keeps the bare name — the OS ENOENT stays the honest diagnostic and
    // the driver's exit detail names the executable.
    const { command, resolution } = resolveSpawnCommand(spec.command, { env });
    if (resolution.source !== "configured_path") {
      this.log(`spawn.resolve bee=${beeId} executable=${resolution.executable} source=${resolution.source}${resolution.path ? ` path=${resolution.path}` : ""}`);
    }
    return {
      adapter,
      command,
      args,
      cwd: bee.cwd,
      env,
      commandResolution: resolution,
    };
  }

  /**
   * Registry-backed Cell layout for a bee. Used after restart to re-hydrate
   * `cellOf` even when the bee has already moved to an HSR checkout and the
   * allocation is retained. Active-source is enforced at spawn and legacy
   * `cell.remove`, not here.
   */
  private resolveCellSpec(beeId: string): CellSpec {
    const store = this.mustStore();
    const bee = store.getBee(beeId);
    if (!bee) throw new Error(`resolveCell: bee ${beeId} not found`);
    if (!bee.cellId) throw new Error(`resolveCell: bee ${beeId} has no cells registry id`);
    const cell = store.getCell(bee.cellId);
    if (!cell || cell.state === "removed") throw new Error(`resolveCell: cell ${bee.cellId} is missing from the registry`);
    const parsed = parseSpaceName(cell.spaceName);
    if (!parsed) throw new Error(`resolveCell: cell ${cell.id} has a malformed space name '${cell.spaceName}'`);
    // v31: an evicted Cell re-provisions where the agent left off (its HEAD
    // was verified reachable from the origin at eviction), not at the spawn sha.
    const sha = cell.state === "evicted" && cell.evictedHead && hasCommit(cell.originRepo, cell.evictedHead)
      ? cell.evictedHead
      : cell.sha;
    return {
      provision: {
        beeId,
        originRepo: cell.originRepo,
        sha,
        wrapper: cell.wrapper,
        repoName: parsed.repoName,
        cellId: parsed.cellId,
      },
      sandbox: cell.sandbox ?? this.cfg.cellSandbox,
    };
  }

  private resolveCellSandboxWritablePaths(beeId: string): readonly SandboxWritableDirectory[] {
    const store = this.mustStore();
    const bee = store.getBee(beeId);
    if (!bee) throw new Error(`resolveCellSandboxWritablePaths: bee ${beeId} not found`);
    const tmp = this.beeTmp ? this.verifiedBeeTmp(beeId) : null;
    const grants: SandboxWritableDirectory[] = tmp ? [{ path: tmp.TMPDIR }, { path: tmp.NODE_COMPILE_CACHE }] : [];
    if (!bee.account) return grants;
    const account = store.getAccount(bee.account);
    if (!account) {
      throw new Error(`resolveCellSandboxWritablePaths: bee ${beeId} is bound to unknown account ${bee.account}`);
    }
    if (this.mustAccounts().isNative(account)) return grants;
    return [...grants, sandboxWritableDirectory(account.homePath, {
      forbiddenDirectories: [this.cfg.accounts.homesDir],
    })];
  }

  private verifiedBeeTmp(beeId: string): { TMPDIR: string; NODE_COMPILE_CACHE: string } {
    try {
      return ensureBeeTmpEnv(this.beeTmp!, beeId, (path, was) => this.log(`tmp.replaced bee=${beeId} path=${path} was=${was}`));
    } catch (err) {
      this.log(`tmp.unsafe bee=${beeId} error=${JSON.stringify(err instanceof Error ? err.message : String(err))}`);
      throw err;
    }
  }

  private beeTmpEnv(bee: BeeRow, spec: AgentSpecConfig): Record<string, string> {
    if (!this.beeTmp) return {};
    const env = this.verifiedBeeTmp(bee.id);
    const overridden = (["TMPDIR", "NODE_COMPILE_CACHE"] as const)
      .filter((key) => (bee.env[key] ?? spec.env?.[key]) !== undefined && (bee.env[key] ?? spec.env?.[key]) !== env[key]);
    if (overridden.length > 0 && !this.beeTmpOverrideLogged.has(bee.id)) {
      this.beeTmpOverrideLogged.add(bee.id);
      this.log(`tmp.env_overridden bee=${bee.id} keys=${overridden.join(",")} by=bees.tmpRoot`);
    }
    return env;
  }

  private removeBeeTmp(beeId: string): boolean {
    if (!this.beeTmp) return false;
    const removed = removeBeeTmpDir(this.beeTmp, beeId);
    this.log(`tmp.bee_removed bee=${beeId} ok=${removed}`);
    return removed;
  }

  private sweepBeeTmpAtBoot(store: CoreStore): void {
    if (!this.beeTmp) return;
    const released: string[] = [];
    for (const bee of store.listBees()) {
      const rt = store.currentRuntime(bee.id);
      if (bee.lifecycle === "archived" && (!rt || rt.state === "stopped")) released.push(bee.id);
    }
    const removed = sweepBeeTmpDirs(this.beeTmp, released);
    if (removed.length > 0) this.log(`tmp.boot_sweep removed=${removed.length}`);
  }

  /**
   * Tmux TUI spawn: same account/home env as HSR, but the interactive CLI
   * (no headless plumbing args) plus the harness transcript locator.
   */
  private resolveTmuxSpec(beeId: string, generation?: number): ReturnType<typeof tmuxSpawnSpec> {
    if (generation !== undefined) this.stampRuntimeCredential(beeId, generation);
    const store = this.mustStore();
    const bee = store.getBee(beeId);
    if (!bee) throw new Error(`resolveTmux: bee ${beeId} not found`);
    const spec = this.cfg.agents[bee.agent];
    if (!spec) throw new Error(`resolveTmux: no agent spec for '${bee.agent}'`);
    const env = { ...this.runtimeEnvOf(bee, spec, "resolveTmux"), ...this.beeTmpEnv(bee, spec) };
    // Absence is authoritative too: a root must not inherit a configured parent.
    if (!bee.parentId) delete env.HIVE_PARENT;
    let beeArgs = bee.args;
    if ((spec.adapter ?? bee.agent) === "claude") {
      const context = this.claudeContextLaunchFor(bee, bee.args ?? [], env);
      beeArgs = composeArgv(grammarFor("claude"), [bee.args, context.modelArgs]);
      this.applyContextEnv(env, context);
    }
    // Same F8 resolution rule as HSR: the TUI seat must not ENOENT on a CLI
    // the node's probes can see.
    const { command, resolution } = resolveSpawnCommand(spec.command, { env });
    if (resolution.source !== "configured_path") {
      this.log(`spawn.resolve bee=${beeId} executable=${resolution.executable} source=${resolution.source}${resolution.path ? ` path=${resolution.path}` : ""}`);
    }
    return tmuxSpawnSpec({ ...spec, command }, { agent: bee.agent, cwd: bee.cwd, args: beeArgs, env });
  }

  private retainProcessIdentity(beeId: string, generation: number): void {
    if (!this.identityRecovery.has(beeId, generation)) this.identityRecovery.retain({beeId, generation, since: this.mustStore().runtimeIdentityUnresolvedSince(beeId, generation)});
    this.core?.retainProcessIdentity(beeId, generation);
  }

  private retryProcessIdentities(): void {
    if (this.stopping || !this.driver || !this.core) return;
    const store = this.mustStore();
    this.identityRecovery.retry(Date.now(), row => {
      let rt = store.currentRuntime(row.beeId);
      if (!rt || rt.generation !== row.generation || rt.state === "stopped") { this.core!.resolveProcessIdentity(row.beeId, row.generation); return true; }
      const captured = this.driver!.procOf(row.beeId, row.generation);
      if (captured && (rt.pid == null || rt.pidStartedAt == null || captured.processIdentity && store.runtimeProcessIdentity(row.beeId, row.generation).kind === "unavailable")) {
        store.recordRuntimeProc(row.beeId, row.generation, captured);
        rt = store.currentRuntime(row.beeId)!;
        if (rt.pid == null || rt.pidStartedAt == null) return false;
        if (rt.state === "stopped") { this.core!.resolveProcessIdentity(row.beeId, row.generation); return true; }
      }
      if (rt.pid == null || rt.pidStartedAt == null) return false;
      const value = inspectProcess(rt.pid), binding = store.runtimeProcessIdentity(row.beeId, row.generation);
      if (binding.kind === "bound" && (value.kind === "gone" || sameProcess(binding.identity, value) && value.state === "zombie")) {
        store.updateRuntimeState(row.beeId, row.generation, "stopped", {exitCause: "machine_restart"});
        this.core!.resolveProcessIdentity(row.beeId, row.generation); return true;
      }
      this.driver!.retryProcessIdentity(row.beeId, row.generation);
      if (!this.driver!.hasProcess(row.beeId, row.generation)) this.driver!.adopt(row.beeId, row.generation, rt.pid, rt.pidStartedAt, rt.state, store.runtimeObservationCursor(row.beeId, row.generation));
      const fresh = store.runtimeProcessIdentity(row.beeId, row.generation);
      if (fresh.kind === "bound" && sameProcess(fresh.identity, inspectProcess(rt.pid)) && this.driver!.hasProcess(row.beeId, row.generation)) { this.core!.resolveProcessIdentity(row.beeId, row.generation); return true; }
      return false;
    });
    const counts = this.identityRecovery.counts(Date.now());
    if (counts.overdue && Date.now() - this.identityWarningAt >= 60000) { this.identityWarningAt = Date.now(); this.log(`doctor.process_identity_unresolved count=${counts.overdue}`); }
  }

  private adoptSurvivors(store: CoreStore, driver: SubstrateRouter): Array<{beeId: string; generation: number}> {
    const unresolved: Array<{beeId: string; generation: number}> = [];
    for (const bee of store.listBees()) {
      const rt = store.currentRuntime(bee.id);
      if (!rt || rt.pid == null || rt.pidStartedAt == null) continue;
      const pendingMove = bee.activeMoveId != null;
      if (rt.state === "stopped" && !pendingMove) continue;
      const lastKnownState =
        rt.state === "booting" || rt.state === "running" || rt.state === "idle" ? rt.state : undefined;
      const observationCursor = store.runtimeObservationCursor(bee.id, rt.generation);
      const adopted = driver.adopt(
        bee.id,
        rt.generation,
        rt.pid,
        rt.pidStartedAt,
        lastKnownState,
        observationCursor,
        bee.providerSessionId,
      );
      // A degraded adoption keeps the exact pid but has no evidence lane: the
      // bee can never leave its adopted phase on its own. Say so at boot.
      const binding = store.runtimeProcessIdentity(bee.id, rt.generation);
      const observed = inspectProcess(rt.pid);
      const exactLive = binding.kind === "bound" && sameProcess(binding.identity, observed) && observed.state === "live";
      const exactExited = binding.kind === "bound" && (observed.kind === "gone" || sameProcess(binding.identity, observed) && observed.state === "zombie");
      if (!exactLive && !exactExited || !adopted && !exactExited) unresolved.push({beeId: bee.id, generation: rt.generation});
      const degraded = adopted && driver.isDegraded(bee.id, rt.generation);
      this.log(`boot.adopt bee=${bee.id} gen=${rt.generation} pid=${rt.pid} ok=${adopted}${degraded ? " degraded=true" : ""}`);
    }
    if (unresolved.length) this.log(`doctor.runtime_identity unresolved=${unresolved.length}`);
    return unresolved;
  }

  // -------------------------------------------------------------------------
  // telemetry + log
  // -------------------------------------------------------------------------

  private log(op: string, recentOp = op): void {
    if (this.opLog.length >= 4000) this.opLog.shift();
    this.opLog.push(recentOp);
    try {
      appendFileSync(this.cfg.logPath, `${JSON.stringify({ ts: Date.now(), op })}\n`);
    } catch {
      // Logging must never take the daemon down.
    }
  }

  private recordI1(v: I1ViolationEvent): void {
    const ops = this.opLog.slice(-OP_LOG_TAIL);
    const fresh = this.telemetry?.recordI1(v, ops) ?? false;
    if (fresh) this.log(`i1_violation ${formatI1Violation(v, ops)}`, `i1_violation bee=${v.beeId} msg=${v.messageId} deadline=${v.deadline}`);
  }

  // -------------------------------------------------------------------------
  // RPC verbs
  // -------------------------------------------------------------------------

  private mustStore(): CoreStore {
    if (!this.store || this.stopping) throw new RpcError("node_stopped", "daemon is shutting down");
    return this.store;
  }

  private numberParam(params: Record<string, unknown>, key: string): number {
    const v = params[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
      throw new RpcError("invalid_request", `param '${key}' must be a positive integer`);
    }
    return v;
  }

  private param(params: Record<string, unknown>, key: string): string {
    const v = params[key];
    if (typeof v !== "string" || v.length === 0) {
      throw new RpcError("invalid_request", `param '${key}' must be a non-empty string`);
    }
    return v;
  }

  /** Pre-owner v2 clients sent only the node-local message id. */
  private mailMutationBeeId(
    params: Record<string, unknown>,
    messageId: number,
    verb: "mail.cancel" | "mail.expedite",
  ): string {
    if (params.beeId !== undefined) return this.param(params, "beeId");
    const message = this.mustStore().getMessage(messageId);
    if (!message) throw new RpcError("invalid_request", `${verb}: message not_found`);
    return message.beeId;
  }

  private async rpcFencedSpawn(params: Record<string, unknown>, conn: RpcConn) {
    if (conn.executionCoordinatorUid === undefined) throw new RpcError("caller_not_trusted", "Execution requires a protected coordinator");
    const begun = this.mustStore().beginFencedSpawn(params, conn.executionCoordinatorUid);
    if (begun.fresh) {
      try { await this.rpcSpawnWithAccount({ ...begun.request.args, idempotencyKey: begun.request.idempotencyKey }, begun.request); }
      catch { this.mustStore().markSpawnUnknown(begun.request.idempotencyKey); throw new ExecutionFenceError("rpc_execution_history_unknown","Spawn preparation may have committed; reconcile the original execution"); }
    }
    return this.mustStore().resolveExecution(params, conn.executionCoordinatorUid);
  }

  private rpcExecution(verb: RpcVerb, params: Record<string, unknown>, conn: RpcConn): unknown {
    switch (verb) {
      case "rpc.execution.coordinator.register":
        if (Object.keys(params).length !== 1 || !Object.hasOwn(params, "issuerId")) throw new RpcError("invalid_request", "Coordinator registration requires issuerId only");
        if (conn.executionCoordinatorUid === undefined) throw new RpcError("caller_not_trusted", "Execution requires an authenticated local coordinator");
        return this.mustStore().registerExecutionCoordinator(params.issuerId, conn.executionCoordinatorUid);
      case "rpc.execution.claim.compareAndSet":
        if (conn.executionCoordinatorUid === undefined) throw new RpcError("caller_not_trusted", "Execution requires an authenticated local coordinator");
        return this.mustStore().compareAndSetExecutionClaim(params, conn.executionCoordinatorUid);
      case "rpc.execution.resolve":
        if (conn.executionCoordinatorUid === undefined) throw new RpcError("caller_not_trusted", "Execution requires an authenticated local coordinator");
        return this.mustStore().resolveExecution(params, conn.executionCoordinatorUid);
      case "rpc.execution.execute": {
        if (params.verb === "spawn") return this.rpcFencedSpawn(params, conn);
        if (conn.executionCoordinatorUid === undefined) throw new RpcError("caller_not_trusted", "Execution requires an authenticated local coordinator");
        const receipt = this.mustStore().executeWithFence(params, conn.executionCoordinatorUid, request => {
          const result = request.verb === "send" ? this.rpcSend(request.args) : this.rpcEnqueue("archive", request.resource.beeId, {}, { idempotencyKey: request.idempotencyKey });
          return { commandId: result.commandId, result };
        });
        if (receipt.status === "refused_stale") throw new ExecutionFenceError("rpc_execution_stale", "Archive execution was refused as stale", { executionReceipt: receipt });
        this.requestTick();
        return { ...this.mustStore().effectCoverage(), admissionReceipt: this.mustStore().lookupRpcResult(receipt.idempotencyKey), executionReceipt: receipt };
      }
      default: throw new RpcError("rpc_execution_fence_unsupported", "Unsupported execution-fence verb");
    }
  }

  private dispatch(verb: RpcVerb, params: Record<string, unknown>, conn: RpcConn): unknown {
    assertConfinedVerb(verb, conn.confinement ?? "unknown");
    if (params.automationKind !== undefined || params.automationRef !== undefined) {
      if (verb !== "send") throw new RpcError("automation_unauthorized", "Automation metadata is only valid for send");
      assertAutomationSend(params, conn);
      if (conn.automationReference) params = { ...params, [AUTOMATION_REFERENCE]: conn.automationReference };
    }
    if (verb.startsWith("rpc.execution.")) throw new RpcError("rpc_execution_fence_unsupported", "Execution fencing is dark: local coordinator installation is NOT_COVERED");
    if (verb === "send" || verb === "spawn") {
      if (conn.phoneOrigin) {
        if (typeof params.idempotencyKey !== "string" || !params.idempotencyKey.length) throw new RpcError("invalid_request", "Phone admission requires idempotencyKey");
        const origin = parsePhoneOrigin(conn.phoneOrigin);
        if (verb === "spawn" && params.prompt != null && typeof params.prompt !== "string") throw new RpcError("invalid_request", "Phone prompt must be a string or absent");
        if (verb === "spawn" && params.prompt === "") throw new RpcError("invalid_request", "An explicit empty phone prompt is invalid; omit prompt for a promptless operation");
        if (verb === "spawn" && origin.contentKind !== "initial-prompt" && origin.contentKind !== "crew-bio" || verb === "send" && origin.contentKind === "initial-prompt") throw new RpcError("invalid_request", "Phone content kind differs from operation");
        params = { ...params, [PHONE_CONTEXT]: origin, [PHONE_LANE]: "envelope-v1", [PHONE_CARRIER_DIGEST]: conn.phoneCarrierDigest };
      } else params = { ...params, [PHONE_LANE]: conn.phoneLane ?? "legacy" };
      (params as Record<PropertyKey, unknown>)[PHONE_DIGEST] = this.phoneRequestBinding(params).digest;
      this.checkPhoneRequestBinding(verb, params);
    }
    assertLocalHandoffRpc(verb, params, conn);
    this.assertNotForeignHarnessStart(verb, params, conn);
    if (typeof params.beeId === "string" && ["stop", "revive", "archive", "bee.swapAccount", "bee.setArgs", "bee.reconfigure", "bee.move", "bee.handoff", "bee.fork", "bee.interrupt"].includes(verb)) {
      const operation = this.mustStore().threadOperationForSuccessor(params.beeId);
      if (operation && operation.phase !== "ready") throw new RpcError("thread_busy", "Successor execution is owned by its thread operation; recover it with thread.operation.retry");
    }
    if (verb === "bee.fork") for (const key of Object.keys(params)) if (!["beeId", "name", "id", "idempotencyKey", "allocationContext", "allocationClaim"].includes(key)) throw new RpcError("thread_unsupported", `Fork is a plain copy and does not accept '${key}'`);
    if (typeof params.idempotencyKey === "string" && verb !== "thread.fork" && verb !== "thread.handoff" && this.mustStore().threadOperationByKey(params.idempotencyKey)) throw new RpcError("idempotency_conflict", "Key belongs to a thread operation");
    if (!verb.startsWith("rpc.execution.") && verb !== "rpc.effect.resolve" && typeof params.idempotencyKey === "string") {
      const reconnect = this.mustStore().getCommandByIdempotencyKey(params.idempotencyKey);
      if (reconnect?.verb === "reconnect_tools" && (verb !== "bee.reconnectTools" || reconnect.beeId !== params.beeId)) throw new RpcError("idempotency_conflict", "Key belongs to a reconnect command");
      const prior = this.mustStore().lookupRpcResult(params.idempotencyKey);
      if (prior && (verb === "thread.operation.retry" || prior.verb === "thread.operation.retry")
        && (prior.verb !== verb || (prior.result as { operation?: { id?: string } }).operation?.id !== params.operationId)) {
        throw new RpcError("idempotency_conflict", "Retry key is already bound to a different operation");
      }
    }
    if (verb === "delete" && typeof params.beeId === "string") {
      const operation = this.mustStore().threadOperationForSuccessor(params.beeId);
      if (operation && ((operation.phase !== "ready" && operation.phase !== "failed") || (operation.worker && pidAlive(operation.worker.pid)))) throw new RpcError("thread_busy", "Thread operation still owns execution; wait for settlement before deletion");
    }
    switch (verb) {
      case "rpc.effect.status":
        if (Object.keys(params).length) throw new RpcError("invalid_request", "Effect status takes no parameters");
        return this.mustStore().effectCoverage();
      case "rpc.effect.resolve": {
        if (Object.keys(params).some(key => key !== "verb" && key !== "idempotencyKey")) throw new RpcError("invalid_request", "Unexpected effect resolve parameter");
        const target = effectVerb(params.verb), key = this.idempotencyKeyOf(params);
        if (!key) throw new RpcError("invalid_request", "Effect resolve requires idempotencyKey");
        const pending = this.effectInFlight?.get(key);
        if (pending && pending.verb !== target) throw new RpcError("idempotency_conflict", "Key belongs to an in-flight spawn");
        return this.mustStore().resolveEffect(key, target, pending !== undefined);
      }
      case "humanRef.status":
        return { installationId: this.mustStore().humanRefInstallationId(), issuer: this.mustStore().humanRefIssuer() };
      case "humanRef.enroll":
        // Enrollment itself is permanently idempotent, independent of the
        // bounded RPC receipt cache. Conflicting retries must always refuse.
        return this.mustStore().enrollHumanRefs(params.receipt);
      case "humanRef.registry.status":
        return { registry: this.mustStore().humanRefRegistry() };
      case "humanRef.registry.init":
        return this.mustStore().initHumanRefRegistry();
      case "humanRef.registry.reserve":
        return this.mustStore().reserveHumanRefNamespace(this.param(params, "installationId"));
      case "spawn":
        this.assertApiaryTagWriter(verb, params);
        // The start command is due now; do not wait out the tick cadence.
        return this.releasingRefusedClaim(() => this.rpcSpawnEffect(this.authenticatedSpawnParams(params, conn))).then((result) => { this.requestTick(); return result; });
      case "quota.recovery.wait": {
        const id = this.param(params, "quotaRecoveryId");
        const row = this.mustStore().getQuotaRecovery(id);
        if (!row || row.state !== "waiting" || !this.mustStore().quotaRecoveryValid(row)) throw new RpcError("invalid_request", "quota recovery is no longer waiting");
        const retryAt = params.retryAt;
        if (retryAt !== null && (typeof retryAt !== "number" || !Number.isFinite(retryAt) || retryAt <= Date.now())) throw new RpcError("invalid_request", "retryAt must be null or a future epoch timestamp");
        const reason = this.param(params, "reason");
        if (!["allocation_owner_required", "account_wait", "account_unavailable", "autoswap_disabled"].includes(reason)) throw new RpcError("invalid_request", "invalid quota wait reason");
        const detail = params.reasonDetail;
        if (detail !== undefined && detail !== null && !["operation_in_progress", "unavailable", "credential_login_required", "lease_needs_operator", "paused"].includes(String(detail))) throw new RpcError("invalid_request", "invalid quota wait reasonDetail");
        this.mustStore().waitQuotaRecovery(id, this.quotaRetryAt(row.beeId, retryAt as number | null), reason, reason === "account_unavailable" ? (detail ?? "unavailable") as import("../../core/src/types.ts").QuotaRecoveryReasonDetail : null);
        return { recovery: this.mustStore().getQuotaRecovery(id) };
      }
      case "bee.swapAccount":
        return this.releasingRefusedClaim(() => this.rpcSwapAccountWithAdmission(params));
      case "config.get":
        return this.rpcConfigGet();
      case "config.patch":
        return this.withIdempotency(verb, params, () => this.rpcConfigPatch(params));
      case "contextPolicy.get":
        return this.rpcContextPolicyGet(params);
      case "contextPolicy.set":
        return this.withIdempotency(verb, params, () => this.rpcContextPolicySet(params));
      case "naming.usage":
        return { usage: this.mustStore().namingUsageSummary() };
      case "account.list":
        return this.rpcAccountList(params);
      case "account.get":
        return this.rpcAccountGet(params);
      case "account.add":
        return this.rpcAccountAdd(params);
      case "account.config.preview":
        return this.rpcAccountConfigPreview(params);
      case "account.config.import":
        return this.rpcAccountConfigImport(params);
      case "account.remove":
        return this.rpcAccountRemove(params, conn);
      case "account.pause":
        return this.withIdempotency(verb, params, () => this.rpcAccountPause(params));
      case "account.unpause":
        return this.withIdempotency(verb, params, () => this.rpcAccountUnpause(params));
      case "account.setPenalty":
        return this.withIdempotency(verb, params, () => this.rpcAccountSetPenalty(params));
      case "account.setWeeklyCeiling":
        return this.withIdempotency(verb, params, () => this.rpcAccountSetWeeklyCeiling(params));
      case "account.login":
      case "account.login.start":
        return this.rpcAccountLoginStart(params);
      case "account.login.get":
        return this.rpcAccountLoginGet(params);
      case "account.login.selectMethod":
        return this.rpcAccountLoginSelectMethod(params);
      case "account.login.submit":
        return this.rpcAccountLoginSubmit(params);
      case "account.login.retry":
        return this.rpcAccountLoginRetry(params);
      case "account.login.cancel":
        return this.withIdempotency(verb, params, () => this.rpcAccountLoginCancel(params));
      case "account.credentials.export":
        return this.mustAccounts().credentialHandoff.export(params);
      case "account.credentials.releasePeer":
        return this.mustAccounts().credentialHandoff.releasePeer(params);
      case "account.credentials.adoptPrepare":
        return this.mustAccounts().credentialHandoff.adoptPrepare(params);
      case "account.credentials.exportPrepare":
        return this.mustAccounts().credentialHandoff.exportPrepare(params);
      case "account.credentials.exportCommit":
        return this.mustAccounts().credentialHandoff.exportCommit(params);
      case "account.credentials.adoptAbort":
        return this.mustAccounts().credentialHandoff.adoptAbort(params);
      case "account.credentials.adopt":
        return this.mustAccounts().credentialHandoff.adopt(params);
      case "account.credentials.exportAbort":
        return this.mustAccounts().credentialHandoff.exportAbort(params);
      case "account.credentials.exportSettle":
        return this.mustAccounts().credentialHandoff.exportSettle(params);
      case "account.credentials.exportConfirm":
        return this.mustAccounts().credentialHandoff.exportConfirm(params);
      case "account.credentials.standDown":
        return this.mustAccounts().credentialHandoff.standDown(params);
      case "account.credentials.handoffIdentitySet":
        return this.mustAccounts().credentialHandoff.setIdentity(params);
      case "account.credentials.standDownReceipt":
        return this.mustAccounts().credentialHandoff.standDownReceipt(params);
      case "account.credentials.operatorTakeover":
        return this.mustAccounts().credentialHandoff.operatorTakeover(params);
      case "account.credentials.operatorTakeoverApply":
        return this.mustAccounts().credentialHandoff.operatorTakeoverApply(params);
      case "account.credentials.operatorTakeoverComplete":
        return this.mustAccounts().credentialHandoff.operatorTakeoverComplete(params);
      case "account.credentials.operatorTakeoverCancel":
        return this.mustAccounts().credentialHandoff.operatorTakeoverCancel(params);
      case "account.credentials.handoffKeyRotate":
        return this.mustAccounts().credentialHandoff.rotateKey(params);
      case "account.credentials.handoffStatus":
        return this.mustAccounts().credentialHandoff.status(params);
      case "account.credentials.nativeBackup":
        return this.mustAccounts().nativeBackupStatus(this.requireAccount(params));
      case "account.credentials.restoreNative": {
        return this.mustAccounts().restoreNativeBackup(this.requireAccount(params).id, conn.ingress === "local_unix").then(result => ({ ...result, account: this.mirrorAccount(result.account) }));
      }
      case "account.credentials.status": {
        const account = this.requireAccount(params);
        const authority = this.mustAccounts().authorityFor(account);
        if (!authority) return { supported: false };
        const state = authority.status(account);
        return state && state.phase !== "disabled" ? { ...state, supported: true }
          : { supported: true, phase: "native", generation: null, expiresAt: null };
      }
      case "account.credentials.enable":
      case "account.credentials.refresh":
      case "account.credentials.disable":
        return this.withAsyncIdempotency(verb, params, async () => {
          const account = this.requireAccount(params);
          this.mustAccounts().assertLocalAccount(account);
          if (account.harness === "muse" && conn.ingress !== "local_unix") throw new RpcError("account_unavailable", "Muse credential minting requires the authority's local Unix socket.", { reason: "local_required" });
          const authority = this.mustAccounts().authorityFor(account);
          if (!authority) throw new RpcError("account_unavailable", `Central credential management is not supported for ${account.harness}.`);
          try {
            if (verb === "account.credentials.enable") return await authority.enable(account);
            if (verb === "account.credentials.disable") return await authority.disable(account);
            const key = this.idempotencyKeyOf(params);
            if (!key) throw new RpcError("invalid_request", "Central refresh requires an idempotency key.");
            return await authority.ensure(account, 0, key);
          } catch (error) {
            if (error instanceof RpcError) throw error;
            if (account.harness === "muse" && error instanceof CredentialAuthorityError) throw new RpcError("account_unavailable", error.message, credentialErrorDetails(error));
            throw new RpcError("account_unavailable", error instanceof Error ? error.message : "Credential operation failed");
          }
        });
      case "account.capture":
        return this.rpcAccountCapture(params);
      case "account.credentialsRestored":
        return this.rpcAccountCredentialsRestored(params);
      case "account.interruptions":
        return this.rpcAccountInterruptions(params);
      case "account.verify":
        return this.rpcAccountVerify(params);
      case "account.limits.observe":
        return applyObservation(this.mustStore(), params, this.accountIdParam(params));
      case "account.limits.observation":
        return observationReadRequest(this.mustStore(),params);
      case "account.limits.observation.discard":
        return discardObservation(this.mustStore(),params,this.accountIdParam(params));
      case "account.limits":
        return this.rpcAccountLimits(params);
      case "account.resetLimits":
        return this.rpcAccountResetLimits(params);
      case "account.importRegistry":
        return this.withIdempotency(verb, params, () => this.rpcAccountImportRegistry(params));
      case "account.backfill":
        return this.withIdempotency(verb, params, () => this.rpcAccountBackfill(params));
      // SENSITIVE — deliberately NO idempotency wrapper: recording the result
      // would persist secret bytes in the store. The result is the only place
      // the lease material appears.
      case "account.lease":
        return this.rpcAccountLease(params);
      case "account.lease.export":
        return this.mustAccounts().exportLeasedMaterial(this.accountIdParam(params));
      case "account.lease.install":
        return this.rpcAccountLeaseInstall(params, conn);
      case "account.lease.remove": {
        const id = this.accountIdParam(params);
        for (const key of ["checkOnly", "discardNative", "confirm"]) if (params[key] !== undefined && typeof params[key] !== "boolean") throw new RpcError("invalid_request", `${key} must be a boolean.`);
        return this.mustAccounts().removeLease(id, { checkOnly: params.checkOnly === true, discardNative: params.discardNative === true, confirm: params.confirm === true });
      }
      case "account.activity":
        return this.rpcAccountActivity(params);
      case "account.admission.acquire":
        return this.rpcAccountAdmissionAcquireWithRefresh(params);
      case "account.admission.confirm":
        return this.withIdempotency(verb, params, () => this.rpcAccountAdmissionConfirm(params));
      case "account.admission.release":
        return this.withIdempotency(verb, params, () => this.rpcAccountAdmissionRelease(params));
      case "mail.batching.get":
      case "mail.batching.set": {
        if (!conn.automationAuthority || conn.ingress !== "local_unix" || conn.authenticatedBeeId !== undefined || conn.humanChat !== undefined || conn.phoneOrigin !== undefined || conn.phoneLane !== undefined) throw new RpcError("automation_unauthorized", "Batching policy requires the registered direct local Apiary authority");
        const beeId = this.requireBee(params);
        if (verb === "mail.batching.get") return this.mustStore().mailBatchingPolicy(beeId);
        if (typeof params.enabled !== "boolean") throw new RpcError("invalid_request", "enabled must be boolean");
        if (params.enabled && this.mustStore().getBee(beeId)?.substrate === "tmux") throw new RpcError("mail_batching_unsupported", "tmux cannot guarantee fresh digest turns");
        return this.withIdempotency(verb, params, () => this.mustStore().setMailBatchingPolicy(beeId, params.enabled as boolean));
      }
      case "mail.batch.resolve": {
        if (!conn.automationAuthority) throw new RpcError("automation_unauthorized","Batch resolution requires the registered authority");
        const beeId = this.requireBee(params), batchId = this.param(params,"batchId"), generation = this.numberParam(params,"generation"), key = this.param(params,"idempotencyKey");
        if (params.action !== "resend_anyway" && params.action !== "drop") throw new RpcError("invalid_request","Invalid group resolution action");
        return this.withIdempotency(verb,params,() => this.mustStore().resolveMailBatch(beeId,batchId,generation,params.action as "resend_anyway" | "drop",key));
      }
      case "mail.batch.read": {
        if (conn.ingress !== "local_unix" || conn.humanChat !== undefined || conn.phoneOrigin !== undefined || conn.phoneLane !== undefined
          || (conn.authenticatedBeeId !== undefined ? conn.authenticatedBeeId !== params.beeId : !conn.automationAuthority)) throw new RpcError("caller_not_trusted", "Batch reads require the registered direct local Apiary authority or the authenticated owning bee.");
        const beeId = this.requireBee(params);
        const batchId = this.param(params, "batchId");
        const messageId = this.numberParam(params, "messageId");
        const offset = params.offset === undefined ? 0 : params.offset;
        const limit = params.limit === undefined ? 16384 : params.limit;
        if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0
          || typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0 || limit > 16384) throw new RpcError("invalid_request", "Invalid UTF-8 page offset or limit");
        const field = params.field ?? "body";
        if (field !== "body" && field !== "sender") throw new RpcError("invalid_request","Invalid batch field");
        return this.mustStore().readMailBatch(beeId, batchId, messageId, offset, limit, field);
      }
      case "mail.humanFirst.get":
        return this.mustStore().humanFirstPolicy(this.requireBee(params));
      case "mail.humanFirst.set":
        if (!conn.humanPolicyAuthority) throw new RpcError("human_chat_unauthorized", "Policy changes require the registered Apiary authority");
        if (typeof params.enabled !== "boolean") throw new RpcError("invalid_request", "enabled must be boolean");
        if (params.enabled && this.mustStore().getBee(this.requireBee(params))?.substrate === "tmux") throw new RpcError("human_first_unsupported", "tmux cannot guarantee fresh human turns");
        return this.mustStore().setHumanFirstPolicy(this.requireBee(params), params.enabled);
      case "send":
        if (conn.humanChat?.humanFirst === true && this.mustStore().getBee(this.param(params, "beeId"))?.substrate === "tmux") throw new RpcError("human_first_unsupported", "tmux cannot guarantee fresh human turns");
        this.mustStore().assertHumanChatBinding(conn.humanChat, this.param(params, "body"), this.param(params, "beeId"), this.idempotencyKeyOf(params) ?? undefined);
        return this.withIdempotency(verb, params, () => this.rpcSend(params, conn.humanChat));
      case "mail.cancel": {
        const messageId = this.numberParam(params, "messageId");
        return this.withIdempotency(verb, params, () => {
          // Direct mailbox mutation (like send): cancel an undelivered message.
          const res = this.mustStore().cancelMessage(
            this.mailMutationBeeId(params, messageId, verb),
            messageId,
          );
          if (!res.canceled) throw new RpcError(res.reason === "batch_frozen" ? "batch_frozen" : "invalid_request", `mail.cancel: message ${res.reason}`);
          return res;
        });
      }
      case "mail.delivery.resend_anyway":
      case "mail.delivery.drop": {
        const keys = Object.keys(params);
        if (keys.some(key => !["beeId", "messageId", "generation", "idempotencyKey"].includes(key))) throw new RpcError("invalid_request", "Unknown delivery resolution parameter");
        const beeId = this.param(params, "beeId");
        const messageId = this.numberParam(params, "messageId");
        const generation = this.numberParam(params, "generation");
        const idempotencyKey = this.param(params, "idempotencyKey");
        if (!Number.isSafeInteger(messageId) || messageId <= 0 || !Number.isSafeInteger(generation) || generation <= 0
          || !idempotencyKey.trim() || idempotencyKey.length > 256) throw new RpcError("invalid_request", "Invalid delivery resolution parameters");
        const result = this.mustStore().resolveDeliveryConfirmation({
          action: verb === "mail.delivery.drop" ? "drop" : "resend_anyway", beeId, messageId, generation, idempotencyKey,
        });
        this.requestTick();
        return result;
      }
      case "mail.expedite": {
        const messageId = this.numberParam(params, "messageId");
        const urgency = this.param(params, "urgency");
        if (!(MESSAGE_URGENCIES as readonly string[]).includes(urgency)) {
          throw new RpcError("invalid_request", `mail.expedite: urgency must be one of ${MESSAGE_URGENCIES.join("|")}`);
        }
        return this.withIdempotency(verb, params, () => {
          const res = this.mustStore().expediteMessage(
            this.mailMutationBeeId(params, messageId, verb),
            messageId,
            urgency as Urgency,
          );
          if (!res.applied) throw new RpcError(res.reason === "batch_frozen" ? "batch_frozen" : "invalid_request", `mail.expedite: message ${res.reason}`);
          return res;
        });
      }
      case "stop":
        return this.withIdempotency(verb, params, () =>
          this.rpcEnqueue("stop", this.param(params, "beeId"), { cause: "stopped_by_user" }, params),
        );
      case "revive": {
        const bee = this.mustStore().getBee(this.param(params, "beeId"));
        const account = bee?.account ? this.mustStore().getAccount(bee.account) : null;
        if (account?.source === "leased" && knownAccountLease(account)?.revokedAt != null) {
          const readiness = this.mustAccounts().credentialReadiness(account);
          if (!readiness.ready) throw new RpcError(readiness.code, readiness.message, { account: account.id });
        }
        return this.withIdempotency(verb, params, () =>
          this.rpcEnqueue(
            "revive",
            this.param(params, "beeId"),
            params.args === undefined ? {} : { args: this.argsParam(params, "revive", true) },
            params,
          ),
        );
      }
      case "bee.setArgs":
        return this.withIdempotency(verb, params, () => this.rpcSetArgs(params));
      case "bee.reconfigure":
        // Observation drain must commit outside the idempotency transaction:
        // a refusal must not roll back facts already consumed from the driver.
        this.core?.observe();
        return this.withIdempotency(verb, params, () => {
          const beeId = this.requireBee(params);
          const args = this.argsParam(params, "bee.reconfigure", true);
          return this.mustStore().reconfigureBee(beeId, args);
        });
      case "cell.capture":
        return this.withIdempotency(verb, params, () => this.rpcCellCapture(params));
      case "cell.remove":
        return this.withIdempotency(verb, params, () => this.rpcCellRemove(params));
      case "bee.move":
        return this.rpcBeeMove(params);
      case "bee.move.get":
        return this.rpcBeeMoveGet(params);
      case "bee.handoff":
        // Observation drain must commit outside the admission transaction: a
        // refusal must not roll back facts already consumed from the driver.
        this.core?.observe();
        return this.releasingRefusedClaim(() => this.rpcBeeHandoffWithAdmission(params));
      case "bee.handoff.get":
        return this.rpcBeeHandoffGet(params);
      case "action.enqueue":
        return this.rpcActionEnqueue(params);
      case "action.get":
        return this.rpcActionGet(params);
      case "action.list":
        return this.rpcActionList(params);
      case "action.definitions":
        return { definitions: [...BUILTIN_ACTION_DEFINITIONS] } satisfies ActionDefinitionsResult;
      case "action.cancel":
        return this.withIdempotency(verb, params, () => this.rpcActionCancel(params));
      case "action.reorder":
        return this.withIdempotency(verb, params, () => this.rpcActionReorder(params));
      case "action.retry":
        return this.withIdempotency(verb, params, () => this.rpcActionRetry(params));
      case "action.complete":
        return this.withIdempotency(verb, params, () => this.rpcActionComplete(params));
      case "action.queue.get":
        return { queue: this.actionQueueView(this.mustStore(), this.requireBee(params)) } satisfies ActionQueueGetResult;
      case "action.queue.pause":
        return this.withIdempotency(verb, params, () => this.rpcActionQueueControl(params, "pause"));
      case "action.queue.resume":
        return this.withIdempotency(verb, params, () => this.rpcActionQueueControl(params, "resume"));
      case "action.report":
        // Not under withIdempotency: a refused report audits its rejection in
        // its own transaction (the wrapper's rollback would drop it), and the
        // report path is idempotent per attempt by construction. A caller key
        // still replays the recorded result (rpc_idempotency, outside any tx).
        return this.rpcActionReportIdempotent(params);
      case "action.claim":
        return this.rpcActionClaim(params);
      case "cell.execSecret":
        return this.rpcCellExecSecret(params, conn);
      case "cell.execSecret.cancel": {
        if (Object.keys(params).some(key => !["beeId", "cellId", "executionId", "nodeId"].includes(key)) || params.nodeId !== conn.secretExecutionNodeId
          || [params.beeId, params.cellId, params.executionId, params.nodeId].some(value => typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,256}$/.test(value))) throw new RpcError("invalid_request", "secret_execution_invalid");
        const cell = this.mustStore().getCell(params.cellId as string);
        if (!cell || cell.sourceBeeId !== params.beeId) throw new RpcError("invalid_request", "secret_execution_refused");
        const execution = this.secretExecutions.get(params.executionId as string);
        if (execution && (execution.beeId !== params.beeId || execution.cellId !== params.cellId || execution.nodeId !== params.nodeId)) throw new RpcError("invalid_request", "secret_execution_invalid");
        const prior = this.mustStore().getCellOpByKey(params.executionId as string);
        if (prior && prior.cellId !== params.cellId) throw new RpcError("idempotency_conflict", "secret_execution_invalid");
        if (!prior) {
          const op = this.mustStore().putCellOp({ cellId: cell.id, kind: "exec", idempotencyKey: params.executionId as string, requestHash: hashCellOpRequest({ secretCancellation: params }), argv: [] });
          this.mustStore().updateCellOp(op.id, { status: "failed", failure: "secret_execution_revoked" });
        }
        execution?.controller.abort();
        return { cancelled: execution !== undefined || !prior || prior.failure === "secret_execution_revoked" };
      }
      case "cell.exec":
        return this.rpcCellExec(params);
      case "cell.retained.remove":
        return this.rpcCellRetainedRemove(params);
      case "cell.gc":
        return this.rpcCellGc(params);
      case "cell.evict":
        return this.withIdempotency(verb, params, () => this.rpcCellEvict(params));
      case "cell.park":
        return this.withIdempotency(verb, params, () => this.rpcCellPark(params));
      case "bee.rename":
        return this.withIdempotency(verb, params, () => this.rpcRename(params));
      case "bee.tag":
        this.assertApiaryTagWriter(verb, params);
        return this.withIdempotency(verb, params, () => this.rpcTag(params));
      case "bee.reconnectTools":
        return this.rpcReconnectTools(params);
      case "bee.reconnectTools.get": {
        const beeId = this.requireBee(params);
        const command = this.mustStore().getCommand(this.numberParam(params, "commandId"));
        if (!command || command.beeId !== beeId || command.verb !== "reconnect_tools") throw new RpcError("reconnect_not_found", "Reconnect command not found for this bee");
        return reconnectToolsResult(command);
      }
      case "bee.interrupt":
        return this.withIdempotency(verb, params, () => this.rpcInterrupt(params));
      case "thread.capabilities":
        return { operations: ["fork", "handoff"], executors: [{ harness: "codex", substrate: "hsr", ownership: "local", instructionCompaction: true }], transcript: "codex.rollout.jsonl" };
      case "thread.fork":
      case "thread.handoff":
        return this.rpcThreadOperationWithAdmission(verb === "thread.fork" ? "fork" : "handoff", params);
      case "thread.operation.get":
        return { operation: threadOperationView(this.requireThreadOperation(params)) };
      case "thread.operation.retry":
        for (const key of Object.keys(params)) if (!["operationId", "idempotencyKey"].includes(key)) throw new RpcError("thread_unsupported", `Retry does not accept '${key}'`);
        if (!this.idempotencyKeyOf(params)) throw new RpcError("invalid_request", "Retry requires its own idempotencyKey");
        return this.withIdempotency(verb, params, () => ({ operation: threadOperationView(this.mustStore().retryThreadOperation(this.requireThreadOperation(params).id)) }));
      case "thread.transcript": {
        const row = this.requireThreadOperation(params);
        if (!row.transcriptReady) throw new RpcError("thread_not_ready", "Inherited transcript is not ready; watch thread_operation.put");
        const offset = params.offset ?? 0;
        const limit = params.limitBytes ?? 262144;
        if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || offset > row.source.bytes || typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 1048576) throw new RpcError("invalid_request", "Invalid transcript byte window");
        return readThreadHistory(row, offset, limit).catch(error => { throw new RpcError("thread_history_unavailable", error instanceof Error ? error.message : String(error)); });
      }
      case "bee.fork":
        return this.releasingRefusedClaim(() => this.rpcForkWithAdmission(params));
      case "bee.children":
        return this.rpcChildren(params);
      case "bee.tell":
        return this.rpcHumanOutput("bee.tell", params, conn);
      case "bee.react":
        return this.rpcHumanOutput("bee.react", params, conn);
      case "bee.setHumanOutputMode":
        return this.rpcHumanOutput("bee.setHumanOutputMode", params, conn);
      case "question.ask":
        return this.withIdempotency(verb, params, () => this.rpcQuestionAsk(params));
      case "question.answer":
        return this.withIdempotency(verb, params, () => this.rpcQuestionAnswer(params));
      case "question.dismiss":
        return this.rpcQuestionDismiss(params);
      case "question.withdraw":
        return this.rpcQuestionWithdraw(params, conn);
      case "question.list":
        return this.rpcQuestionList(params);
      case "seal.create":
        return this.withIdempotency(verb, params, () => this.rpcSealCreate(params));
      case "seal.list":
        return this.rpcSealList(params);
      case "seal.get":
        return { seal: this.mustStore().mustGetSeal(this.param(params, "sealId")) } satisfies SealGetResult;
      case "task.add":
        return this.withIdempotency(verb, params, () => this.rpcTaskAdd(params));
      case "task.list":
        return this.rpcTaskList(params);
      case "task.get":
        return this.rpcTaskGet(params);
      case "task.transition":
        return this.withIdempotency(verb, params, () => this.rpcTaskTransition(params));
      case "task.claim":
        return this.withIdempotency(verb, params, () => this.rpcTaskClaim(params));
      case "task.move":
        return this.withIdempotency(verb, params, () => this.rpcTaskMove(params));
      case "task.edit":
        return this.withIdempotency(verb, params, () => this.rpcTaskEdit(params));
      case "task.lists":
        return { lists: this.mustStore().listTaskLists() } satisfies TaskListsResult;
      case "task.supply.get":
        return this.rpcTaskSupplyGet(params);
      case "task.supply.set":
        return this.withIdempotency(verb, params, () => this.rpcTaskSupplySet(params));
      case "archive":
        return this.withIdempotency(verb, params, () => {
          const result = this.rpcEnqueue("archive", this.param(params, "beeId"), {}, params);
          for (const execution of this.secretExecutions.values()) if (execution.beeId === params.beeId) execution.controller.abort();
          return result;
        });
      case "unarchive":
        return this.withIdempotency(verb, params, () =>
          this.rpcEnqueue("unarchive", this.param(params, "beeId"), {}, params),
        );
      case "delete":
        return this.withIdempotency(verb, params, () =>
          this.rpcEnqueue("delete", this.param(params, "beeId"), {}, params),
        );
      case "view":
        return this.viewOf(this.mustStore(), this.param(params, "beeId"));
      case "list":
        if (conn.confinement === "confined") {
          const id = conn.localPeer ? this.spawnPeerBee(conn.localPeer) : null;
          if (!id) throw new RpcError("confined_peer_refused", "Confined caller has no owning bee");
          const own = this.viewOf(this.mustStore(), id);
          return {views: [own]};
        }
        return this.rpcList(params);
      case "mailbox":
        return this.rpcMailbox(params);
      case "mail.ack":
        return this.rpcMailAck(params);
      case "mail.history":
        return this.rpcMailHistory(params);
      case "mail.pending":
        return this.rpcMailPending(params);
      case "commands":
        return { commands: this.mustStore().listCommands({ beeId: this.requireBee(params) }) };
      case "audit.tail":
        return this.rpcAuditTail(params);
      case "deployInfo":
        return this.rpcDeployInfo();
      case "update.apiarySwap.status":
      case "update.apiarySwap.acquire":
      case "update.apiarySwap.release":
      case "update.apiarySwap.abandon":
      case "update.apiarySwap.recover":
        return this.rpcApiarySwap(verb, params);
      case "store.backup":
        return this.mustStore().backup(JSON.stringify(BUILD_IDENTITY));
      case "update.status":
        return { contract: UPDATE_RECOVERY_CONTRACT, schemaVersion: SCHEMA_VERSION,
          runtimeRoot: join(dirname(this.cfg.dataDir), "runtime"), storePath: this.cfg.storePath,
          identity: BUILD_IDENTITY, reservation: this.mustStore().durableUpdateReservation(),
          blockers: this.mustStore().credentialAuthorityRollbackBlockers() };
      case "update.reserve":
        if (typeof params.expectedEpoch !== "number") throw new RpcError("invalid_request", "expectedEpoch must be a number");
        if (resolve(this.cfg.storePath) !== resolve(this.cfg.dataDir, "core.sqlite3")) throw new RpcError("invalid_request", "Custom stores require coordinated migration");
        return withFileLock(join(dirname(this.cfg.dataDir), "runtime", ".deploy.lock"), async () => this.mustStore().reserveUpdate({ id: this.param(params, "id"),
          recoverySubjectDigest: this.param(params, "recoverySubjectDigest"), expectedEpoch: params.expectedEpoch as number }));
      case "update.release":
        if (resolve(this.cfg.storePath) !== resolve(this.cfg.dataDir, "core.sqlite3")) throw new RpcError("invalid_request", "Custom stores require coordinated migration");
        return withFileLock(join(dirname(this.cfg.dataDir), "runtime", ".deploy.lock"), async () => {
          const expected = params.expectedIdentity as Record<string, unknown> | undefined;
          if (!expected || BUILD_IDENTITY.release !== true || BUILD_IDENTITY.dirty !== false
            || ["component", "version", "sourceRevision", "target"].some(key => (BUILD_IDENTITY as unknown as Record<string, unknown>)[key] !== expected[key]))
            throw new RpcError("invalid_request", "Running identity does not match completion receipt");
          // A pre-switch daemon can survive a failed restart. Its own build
          // identity is insufficient: completion must match installed current too.
          const current = join(dirname(this.cfg.dataDir), "runtime", "current");
          try {
            const installed = readBuildIdentity(join(current, "dist", "build-identity.json"));
            const receipt = installedV2Identity(join(dirname(this.cfg.dataDir), "runtime"));
            const artifact = expected.artifact as Record<string, unknown> | undefined;
            if (!receipt || !artifact || receipt.artifact.url !== artifact.url || receipt.artifact.sha256 !== artifact.sha256
              || readlinkSync(current) !== expected.sourceRevision || JSON.stringify(installed) !== JSON.stringify(BUILD_IDENTITY))
              throw new Error("current differs");
          } catch {
            throw new RpcError("invalid_request", "Installed current identity does not match completion receipt");
          }
          if (typeof params.epoch !== "number") throw new RpcError("invalid_request", "epoch must be a number");
          return this.mustStore().releaseUpdate({ id: this.param(params, "id"),
            recoverySubjectDigest: this.param(params, "recoverySubjectDigest"), epoch: params.epoch });
        });
      case "doctor.integrity": {
        if (this.integrityCheck) return this.integrityCheck;
        if (Date.now() - this.integrityCheckAt < 60_000) throw new RpcError("doctor_cooldown", "Integrity check requires a sixty-second interval between runs");
        this.integrityCheckAt = Date.now();
        const pending: Promise<{ ok: boolean; results: string[]; durationMs: number }> = new Promise((resolve, reject) => setImmediate(() => {
          const started = performance.now();
          try { resolve({ ...this.mustStore().quickCheck(), durationMs: performance.now() - started }); }
          catch (error) { reject(error); }
        }));
        this.integrityCheck = pending.finally(() => { this.integrityCheckAt = Date.now(); this.integrityCheck = null; });
        return this.integrityCheck;
      }
      case "node.harnesses":
        return this.rpcNodeHarnesses();
      case "health":
        return this.rpcHealth(params);
      case "template.list":
        return this.rpcTemplateList(params);
      case "template.get":
        return { template: this.requireTemplate(params) } satisfies TemplateGetResult;
      case "template.put":
        return this.withIdempotency(verb, params, () => this.rpcTemplatePut(params));
      case "template.delete":
        return this.withIdempotency(
          verb,
          params,
          () => ({ template: this.mustStore().deleteTemplate(this.param(params, "id")) }) satisfies TemplateDeleteResult,
        );
      case "template.export": {
        const doc = exportTemplate(this.requireTemplate(params));
        return { package: doc, text: serializePackage(doc) } satisfies TemplateExportResult;
      }
      case "template.import":
        return this.withIdempotency(verb, params, () => {
          const res = importTemplate(this.mustStore(), params.package, this.importOptions(params));
          return { template: res.row, outcome: res.outcome } satisfies TemplateImportResult;
        });
      case "packages.importLocalConfig":
        return this.withIdempotency(verb, params, () => this.rpcImportLocalConfig(params));
      case "import.fromFrozen":
        return this.withIdempotency(verb, params, () => this.rpcImportFromFrozen(params));
      case "mirror.local.snapshot":
      case "snapshot": {
        const includeHomes = verb === "mirror.local.snapshot" && conn.operatorLocalHomes === true;
        const snap = this.snapshot(includeHomes);
        conn.alignWatch(snap.seq, includeHomes);
        return snap;
      }
      case "mirror.local.watch":
      case "watch": {
        const includeHomes = verb === "mirror.local.watch" && conn.operatorLocalHomes === true;
        const snap = this.snapshot(includeHomes);
        conn.subscribeWatch(snap.seq, includeHomes);
        return snap;
      }
      default: {
        throw new RpcError("invalid_request", `unhandled verb: ${String(verb)}`);
      }
    }
  }

  /** `args` param: string[] (spawn), or string[] | null when `nullable` (setArgs/revive: null clears). */
  private argsParam(params: Record<string, unknown>, verb: string, nullable: boolean): string[] | null {
    const v = params.args;
    if (v === null && nullable) return null;
    if (!Array.isArray(v) || v.some((a) => typeof a !== "string")) {
      throw new RpcError("invalid_request", `${verb}: args must be an array of strings${nullable ? " (or null to clear)" : ""}`);
    }
    return v as string[];
  }

  private apiarySwapInstalledIdentity(): ComponentIdentity {
    const root = join(dirname(this.cfg.dataDir), "runtime"), current = join(root, "current");
    const installed = installedV2Identity(root);
    if (!installed || !BUILD_IDENTITY.release || BUILD_IDENTITY.dirty !== false
      || ["component", "version", "sourceRevision", "target"].some(key => Reflect.get(BUILD_IDENTITY, key) !== Reflect.get(installed, key))) {
      throw new RpcError("invalid_request", "apiary-swap: pinned running identity differs", { reason: "identity_mismatch" });
    }
    try {
      if (readlinkSync(current) !== installed.sourceRevision
        || JSON.stringify(readBuildIdentity(join(current, "dist", "build-identity.json"))) !== JSON.stringify(BUILD_IDENTITY)) throw new Error("current differs");
      return parseComponentIdentity(installed);
    } catch {
      throw new RpcError("invalid_request", "apiary-swap: installed current identity differs", { reason: "identity_mismatch" });
    }
  }

  private async rpcApiarySwap(verb: "update.apiarySwap.status" | "update.apiarySwap.acquire" | "update.apiarySwap.release" | "update.apiarySwap.abandon" | "update.apiarySwap.recover", params: Record<string, unknown>): Promise<unknown> {
    const runtimeRoot = resolve(dirname(this.cfg.dataDir), "runtime"), storePath = resolve(this.cfg.storePath);
    const storageSupported = ([48, 49, 50, 51] as readonly number[]).includes(SCHEMA_VERSION) && storePath === resolve(this.cfg.dataDir, "core.sqlite3");
    if (verb === "update.apiarySwap.status") {
      let installedIdentity: ComponentIdentity | null = null;
      try { installedIdentity = this.apiarySwapInstalledIdentity(); } catch {}
      return { contract: APIARY_SWAP_CAPABILITY, receiptAuthority: "trusted-local-owner-attestation", schemaVersion: SCHEMA_VERSION, storageSupported,
        node: hostname(), runtimeRoot, storePath, identity: BUILD_IDENTITY, installedIdentity,
        reservation: this.mustStore().durableUpdateReservation() };
    }
    return withFileLock(join(runtimeRoot, ".deploy.lock"), async () => {
      if (!storageSupported) throw new RpcError("invalid_request", "apiary-swap: unsupported storage", { reason: "unsupported_storage" });
      try {
        const operation = verb === "update.apiarySwap.acquire" ? "acquire" : verb === "update.apiarySwap.release" ? "release" : verb === "update.apiarySwap.abandon" ? "abandon" : "recover";
        const request = operation === "acquire" ? parseApiarySwapAcquire(params) : operation === "recover" ? parseApiarySwapRecover(params) : parseApiarySwapSettle(params, operation);
        const installed = this.apiarySwapInstalledIdentity();
        if (canonicalDigest(installed) !== canonicalDigest(request.expectedHoneybeeIdentity)) throw new RpcError("invalid_request", "apiary-swap: expected identity differs", { reason: "identity_mismatch" });
        if ("transaction" in request && (request.transaction.scope.node !== hostname() || request.transaction.scope.runtimeRoot !== runtimeRoot || request.transaction.scope.storePath !== storePath)) throw new RpcError("invalid_request", "apiary-swap: transaction scope differs", { reason: "invalid_transaction" });
        if (operation === "acquire") return this.mustStore().acquireApiarySwap(params);
        if (operation === "recover") return this.mustStore().recoverApiarySwap(params);
        return this.mustStore().settleApiarySwap(params, operation);
      } catch (error) {
        if (error instanceof RpcError) throw error;
        if (error instanceof ApiarySwapError) throw new RpcError("invalid_request", error.message, { reason: error.code });
        throw error;
      }
    });
  }

  private rpcSetArgs(params: Record<string, unknown>): SetArgsResult {
    const beeId = this.requireBee(params);
    const args = this.argsParam(params, "bee.setArgs", true);
    const res = this.mustStore().updateBeeArgs(beeId, args);
    this.log(`bee.setArgs bee=${beeId} applied=${res.applied} args=${JSON.stringify(args)}`);
    return { bee: toPublicBee(res.bee), applied: res.applied };
  }

  private requireBee(params: Record<string, unknown>): string {
    const beeId = this.param(params, "beeId");
    if (!this.mustStore().getBee(beeId)) throw new RpcError("bee_not_found", `bee not found: ${beeId}`);
    return beeId;
  }

  /** The optional caller-supplied idempotency key (spec 06 §4.2 one-key rule). */
  private idempotencyKeyOf(params: Record<string, unknown>): string | null {
    const key = params.idempotencyKey;
    if (key === undefined || key === null) return null;
    if (typeof key !== "string" || key.length === 0) {
      throw new RpcError("invalid_request", "idempotencyKey must be a non-empty string when given");
    }
    return key;
  }

  /**
   * One-key idempotency around a mutation verb (spec 06 §4.2). With a key:
   * the whole mutation — dedup lookup, the mutation itself, and the result
   * record — runs in ONE store transaction, so a replayed key always answers
   * with the ORIGINAL recorded result (`deduped: true`; command-backed
   * results also carry the command's CURRENT status, so replay after settle
   * returns the settled outcome). A failed mutation records nothing: the
   * caller may retry with the same key. Keyless calls are untouched.
   */
  private phoneOriginOf(params: Record<string, unknown>): PhoneOriginRequest | undefined {
    return (params as Record<PropertyKey, unknown>)[PHONE_CONTEXT] as PhoneOriginRequest | undefined;
  }

  private phoneRequestBinding(params: Record<string, unknown>): { lane: string; digest: string } {
    const lane = String((params as Record<PropertyKey, unknown>)[PHONE_LANE] ?? "legacy");
    if (lane === "legacy") return { lane, digest: canonicalDigest(JSON.parse(JSON.stringify(typeof params.automationKind !== "string" ? { lane } : { lane, automationKind: params.automationKind, automationRef: typeof params.automationRef === "string" ? params.automationRef : null, automationReference: (params as Record<PropertyKey,unknown>)[AUTOMATION_REFERENCE] ?? null }))) };
    return { lane, digest: (params as Record<PropertyKey, unknown>)[PHONE_DIGEST] as string ?? canonicalDigest(JSON.parse(JSON.stringify({ params, lane, phoneOrigin: this.phoneOriginOf(params) ?? null, carrierDigest: (params as Record<PropertyKey, unknown>)[PHONE_CARRIER_DIGEST] ?? null }))) };
  }

  private checkPhoneRequestBinding(verb: string, params: Record<string, unknown>): void {
    const key = this.idempotencyKeyOf(params);
    if (key && (verb === "send" || verb === "spawn")) {
      const binding = this.phoneRequestBinding(params);
      this.mustStore().checkPhoneBinding(key, verb, binding.lane, binding.digest);
    }
  }

  private phoneSendOptions(params: Record<string, unknown>): { phone?: { origin: PhoneOriginRequest; key: string } } {
    const origin = this.phoneOriginOf(params);
    return origin ? { phone: { origin, key: this.idempotencyKeyOf(params)! } } : {};
  }

  private withIdempotency<T extends object>(
    verb: RpcVerb,
    params: Record<string, unknown>,
    fn: () => T,
  ): T | (T & { deduped: true; status?: CommandRow["status"] }) {
    const key = this.idempotencyKeyOf(params);
    if (key == null) return fn();
    const store = this.mustStore();
    if (this.effectInFlight?.has(key) && verb !== "spawn") throw new RpcError("idempotency_conflict", "Key belongs to an in-flight spawn");
    return store.transact(() => {
      this.checkPhoneRequestBinding(verb, params);
      const hit = store.lookupRpcResult(key);
      if (hit) {
        if (hit.verb !== verb) throw new RpcError("idempotency_conflict", `Key belongs to ${hit.verb}, not ${verb}`);
        this.log(`rpc.dedup verb=${verb} key=${key}`);
        const replay = { ...(hit.result as T), deduped: true as const };
        // Command-backed results carry the command's CURRENT status on
        // replay — except the cell verbs, whose `status` IS the report
        // (deleted|refused|absent, landed|conflict|…) and is never clobbered.
        if (hit.commandId != null && !OWN_STATUS_VERBS.has(verb)) {
          const cmd = store.getCommand(hit.commandId);
          if (cmd) return { ...replay, status: cmd.status };
        }
        return replay;
      }
      if (verb === "send" || verb === "spawn") {
        const binding = this.phoneRequestBinding(params);
        store.bindPhoneAdmission(key, verb, binding.lane, binding.digest);
      }
      const effect = fn();
      const messageId = (effect as { messageId?: number }).messageId;
      const input = typeof messageId === "number" ? store.phoneInput(messageId) : undefined;
      const operationOrigin = this.phoneOriginOf(params) && !input && typeof (effect as { beeId?: unknown }).beeId === "string" ? store.getBee((effect as { beeId: string }).beeId)?.phoneOperationOrigin : undefined;
      const boundEffect = (verb === "send" || verb === "spawn") ? { ...effect, requestBinding: { version: 1, verb, lane: this.phoneRequestBinding(params).lane, requestDigest: this.phoneRequestBinding(params).digest } } : effect;
      const result = input ? { ...boundEffect, phoneAdmission: { ownerStoreId: input.envelope.ownerStoreId, admissionId: input.envelope.admissionId, contentDigest: input.envelope.contentDigest, lane: input.envelope.lane } } : operationOrigin ? { ...boundEffect, phoneAdmission: { ownerStoreId: operationOrigin.ownerStoreId, admissionId: operationOrigin.admissionId, contentDigest: null, lane: operationOrigin.lane } } : boundEffect;
      const commandId = (result as { commandId?: unknown }).commandId;
      store.recordRpcResult(key, verb, typeof commandId === "number" ? commandId : null, publicBeeResult(result));
      return result;
    });
  }

  private lineageInspect(pid: number): ProcessInspection { return inspectProcess(pid); }
  private readonly confinedAdmission = new ConfinedAdmission();
  private admitConfined(verb: RpcVerb, params: Record<string, unknown>, conn: RpcConn): Record<string, unknown> {
    const store = this.mustStore();
    const id = conn.localPeer && conn.ingress === "local_unix" ? this.spawnPeerBee(conn.localPeer) : null;
    const bee = id ? store.getBee(id) : null;
    const runtime = id ? store.currentRuntime(id) : null;
    if (!bee || bee.lifecycle !== "active" || !runtime || runtime.state === "stopped") throw new RpcError("confined_peer_refused", "Confined caller has no live owning bee");
    const binding = store.runtimeProcessIdentity(bee.id, runtime.generation);
    if (!conn.localPeer || binding.kind !== "bound" || spawnCallerBee(conn.localPeer, [{beeId: bee.id, identity: binding.identity}], pid => this.lineageInspect(pid)) !== bee.id) throw new RpcError("confined_peer_refused", "Confined caller generation is stale");
    return this.confinedAdmission.admit(verb, params, {
      beeId: bee.id, generation: runtime.generation, parentId: bee.parentExternal ? null : bee.parentId,
      canSend: target => { const parent = store.getBee(target); return !!parent && parent.agent !== INBOX_AGENT; },
    });
  }

  private observeCellRuntimeNamespace(beeId: string, pid: number | null): void {
    if (this.stopping || !this.store || process.platform !== "linux") return;
    let sandboxed = true;
    try {
      const bee = this.store.getBee(beeId);
      if (bee?.substrate !== "cell") return;
      const cell = bee.cellId ? this.store.getCell(bee.cellId) : null;
      if (!cell || cell.state === "removed") throw new Error("cell_unresolved");
      sandboxed = sandboxEnabled(this.cfg.nodeKind, cell.sandbox ?? this.cfg.cellSandbox);
    } catch { this.log("security.confinement cell_sandbox_unresolved assumed=sandboxed"); }
    try {
      if (!sandboxed) return;
      this.cellNamespaces.set(beeId, pid ? runtimeUserNamespace(pid) : "unavailable");
      if ([...this.cellNamespaces.values()].some(value => value !== "different")) this.confinementReason("cell_userns_unisolated");
      else if (this.confinementReasons.delete("cell_userns_unisolated")) this.log(`security.confinement strict=${this.confinementReasons.size > 0} reasons=${[...this.confinementReasons].join(",")}`);
    } catch { this.log("security.confinement cell_namespace_unrecorded"); }
  }

  private readonly cellNamespaces = new Map<string, "same" | "different" | "unavailable">();
  private readonly confinementReasons = new Set<string>();
  private confinementBwrap = {path: null as string | null, setuid: false};
  private confinementReason(reason: string): void {
    if (process.platform !== "linux" || this.confinementReasons.has(reason)) return;
    this.confinementReasons.add(reason);
    this.log(`security.confinement strict=true reasons=${[...this.confinementReasons].join(",")}`);
  }

  private authenticatedSpawnParams(params: Record<string, unknown>, conn: RpcConn): Record<string, unknown> {
    assertConfinedSpawn(params, conn);
    const store = this.mustStore();
    let callerBeeId = conn.authenticatedBeeId ?? null;
    if (!callerBeeId && !conn.spawnServiceAuthority && (!conn.localPeer || conn.ingress !== "local_unix")) throw new RpcError("caller_not_trusted", "Spawn requires a verified direct local caller or registered service authority");
    if (!callerBeeId && !conn.spawnServiceAuthority && conn.localPeer && conn.ingress === "local_unix") {
      callerBeeId = this.spawnPeerBee(conn.localPeer);
    }
    if (callerBeeId && !store.getBee(callerBeeId)) throw new RpcError("bee_not_found", "Authenticated spawning bee does not exist");
    const key = this.idempotencyKeyOf(params);
    const prior = key === null ? null : store.lookupRpcResult(key);
    if (callerBeeId && prior) {
      const result = prior.result as { beeId?: string };
      const bee = result.beeId ? store.creationLineage(result.beeId) : null;
      if (prior.verb !== "spawn" || !bee || bee.parentExternal || bee.parentId !== callerBeeId) throw new RpcError("idempotency_conflict", "Spawn key belongs to a different parent");
    }
    return { ...bindSpawnParent(params, callerBeeId, conn.spawnServiceAuthority === true), spawnProvenance: {
      callerBeeId,
      authority: callerBeeId ? "bee" : conn.spawnServiceAuthority ? "registered_service" : "unattributed",
      peerPid: conn.localPeer?.pid ?? null,
    } };
  }

  private spawnPeerBee(peer: NonNullable<RpcConn["localPeer"]>): string | null {
    const store = this.mustStore();
    const runtimes = store.listBees().flatMap(bee => store.listRuntimes(bee.id).map(runtime => {
      const binding = store.runtimeProcessIdentity(bee.id, runtime.generation);
      return { beeId: bee.id, identity: binding.kind === "bound" ? binding.identity : null, pid: runtime.state === "stopped" ? null : runtime.pid };
    }));
    return spawnCallerBee(peer, runtimes, pid => this.lineageInspect(pid));
  }

  private rpcSpawnEffect(params: Record<string, unknown>): Promise<SpawnResult> {
    const key = this.idempotencyKeyOf(params);
    if (key === null) return this.rpcSpawnWithAccount(params);
    this.mustStore().transact(() => this.mustStore().lookupRpcResult(key));
    const binding = this.phoneRequestBinding(params);
    const { spawnProvenance, ...requestParams } = params;
    const fingerprint = binding.lane === "legacy" ? canonicalDigest(JSON.parse(JSON.stringify({ ...requestParams, spawnCallerBeeId: (spawnProvenance as { callerBeeId?: string } | undefined)?.callerBeeId ?? null }))) : binding.digest;
    const registry = this.effectInFlight ??= new Map();
    const existing = registry.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new RpcError("idempotency_conflict", "In-flight spawn key has different arguments");
      return existing.promise.then((result: SpawnResult) => ({ ...result, deduped: true }));
    }
    const entry = { verb: "spawn" as const, fingerprint, promise: Promise.resolve().then(() => this.rpcSpawnWithAccount(params)) };
    registry.set(key, entry);
    entry.promise = entry.promise.finally(() => { if (registry.get(key) === entry) registry.delete(key); });
    return entry.promise;
  }

  private async rpcSpawnWithAccount(params: Record<string, unknown>, execution?: ExecutionRequest): Promise<SpawnResult> {
    const store = this.mustStore();
    const key = this.idempotencyKeyOf(params);
    // A replayed key answers from the record without paying a limits fetch.
    if (key != null && store.lookupRpcResult(key)) return this.withIdempotency("spawn", params, () => this.rpcSpawn(params, null));
    const rawAgent = this.param(params, "agent");
    if (this.isMailboxOnlyAgentToken(rawAgent)) {
      if (execution) throw new RpcError("rpc_execution_fence_unsupported", "Mailbox-only spawn has no agent-start handshake");
      return this.withIdempotency("spawn", params, () => this.rpcSpawnMailboxOnly(params));
    }
    const embedded = this.embeddedSpawnAccount(rawAgent, params.account !== undefined);
    const normalizedParams = embedded.agent === rawAgent ? params : { ...params, agent: embedded.agent };
    const agent = embedded.agent;
    const request = embedded.account ?? this.accountParam(params);
    const claim = this.allocationClaimParam(normalizedParams);
    if (claim && request !== "auto") throw new RpcError("invalid_request", "allocationClaim requires account:auto");
    if (request === "auto" && this.accounts && !claim && this.accounts.allocationMode() === "shadow") {
      await this.accounts.ensureFreshAdmissionLimits(agent, { model: this.modelParamOf(normalizedParams, agent) });
    }
    if (execution) return store.admitFencedSpawn(execution, () => this.rpcSpawn(normalizedParams, request, execution));
    return this.withIdempotency("spawn", normalizedParams, () => this.rpcSpawn(normalizedParams, request));
  }

  private allocationContextParam(params: Record<string, unknown>): AccountAllocationContext | null {
    const value = params.allocationContext;
    if (value === undefined || value === null) return null;
    if (typeof value !== "object" || Array.isArray(value)) {
      throw new RpcError("invalid_request", "allocationContext must be an object");
    }
    const context = value as Record<string, unknown>;
    if (context.version !== 1 || typeof context.scope !== "string" || typeof context.revision !== "string"
      || typeof context.observedAt !== "number" || typeof context.complete !== "boolean" || !Array.isArray(context.accounts)) {
      throw new RpcError("invalid_request", "allocationContext must be a v1 scope/revision/observation with an accounts array");
    }
    const authorityRaw = context.authority;
    if (!authorityRaw || typeof authorityRaw !== "object" || Array.isArray(authorityRaw)) {
      throw new RpcError("invalid_request", "allocationContext.authority must be {node,epoch}");
    }
    const authorityValue = authorityRaw as Record<string, unknown>;
    if (typeof authorityValue.node !== "string" || authorityValue.node.length === 0 || authorityValue.node.length > 128
      || typeof authorityValue.epoch !== "string" || authorityValue.epoch.length === 0 || authorityValue.epoch.length > 128) {
      throw new RpcError("invalid_request", "allocationContext.authority must contain bounded node and epoch strings");
    }
    if (context.accounts.length > 256) throw new RpcError("invalid_request", "allocationContext accounts are bounded to 256 entries");
    const accounts = context.accounts.map((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RpcError("invalid_request", "allocationContext.accounts entries must be objects");
      const fact = raw as Record<string, unknown>;
      if (typeof fact.account !== "string" || ![fact.active, fact.recent, fact.pending, fact.ongoingUnits].every((v) => typeof v === "number")) {
        throw new RpcError("invalid_request", "allocationContext account facts require account, active, recent, pending, and ongoingUnits");
      }
      if (fact.observedClaimIds !== undefined
        && (!Array.isArray(fact.observedClaimIds) || fact.observedClaimIds.length > 256
          || fact.observedClaimIds.some((id) => typeof id !== "string" || id.length === 0 || id.length > 128))) {
        throw new RpcError("invalid_request", "allocationContext observedClaimIds must contain at most 256 bounded claim ids");
      }
      return { account: fact.account, active: fact.active as number, recent: fact.recent as number,
        pending: fact.pending as number, ongoingUnits: fact.ongoingUnits as number,
        ...(fact.observedClaimIds !== undefined ? { observedClaimIds: [...fact.observedClaimIds as string[]] } : {}) };
    });
    return { version: 1, authority: { node: authorityValue.node, epoch: authorityValue.epoch },
      scope: context.scope, revision: context.revision, observedAt: context.observedAt,
      complete: context.complete, accounts };
  }

  private admissionTargetParam(params: Record<string, unknown>, where: string): AccountAdmissionClaim["target"] {
    const raw = params.target;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new RpcError("invalid_request", `${where}: target {node,workId,expectedGeneration} is required`);
    }
    const target = raw as Record<string, unknown>;
    const node = this.param(target, "node");
    const workId = this.param(target, "workId");
    if (node.length > 128 || workId.length > 256) throw new RpcError("invalid_request", `${where}: target identity is too long`);
    this.assertPortableWorkId(workId, `${where}: target.workId`);
    if (!Number.isSafeInteger(target.expectedGeneration) || (target.expectedGeneration as number) < 0) {
      throw new RpcError("invalid_request", `${where}: target.expectedGeneration must be a non-negative integer`);
    }
    return { node, workId, expectedGeneration: target.expectedGeneration as number };
  }

  /** Work ids become filenames on a target daemon and must be one component. */
  private assertPortableWorkId(workId: string, where: string): void {
    if (workId === "." || workId === ".." || workId.includes("/") || workId.includes("\\") || workId.includes("\0")) {
      throw new RpcError("invalid_request", `${where} must be a path-safe identity`);
    }
  }

  private admissionAccountIdsParam(params: Record<string, unknown>, key: string): ReadonlySet<string> | undefined {
    const raw = params[key];
    if (raw === undefined || raw === null) return undefined;
    if (!Array.isArray(raw) || raw.length > 64 || raw.some((id) => typeof id !== "string" || id.length === 0 || id.length > 256)) {
      throw new RpcError("invalid_request", `${key} must contain at most 64 bounded account ids`);
    }
    if (new Set(raw).size !== raw.length) throw new RpcError("invalid_request", `${key} must not contain duplicates`);
    return new Set(raw as string[]);
  }

  private configuredAllocationIdentity(): { node: string; owner: AccountAllocationAuthority } {
    const node = this.cfg.accounts.allocationNodeId;
    const owner = this.cfg.accounts.allocationOwner;
    if (!node || !owner) {
      throw new RpcError("account_wait", "Account allocation identity is not configured");
    }
    return { node, owner };
  }

  private assertAllocationOwner(harness: string, operation: AccountAdmissionClaim["operation"]): AccountAllocationAuthority {
    const { node, owner } = this.configuredAllocationIdentity();
    if (node !== owner.node) this.ownerClaimRequired(harness, operation);
    return owner;
  }

  private rpcAccountActivity(params: Record<string, unknown>): AccountActivityResult {
    const harness = this.param(params, "harness");
    this.configuredAllocationIdentity();
    return this.mustAccounts().nodeActivity(harness);
  }

  private async rpcAccountAdmissionAcquireWithRefresh(params: Record<string, unknown>): Promise<AccountAdmissionAcquireResult> {
    const key = this.idempotencyKeyOf(params);
    if (!key) throw new RpcError("invalid_request", "account.admission.acquire: idempotencyKey is required");
    const harness = this.param(params, "harness");
    const operationValue = this.param(params, "operation");
    if (!["spawn", "swap", "fork", "handoff"].includes(operationValue)) {
      throw new RpcError("invalid_request", "account.admission.acquire: unsupported operation");
    }
    const operation = operationValue as AccountAdmissionClaim["operation"];
    if (this.mustAccounts().allocationMode() === "active") this.assertAllocationOwner(harness, operation);
    const store = this.mustStore();
    if (store.lookupRpcResult(key)) {
      return this.withIdempotency("account.admission.acquire", params, () => {
        throw new Error("unreachable admission replay");
      });
    }
    const model = params.model === undefined || params.model === null ? undefined : this.param(params, "model");
    const requestedExclusions = this.admissionAccountIdsParam(params, "excludeAccountIds");
    const sourceAccount = params.sourceAccount === undefined || params.sourceAccount === null
      ? null
      : this.param(params, "sourceAccount");
    const excludeAccountIds = operation === "swap" && sourceAccount && params.allowSourceAccount !== true
      ? new Set([...(requestedExclusions ?? []), sourceAccount])
      : requestedExclusions;
    const sourceRecovery = this.sourceQuotaRecoveryParam(params);
    await this.mustAccounts().ensureFreshAdmissionLimits(harness, { model, excludeAccountIds, minimumObservedAt: sourceRecovery?.observedAt, quotaResetAt: sourceRecovery?.resetsAt ?? undefined }, !!sourceRecovery);
    return this.withIdempotency("account.admission.acquire", params, () => this.rpcAccountAdmissionAcquire(params));
  }

  private rpcAccountAdmissionAcquire(params: Record<string, unknown>): AccountAdmissionAcquireResult {
    const key = this.idempotencyKeyOf(params)!;
    const harness = this.param(params, "harness");
    const operation = this.param(params, "operation");
    if (!["spawn", "swap", "fork", "handoff"].includes(operation)) {
      throw new RpcError("invalid_request", "account.admission.acquire: unsupported operation");
    }
    const target = this.admissionTargetParam(params, "account.admission.acquire");
    const context = this.allocationContextParam(params);
    if (!context) throw new RpcError("invalid_request", "account.admission.acquire: allocationContext is required");
    const sourceAccount = params.sourceAccount === undefined || params.sourceAccount === null
      ? null
      : this.param(params, "sourceAccount");
    const model = params.model === undefined || params.model === null ? undefined : this.param(params, "model");
    const authority = this.mustAccounts().allocationMode() === "active"
      ? this.assertAllocationOwner(harness, operation as AccountAdmissionClaim["operation"])
      : this.cfg.accounts.allocationOwner;
    const reservationId = randomUUID();
    const admission = this.mustAccounts().admitNewWork(harness, {
      operation: operation as AccountAdmissionClaim["operation"],
      requestKey: key,
      context,
      model,
      sourceAccount,
      allowSourceAccount: params.allowSourceAccount === true,
      sourceQuotaRecovery: this.sourceQuotaRecoveryParam(params),
      excludeRecentlyExhausted: params.allowSourceAccount === true,
      reconcileAfterGeneration: target.expectedGeneration,
      excludeAccountIds: this.admissionAccountIdsParam(params, "excludeAccountIds"),
      onlyAccountIds: this.admissionAccountIdsParam(params, "onlyAccountIds"),
      reservationId,
      reservationMetadata: {
        authority: { version: 1, owner: authority, target, model: model ?? null },
        ...(params.allowSourceAccount === true && params.sourceQuotaRecovery !== undefined ? { sourceQuotaRecovery: this.sourceQuotaRecoveryParam(params) } : {}),
      },
    });
    if (!admission.ok) {
      throw new RpcError(admission.code, admission.message, { allocation: admission.receipt as unknown as Record<string, unknown> });
    }
    if (!admission.reservation) {
      return { authoritative: false, claim: null, allocation: admission.receipt };
    }
    const row = admission.reservation;
    const claim: AccountAdmissionClaim = {
      version: 1,
      id: row.id,
      scope: row.scope,
      account: row.account,
      operation: row.operation,
      units: row.units,
      model: model ?? null,
      sourceAccount: row.sourceAccount,
      ...(row.receipt.sourceQuotaRecovery !== undefined ? { sourceQuotaRecovery: this.sourceQuotaRecoveryParam({ sourceQuotaRecovery: row.receipt.sourceQuotaRecovery }) } : {}),
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      authority: authority!,
      target,
      allocation: admission.receipt,
    };
    return { authoritative: true, claim, allocation: admission.receipt };
  }

  private accountAdmissionRow(claimId: string) {
    const row = this.mustStore().getAccountAdmission(claimId);
    if (!row) throw new RpcError("account_claim_not_found", `account admission claim not found: ${claimId}`);
    return row;
  }

  private assertAdmissionOwnerRow(row: ReturnType<HiveDaemon["accountAdmissionRow"]>): void {
    const account = this.mustStore().getAccount(row.account);
    if (!account) throw new RpcError("account_claim_refused", `account admission claim ${row.id} has no account`);
    const owner = this.assertAllocationOwner(account.harness, row.operation);
    const authority = row.receipt.authority as { version?: unknown; owner?: Partial<AccountAllocationAuthority> } | undefined;
    if (authority?.version !== 1 || authority.owner?.node !== owner.node || authority.owner?.epoch !== owner.epoch) {
      throw new RpcError("account_claim_refused", `account admission claim ${row.id} belongs to another allocator owner`);
    }
  }

  private rpcAccountAdmissionConfirm(params: Record<string, unknown>): AccountAdmissionConfirmResult {
    const claimId = this.param(params, "claimId");
    const rawTarget = params.target;
    if (!rawTarget || typeof rawTarget !== "object" || Array.isArray(rawTarget)) {
      throw new RpcError("invalid_request", "account.admission.confirm: target {node,workId} is required");
    }
    const targetObject = rawTarget as Record<string, unknown>;
    const target = { node: this.param(targetObject, "node"), workId: this.param(targetObject, "workId") };
    const row = this.accountAdmissionRow(claimId);
    this.assertAdmissionOwnerRow(row);
    const authority = row.receipt.authority as { version?: unknown; target?: Partial<AccountAdmissionClaim["target"]> } | undefined;
    if (authority?.version !== 1 || authority.target?.node !== target.node || authority.target?.workId !== target.workId) {
      throw new RpcError("account_claim_refused", `account admission claim ${claimId} does not belong to this target`);
    }
    if (row.releasedAt !== null) throw new RpcError("account_claim_refused", `account admission claim ${claimId} was released`);
    const confirmed = this.mustStore().confirmAccountAdmission(claimId)!;
    return { claimId, status: "confirmed", confirmedAt: confirmed.confirmedAt! };
  }

  private rpcAccountAdmissionRelease(params: Record<string, unknown>): AccountAdmissionReleaseResult {
    const claimId = this.param(params, "claimId");
    const reason = this.param(params, "reason");
    if (Buffer.byteLength(reason) > 512) throw new RpcError("invalid_request", "account.admission.release: reason exceeds 512 bytes");
    const row = this.accountAdmissionRow(claimId);
    this.assertAdmissionOwnerRow(row);
    if (row.confirmedAt !== null) throw new RpcError("account_claim_refused", `confirmed claim ${claimId} must reconcile through fleet observation`);
    if (row.beeId !== null) throw new RpcError("account_claim_refused", `applied claim ${claimId} must reconcile through target activity`);
    const released = this.mustStore().releaseAccountAdmission(claimId)!;
    return { claimId, status: row.releasedAt === null ? "released" : "already_released", releasedAt: released.releasedAt! };
  }

  private allocationClaimParam(params: Record<string, unknown>): AccountAdmissionClaim | null {
    const raw = params.allocationClaim;
    if (raw === undefined || raw === null) return null;
    if (!this.idempotencyKeyOf(params)) {
      throw new RpcError("invalid_request", "allocationClaim requires idempotencyKey so claim consumption and work admission are atomic");
    }
    if (typeof raw !== "object" || Array.isArray(raw)) throw new RpcError("invalid_request", "allocationClaim must be an object");
    if (Buffer.byteLength(JSON.stringify(raw)) > 32_768) throw new RpcError("invalid_request", "allocationClaim exceeds 32 KiB");
    const claim = raw as Record<string, unknown>;
    const target = this.admissionTargetParam({ target: claim.target }, "allocationClaim");
    const authorityRaw = claim.authority;
    if (!authorityRaw || typeof authorityRaw !== "object" || Array.isArray(authorityRaw)) {
      throw new RpcError("invalid_request", "allocationClaim.authority must be {node,epoch}");
    }
    const authorityValue = authorityRaw as Record<string, unknown>;
    if (typeof authorityValue.node !== "string" || authorityValue.node.length === 0 || authorityValue.node.length > 128
      || typeof authorityValue.epoch !== "string" || authorityValue.epoch.length === 0 || authorityValue.epoch.length > 128) {
      throw new RpcError("invalid_request", "allocationClaim.authority must contain bounded node and epoch strings");
    }
    const authority = { node: authorityValue.node, epoch: authorityValue.epoch };
    if (claim.version !== 1 || typeof claim.id !== "string" || claim.id.length === 0 || claim.id.length > 128
      || typeof claim.scope !== "string" || claim.scope.length === 0 || claim.scope.length > 256
      || typeof claim.account !== "string" || claim.account.length === 0 || claim.account.length > 256
      || typeof claim.operation !== "string" || !["spawn", "swap", "fork", "handoff"].includes(claim.operation)
      || claim.units !== 1 || (claim.model !== null && (typeof claim.model !== "string" || claim.model.length === 0 || claim.model.length > 256))
      || (claim.sourceAccount !== null && typeof claim.sourceAccount !== "string")
      || !Number.isSafeInteger(claim.createdAt) || !Number.isSafeInteger(claim.expiresAt)
      || (claim.expiresAt as number) <= (claim.createdAt as number)
      || !claim.allocation || typeof claim.allocation !== "object" || Array.isArray(claim.allocation)) {
      throw new RpcError("invalid_request", "allocationClaim is not a valid v1 owner claim");
    }
    const allocation = claim.allocation as Record<string, unknown>;
    if (allocation.version !== 1 || allocation.mode !== "active" || allocation.outcome !== "selected"
      || allocation.account !== claim.account || allocation.scope !== claim.scope || allocation.operation !== claim.operation) {
      throw new RpcError("account_claim_refused", "allocationClaim decision receipt does not match the claim");
    }
    return { version: 1, id: claim.id, scope: claim.scope, account: claim.account,
      operation: claim.operation as AccountAdmissionClaim["operation"], units: 1,
      model: claim.model as string | null,
      sourceAccount: claim.sourceAccount as string | null,
      ...(claim.sourceQuotaRecovery !== undefined ? { sourceQuotaRecovery: this.sourceQuotaRecoveryParam({ sourceQuotaRecovery: claim.sourceQuotaRecovery }) } : {}),
      createdAt: claim.createdAt as number,
      expiresAt: claim.expiresAt as number, authority, target, allocation: claim.allocation as AccountAllocationReceipt };
  }

  private accountFromClaim(
    claim: AccountAdmissionClaim,
    operation: AccountAdmissionClaim["operation"],
    harness: string,
    workId: string,
    generation: number,
    sourceAccount: string | null,
    model?: string,
    allowSourceAccount = false,
  ): AccountRow {
    const configured = this.configuredAllocationIdentity();
    if (claim.operation !== operation || claim.scope !== this.mustAccounts().allocationScope(harness)
      || claim.target.workId !== workId || claim.target.expectedGeneration !== generation
      || claim.authority.node !== configured.owner.node || claim.authority.epoch !== configured.owner.epoch
      || claim.target.node !== configured.node
      || claim.sourceAccount !== sourceAccount || claim.model !== (model ?? null)
      || claim.expiresAt <= Date.now()) {
      throw new RpcError("account_claim_refused", `allocation claim ${claim.id} is expired or does not match this ${operation}`);
    }
    if (operation === "swap" && claim.account === sourceAccount && !allowSourceAccount) {
      this.refusedClaims.set(claim.id, claim);
      throw new RpcError("account_claim_refused", `allocation claim ${claim.id} cannot restore the source without a matching provider quota recovery`, { claimId: claim.id, account: claim.account });
    }
    const account = this.resolveAccountSelector(claim.account, harness);
    if (account.harness !== harness) throw new RpcError("harness_mismatch", `account ${account.id} is a ${account.harness} account; expected ${harness}`);
    const readiness = this.mustAccounts().readiness(account);
    if (!readiness.ready) {
      // The claim must not be replayed onto an account that cannot run it. The
      // refusal rolls the admission transaction back, so the entry point
      // fences and releases it afterwards (`releasingRefusedClaim`).
      this.refusedClaims.set(claim.id, claim);
      this.log(`account.claim.refused claim=${claim.id} account=${account.id} operation=${operation} code=${readiness.code}`);
      throw new RpcError(readiness.code, readiness.message, { claimId: claim.id, account: account.id });
    }
    return account;
  }

  /**
   * A claim refused for account readiness must never be applied later, and
   * the allocator's hold must not outlive a placement that cannot run. After
   * the refusing transaction has rolled back: the claim is fenced locally (a
   * released local row refuses any replay, even once the credential is back)
   * and the local reservation, when this node minted it, is released. A claim
   * minted by another owner node cannot be released from here: the refusal
   * says so (`ownerReleaseRequired`) so the coordinator releases it at the owner.
   */
  private async releasingRefusedClaim<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      const claimId = error instanceof RpcError && typeof error.details?.claimId === "string" ? error.details.claimId : undefined;
      const claim = claimId === undefined ? undefined : this.refusedClaims.get(claimId);
      if (claim) {
        this.refusedClaims.delete(claim.id);
        const fence = this.fenceRefusedClaim(claim);
        this.log(`account.claim.released claim=${claim.id} code=${(error as RpcError).code} local=${fence.releasedLocally} owner_release_required=${!fence.releasedLocally}`);
        throw new RpcError((error as RpcError).code, (error as RpcError).message, {
          ...(error as RpcError).details,
          fenced: true,
          released: fence.releasedLocally,
          ownerReleaseRequired: !fence.releasedLocally,
        });
      }
      throw error;
    }
  }

  private fenceRefusedClaim(claim: AccountAdmissionClaim): { releasedLocally: boolean } {
    const store = this.mustStore();
    return store.transact(() => {
      const local = store.getAccountAdmission(claim.id);
      const mintedHere = local !== null && local.releasedAt === null;
      if (!local) {
        store.reserveAccountAdmission({
          id: claim.id,
          requestKey: `shared-account-claim:${claim.id}`,
          scope: claim.scope,
          account: claim.account,
          sourceAccount: claim.sourceAccount,
          operation: claim.operation,
          units: claim.units,
          expiresAt: claim.expiresAt,
          reconcileAfterGeneration: claim.target.expectedGeneration,
          receipt: {
            allocation: claim.allocation as unknown as Record<string, unknown>,
            authority: { version: 1, owner: claim.authority, target: claim.target, model: claim.model },
            ...(claim.sourceQuotaRecovery ? { sourceQuotaRecovery: claim.sourceQuotaRecovery } : {}),
          },
        });
      }
      store.releaseAccountAdmission(claim.id);
      return { releasedLocally: mintedHere };
    });
  }

  private consumeAccountClaim(claim: AccountAdmissionClaim, beeId: string): void {
    try {
      this.mustStore().consumeAccountAdmissionClaim({
        id: claim.id,
        scope: claim.scope,
        account: claim.account,
        sourceAccount: claim.sourceAccount,
        operation: claim.operation,
        units: claim.units,
        expiresAt: claim.expiresAt,
        reconcileAfterGeneration: claim.target.expectedGeneration,
        receipt: {
          allocation: claim.allocation as unknown as Record<string, unknown>,
          authority: { version: 1, owner: claim.authority, target: claim.target, model: claim.model },
          ...(claim.sourceQuotaRecovery ? { sourceQuotaRecovery: claim.sourceQuotaRecovery } : {}),
        },
      }, beeId);
    } catch (error) {
      throw new RpcError("account_claim_refused", error instanceof Error ? error.message : `allocation claim ${claim.id} was refused`);
    }
  }

  private ownerClaimRequired(harness: string, operation: AccountAdmissionClaim["operation"]): never {
    const receipt: AccountAllocationReceipt = {
      version: 1,
      mode: "active",
      scope: this.mustAccounts().allocationScope(harness),
      revision: null,
      observedAt: Date.now(),
      operation,
      outcome: "wait",
      account: null,
      reason: "allocation_owner_required",
      retryAt: null,
      candidates: [],
    };
    throw new RpcError("account_wait", "Automatic account allocation is waiting: allocation_owner_required", {
      allocation: receipt as unknown as Record<string, unknown>,
    });
  }

  private assertNotForeignHarnessStart(verb: RpcVerb, params: Record<string, unknown>, conn: RpcConn): void {
    const caller = conn.caller;
    if (!caller || caller.allowForeignDaemon || !FOREIGN_GUARDED_VERBS.has(verb)) return;
    const instanceForeign = caller.expectedInstanceId !== undefined && caller.expectedInstanceId !== this.instanceId;
    const dataDirForeign = caller.dataDir !== null && !samePath(caller.dataDir, this.cfg.dataDir);
    if (!instanceForeign && !dataDirForeign) return;
    const facts = this.harnessCredentialFacts(verb, params);
    if (!facts.real) return;
    const reason = instanceForeign
      ? caller.expectedInstanceId === null
        ? `the caller found no live endpoint record (hived.endpoint.json) for the data dir it resolved, so it cannot confirm this daemon (instance ${this.instanceId}); while that record is deleted, or the data dir is not visible from the caller's sandbox, every provider-harness start is refused`
        : `this daemon (instance ${this.instanceId}) is not the one recorded for the data dir the caller resolved (${caller.expectedInstanceId})`
      : caller.liveTarget
        ? `the caller explicitly targeted the live daemon (${this.cfg.dataDir}) while its HIVE_V2_DATA_DIR names ${caller.dataDir}`
        : `this daemon's data dir (${this.cfg.dataDir}) is not the caller's HIVE_V2_DATA_DIR (${caller.dataDir})`;
    throw new RpcError("foreign_daemon_spawn",
      `${verb} would start a provider harness on a foreign daemon: ${reason}; pass --allow-foreign-daemon if this is intended`,
      { verb, reason: instanceForeign ? "instance_mismatch" : caller.liveTarget ? "explicit_live_target" : "data_dir_mismatch", callerDataDir: caller.dataDir, expectedInstanceId: caller.expectedInstanceId ?? null,
        daemonInstanceId: this.instanceId, daemonDataDir: this.cfg.dataDir, ...facts.details });
  }

  private harnessCredentialFacts(verb: RpcVerb, params: Record<string, unknown>): { real: boolean; details: Record<string, unknown> } {
    const adapterOf = (agent: string): string => this.isMailboxOnlyAgentToken(agent) ? "inbox" : this.cfg.agents[agent]?.adapter ?? agent;
    const provider = (adapter: string): boolean => adapter !== "stub" && adapter !== "inbox";
    const accountOf = (selector: unknown): { id: string; harness: string } | null => {
      if (typeof selector !== "string") return null;
      try {
        return this.resolveAccountSelector(selector);
      } catch {
        return null;
      }
    };
    if (verb === "account.login.retry") return { real: true, details: {} };
    if (verb.startsWith("account.")) {
      const account = accountOf(params.id);
      return { real: account !== null && provider(adapterOf(account.harness)), details: { account: account?.id ?? null, accountHarness: account?.harness ?? null } };
    }
    if (verb === "spawn") {
      const agent = typeof params.agent === "string" ? params.agent : "claude";
      const adapter = adapterOf(agent);
      const account = accountOf(params.account);
      return { real: provider(adapter) || (account !== null && provider(adapterOf(account.harness))), details: { agent, adapter, account: account?.id ?? params.account ?? null } };
    }
    const beeId = verb === "thread.operation.retry" && typeof params.operationId === "string"
      ? this.mustStore().getThreadOperation(params.operationId)?.sourceBeeId
      : params.beeId;
    const bee = typeof beeId === "string" ? this.mustStore().getBee(beeId) : null;
    if (!bee) return { real: false, details: {} };
    const adapter = adapterOf(bee.agent);
    const accounts = [accountOf(bee.account), verb === "bee.swapAccount" ? accountOf(params.account) : null];
    return { real: provider(adapter) || accounts.some((account) => account !== null && provider(adapterOf(account.harness))), details: { agent: bee.agent, adapter, account: bee.account ?? null } };
  }

  /** `inbox` is built in; `stub` aliases it unless a configured agent owns that name. */
  private isMailboxOnlyAgentToken(agent: string): boolean {
    return isInboxAgent(agent) || (agent === "stub" && !this.cfg.agents.stub);
  }

  /**
   * Mailbox-only spawn: identity + mailbox, no runtime process, no account,
   * no Cell, no spawn command. The core stores its single generation as
   * already stopped(clean), so nothing boots, wakes, reconciles, or retries it.
   */
  private rpcSpawnMailboxOnly(params: Record<string, unknown>): SpawnResult {
    const store = this.mustStore();
    const name = this.param(params, "name");
    if (params.substrate !== undefined && params.substrate !== null && params.substrate !== "hsr") {
      throw new RpcError("invalid_request", `spawn: agent '${INBOX_AGENT}' is mailbox-only and takes no substrate (got '${String(params.substrate)}')`);
    }
    if (params.account !== undefined && params.account !== null && params.account !== "auto") {
      throw new RpcError("invalid_request", `spawn: agent '${INBOX_AGENT}' is mailbox-only and binds no account`);
    }
    if (Array.isArray(params.args) && params.args.length > 0) {
      throw new RpcError("invalid_request", `spawn: agent '${INBOX_AGENT}' is mailbox-only and takes no args`);
    }
    const tags = Array.isArray(params.tags) && params.tags.every((t) => typeof t === "string") ? (params.tags as string[]) : [];
    const parent = this.parentParam(params);
    const id = typeof params.id === "string" && params.id.length > 0 ? params.id : randomUUID();
    const { bee } = store.createBee({
      ...(this.phoneOriginOf(params) && params.prompt == null ? { phoneOperation: this.phoneSendOptions(params).phone } : {}),
      id,
      name,
      agent: INBOX_AGENT,
      substrate: "hsr",
      cwd: typeof params.cwd === "string" ? params.cwd : "",
      title: typeof params.title === "string" ? params.title : undefined,
      tags,
      parentId: parent.parentId,
      parentExternal: parent.parentExternal,
      spawnProvenance: params.spawnProvenance as import("../../core/src/store.ts").CreateBeeInput["spawnProvenance"],
    });
    const prompt = typeof params.prompt === "string" && params.prompt.length > 0 ? params.prompt : null;
    const sent = prompt == null ? null : store.send(id, prompt, { sender: this.phoneOriginOf(params) ? `remote:${this.phoneOriginOf(params)!.issuerNodeId}/phone` : "operator", origin: "spawn.prompt", ...this.phoneSendOptions(params) });
    this.log(`spawn.mailbox_only bee=${id}`);
    return { beeId: id, agent: INBOX_AGENT, handle: bee.handle, commandId: null, messageId: sent?.message.id ?? null, account: null };
  }

  /**
   * V1-compatible agent-token selectors (`claude-gmail`, `codex-auto`,
   * `claude-rr`). Exact configured agent names win, including hyphenated
   * custom agents. Otherwise the longest configured `<agent>-` prefix is the
   * harness and the suffix is account intent. An explicit `account` param
   * still wins; only the agent token is normalized in that case.
   */
  private embeddedSpawnAccount(agentToken: string, explicitAccount: boolean): { agent: string; account?: string } {
    if (this.cfg.agents[agentToken]) return { agent: agentToken };
    const lowered = agentToken.toLowerCase();
    const agent = Object.keys(this.cfg.agents)
      .sort((a, b) => b.length - a.length)
      .find((candidate) => lowered.startsWith(`${candidate.toLowerCase()}-`));
    if (!agent) return { agent: agentToken };
    if (explicitAccount) return { agent };
    const suffix = agentToken.slice(agent.length + 1);
    return { agent, account: suffix === "auto" || suffix === "rr" ? suffix : agentToken };
  }

  /** `account?` on spawn: undefined → 'auto'; null → unbound; string → explicit id, 'auto', or 'rr'. */
  private accountParam(params: Record<string, unknown>): string | null {
    const v = params.account;
    if (v === undefined) return "auto";
    if (v === null) return null;
    if (typeof v !== "string" || v.length === 0) throw new RpcError("invalid_request", "spawn: account must be an account id, 'auto', 'rr', or null");
    return v;
  }

  /** The `--model` the bee will run with (for the Fable-scoped selection tier): bee args over agent defaults. */
  private modelParamOf(params: Record<string, unknown>, agent: string): string | undefined {
    const args = Array.isArray(params.args) ? (params.args as unknown[]).filter((a): a is string => typeof a === "string") : [];
    const spec = this.cfg.agents[agent];
    const all = [...(spec?.defaultArgs ?? []), ...args];
    let model: string | undefined;
    for (let i = 0; i < all.length; i += 1) {
      const a = all[i] as string;
      if (a === "--model" || a === "-m") model = all[i + 1];
      else if (a.startsWith("--model=")) model = a.slice("--model=".length);
    }
    return model;
  }

  /**
   * Resolve the account for a new bee: explicit id → validated
   * (account_not_found / account_paused / harness_mismatch); 'auto' → the
   * calibrated selector (unbound when the harness has no accounts at all);
   * 'rr' → the next credentialed account in registration order; null →
   * unbound. An explicit selector with no usable candidates is typed
   * `account_unavailable`. Where the harness's accounts are unisolated only
   * its native account (the machine's own login) runs: explicit and claimed
   * accounts must pass readiness, and auto/rr pick only the native account.
   */
  private resolveSpawnAccount(
    request: string | null,
    agent: string,
    params: Record<string, unknown>,
    admissionKey: string,
    operation: "spawn" | "handoff" = "spawn",
    reconcileAfterGeneration = 0,
    sourceAccount: string | null = null,
    targetWorkId?: string,
  ): { account: AccountRow | null; reason: string | null; allocation?: AccountAllocationReceipt; reservationId?: string; claim?: AccountAdmissionClaim } {
    const store = this.mustStore();
    if (request === null) return { account: null, reason: null };
    const unisolated = this.accounts?.isolationRefusal(agent) ?? null;
    if (unisolated && !this.accounts!.nativeRecipe(agent)) throw new RpcError("account_unavailable", unisolated);
    const onlyAccountIds = this.admissionAccountIdsParam(params, "onlyAccountIds");
    if (request === "rr") {
      if (!this.accounts) throw new RpcError("account_unavailable", `Account selection is unavailable for ${agent}`);
      const pick = this.accounts.pickRoundRobin(agent, { onlyAccountIds });
      if (!pick.ok) throw new RpcError(pick.code === "auth_needed" ? "account_auth_needed" : "account_unavailable", pick.message, { pick: pick.code });
      return { account: pick.account, reason: pick.reason };
    }
    if (request !== "auto") {
      const account = this.resolveAccountSelector(request, agent);
      if (account.harness !== agent) throw new RpcError("harness_mismatch", `account ${account.id} is a ${account.harness} account; the bee runs ${agent}`);
      if (onlyAccountIds && !onlyAccountIds.has(account.id)) {
        throw new RpcError("account_unavailable", `account ${account.id} is outside the allowed account ids for this ${operation}`, { account: account.id });
      }
      const readiness = this.accounts?.readiness(account) ?? { ready: true as const };
      if (!readiness.ready) throw new RpcError(readiness.code, readiness.message, { account: account.id });
      this.accounts?.assertOwnedHome(account, "writes into");
      const breach = this.accounts?.weeklyCeilingBreach(account, this.modelParamOf(params, agent)) ?? null;
      if (breach) {
        throw new RpcError("account_unavailable", `${describeWeeklyCeilingBreach(account.id, breach)}; raise it with: hive account ceiling ${account.id} <percent|off>`);
      }
      return { account, reason: "explicit" };
    }
    const claim = this.allocationClaimParam(params);
    if (claim) {
      if (!this.accounts) throw new RpcError("account_unavailable", `Account selection is unavailable for ${agent}`);
      if (!targetWorkId) throw new RpcError("invalid_request", `${operation}: a stable target work id is required with allocationClaim`);
      if (onlyAccountIds && !onlyAccountIds.has(claim.account)) {
        throw new RpcError("invalid_request", `${operation}: allocationClaim ${claim.id} names ${claim.account}, outside onlyAccountIds`);
      }
      const account = this.accountFromClaim(
        claim, operation, agent, targetWorkId, reconcileAfterGeneration, sourceAccount, this.modelParamOf(params, agent),
      );
      return { account, reason: "allocator owner claim", allocation: claim.allocation, claim };
    }
    if (!this.accounts || (!unisolated && store.listAccounts({ harness: agent }).length === 0)) {
      // A caller that bound the pick to an allowlist never gets an unbound bee running on daemon-default credentials.
      if (onlyAccountIds) throw new RpcError("account_unavailable", `No ${agent} account matches the allowed ids on this node`, { onlyAccountIds: [...onlyAccountIds] });
      return { account: null, reason: null };
    }
    if (this.accounts.allocationMode() === "active") this.ownerClaimRequired(agent, operation);
    const admission = this.accounts.admitNewWork(agent, {
      operation,
      requestKey: admissionKey,
      model: this.modelParamOf(params, agent),
      context: this.allocationContextParam(params),
      sourceAccount,
      reconcileAfterGeneration,
      onlyAccountIds,
    });
    if (!admission.ok) throw new RpcError(admission.code, admission.message, { allocation: admission.receipt as unknown as Record<string, unknown> });
    return { account: admission.account, reason: admission.reason, allocation: admission.receipt, reservationId: admission.reservation?.id };
  }

  private rpcSpawn(params: Record<string, unknown>, accountRequest: string | null, execution?: ExecutionRequest): SpawnResult {
    const store = this.mustStore();
    const key = this.idempotencyKeyOf(params);
    // Belt-and-braces guard for a key already stamped on a command at the
    // CORE level (e.g. by a library caller): answer with the original spawn
    // instead of minting a second bee. Normally the rpc_idempotency record in
    // withIdempotency answers first.
    if (key != null) {
      const original = store.getCommandByIdempotencyKey(key);
      if (original) {
        this.checkPhoneRequestBinding("spawn", params);
        const messageId = store.listMessages(original.beeId).find(message => store.mailOrigin(message.id) === "spawn.prompt")?.id ?? null;
        return {
          beeId: original.beeId,
          handle: store.getBee(original.beeId)?.handle ?? null,
          humanRef: store.getBee(original.beeId)?.human_ref ?? null,
          issuingNamespace: store.getBee(original.beeId)?.issuing_namespace ?? null,
          commandId: original.id,
          messageId,
          status: original.status,
          deduped: true,
        };
      }
    }
    const name = this.param(params, "name");
    const agent = this.param(params, "agent");
    const substrate = this.substrateParam(params);
    // The cell owns the cwd (the space checkout): `cwd` is optional/ignored for cell spawns.
    const cwd = substrate === "cell" ? "" : this.param(params, "cwd");
    const agentSpec = this.cfg.agents[agent];
    const adapterName = agentSpec?.adapter ?? agent;
    if (!agentSpec || !(ADAPTER_NAMES as readonly string[]).includes(adapterName)) {
      throw new RpcError("invalid_request", `unknown agent '${agent}' (no spawn spec/adapter configured)`);
    }
    if (substrate === "cell") this.assertCellAdmission("spawn");
    const tags = Array.isArray(params.tags) && params.tags.every((t) => typeof t === "string")
      ? (params.tags as string[])
      : [];
    const parent = this.parentParam(params);
    const id = typeof params.id === "string" && params.id.length > 0 ? params.id : randomUUID();
    const driver = this.driver;
    // v7: the account is resolved BEFORE the row is written ('auto' is never
    // stored); the home env is derived from the account row.
    if (execution) store.checkSpawnPreparation(execution, "account_admission");
    const { account, reason: pickReason, allocation, reservationId, claim } = this.resolveSpawnAccount(
      accountRequest, agent, params, key ?? `spawn:${id}`, "spawn", 0, null, id,
    );
    const accountReason = (account && this.accounts?.nativeDescription(account)) || pickReason;
    const accountEnv = account && this.accounts ? this.accounts.homeEnvOf(account) : {};
    const requestedEnv = this.spawnEnvParam(params);
    // Cell substrate: the cell owns the cwd (the space checkout). The seed
    // ledger is written in the same call, AFTER the row exists (createBee
    // is the id/name gate) and before the spawn command is enqueued —
    // inside the idempotency transaction, so a failure here leaves no bee.
    const cell = substrate === "cell" ? this.planCell(id, name, this.cellParam(params)) : null;
    if (execution) store.checkSpawnPreparation(execution, "create_bee");
    const { bee: created } = store.createBee({
      ...(this.phoneOriginOf(params) && params.prompt == null ? { phoneOperation: this.phoneSendOptions(params).phone } : {}),
      id,
      name,
      agent,
      substrate,
      cwd: cell ? cell.spaceDir : cwd,
      title: typeof params.title === "string" ? params.title : undefined,
      tags,
      sessionLogPath: driver ? driver.sessionLogPath(id) : undefined,
      args: params.args === undefined ? undefined : this.argsParam(params, "spawn", false),
      parentId: parent.parentId,
      parentExternal: parent.parentExternal,
      spawnProvenance: params.spawnProvenance as import("../../core/src/store.ts").CreateBeeInput["spawnProvenance"],
      env: { ...requestedEnv, ...accountEnv },
      ...(account ? { account: account.id } : {}),
    });
    if (execution) store.checkSpawnPreparation(execution, "consume_account_claim");
    if (claim) this.consumeAccountClaim(claim, created.id);
    else if (reservationId) store.bindAccountAdmission(reservationId, created.id);
    if (cell) {
      if (execution) store.checkSpawnPreparation(execution, "cell_reserve");
      reserveCell(this.cfg.cellsRoot, cell.reserve);
      const identity = localRepoIdentity(cell.reserve.originRepo);
      if (!identity) {
        throw new RpcError("invalid_request", `spawn: cannot read git identity of ${cell.reserve.originRepo}`);
      }
      if (execution) store.checkSpawnPreparation(execution, "cell_registry");
      store.putCell({
        sourceBeeId: id,
        originRepo: cell.reserve.originRepo,
        sha: cell.reserve.sha,
        wrapper: cell.reserve.wrapper,
        spaceName: `${cell.reserve.repoName}-space-${cell.reserve.cellId}`,
        spaceDir: cell.spaceDir,
        gitCommonDirRealpath: identity.gitCommonDirRealpath,
        objectFormat: identity.objectFormat,
        sandbox: cell.reserve.sandbox,
      });
      this.log(`cell.reserve bee=${id} origin=${cell.reserve.originRepo} sha=${cell.reserve.sha} base=${cell.base.source}${cell.base.upstreamSha ? ` upstream=${cell.base.upstreamSha}` : ""} space=${cell.spaceDir}`);
    }
    const cmd = store.enqueueCommand("spawn", id, {}, key == null ? {} : { idempotencyKey: key });
    const prompt = params.prompt === undefined || params.prompt === null
      ? null
      : this.param(params, "prompt");
    const sent = prompt == null || prompt.length === 0
      ? null
      : store.send(id, prompt, { sender: this.phoneOriginOf(params) ? `remote:${this.phoneOriginOf(params)!.issuerNodeId}/phone` : "operator", origin: "spawn.prompt", ...this.phoneSendOptions(params) });
    if (account) this.log(`spawn.account bee=${id} account=${account.id}${accountReason ? ` reason=${JSON.stringify(accountReason)}` : ""}`);
    return {
      beeId: id,
      agent,
      handle: created.handle,
      humanRef: created.human_ref,
      issuingNamespace: created.issuing_namespace,
      commandId: cmd.id,
      messageId: sent?.message.id ?? null,
      account: account?.id ?? null,
      ...(accountReason && accountReason !== "explicit" ? { accountReason } : {}),
      ...(allocation ? { allocation } : {}),
      ...(claim ? { allocationClaimId: claim.id } : {}),
      ...(cell ? { cellBase: cell.base } : {}),
    };
  }

  private substrateParam(params: Record<string, unknown>): SpawnSubstrate {
    const v = params.substrate;
    if (v === undefined || v === null) return "hsr";
    if (typeof v !== "string" || !(SPAWN_SUBSTRATES as readonly string[]).includes(v)) {
      throw new RpcError("invalid_request", `substrate must be one of ${SPAWN_SUBSTRATES.join("|")}`);
    }
    return v as SpawnSubstrate;
  }

  /** Optional per-bee environment supplied by versioned spawn/template RPC callers. */
  private spawnEnvParam(params: Record<string, unknown>): Record<string, string> {
    const value = params.env;
    if (value === undefined) return {};
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new RpcError("invalid_request", "spawn: env must be an object of string values");
    }
    const entries = Object.entries(value);
    if (entries.some(([, item]) => typeof item !== "string")) {
      throw new RpcError("invalid_request", "spawn: env must be an object of string values");
    }
    return Object.fromEntries(entries) as Record<string, string>;
  }

  /** `spawn.cell` — validated shape (see SpawnCellParams). */
  private cellParam(params: Record<string, unknown>): SpawnCellParams {
    const v = params.cell;
    if (v === null || typeof v !== "object" || Array.isArray(v)) {
      throw new RpcError("invalid_request", "spawn: substrate 'cell' requires a cell object {originRepo, sha?, warm?, sandbox?}");
    }
    const c = v as Record<string, unknown>;
    if (typeof c.originRepo !== "string" || c.originRepo.length === 0 || !isAbsolute(c.originRepo)) {
      throw new RpcError("invalid_request", "spawn: cell.originRepo must be an absolute path");
    }
    if (c.sha !== undefined && (typeof c.sha !== "string" || c.sha.length === 0)) {
      throw new RpcError("invalid_request", "spawn: cell.sha must be a non-empty string when given");
    }
    if (
      c.warm !== undefined &&
      typeof c.warm !== "boolean" &&
      !(Array.isArray(c.warm) && c.warm.every((d) => typeof d === "string" && d.length > 0))
    ) {
      throw new RpcError("invalid_request", "spawn: cell.warm must be a boolean or an array of non-empty strings");
    }
    if (c.sandbox !== undefined && typeof c.sandbox !== "boolean") {
      throw new RpcError("invalid_request", "spawn: cell.sandbox must be a boolean when given");
    }
    return {
      originRepo: c.originRepo,
      ...(c.sha !== undefined ? { sha: c.sha as string } : {}),
      ...(c.warm !== undefined ? { warm: c.warm as boolean | string[] } : {}),
      ...(c.sandbox !== undefined ? { sandbox: c.sandbox as boolean } : {}),
    };
  }

  /**
   * Plan a cell for a new bee: validate the origin, resolve the sha (default
   * HEAD), and derive the layout — wrapper `<name>-<hash(id)>`, space
   * `<repo>-space-<hash(id)>` — deterministically from the bee, so a replayed
   * spawn maps to the same paths. Nothing is written here.
   */
  private recentCellOrigins(store: CoreStore): { originRepo: string; repoName: string; usedAt: number }[] {
    const since = Date.now() - DEFAULT_UPSTREAM_REFRESH.recentMs;
    const latest = new Map<string, { originRepo: string; repoName: string; usedAt: number }>();
    for (const row of store.listCells()) {
      if (row.state === "removed" || row.createdAt < since) continue;
      const parsed = parseSpaceName(row.spaceName);
      if (parsed == null) continue;
      const known = latest.get(row.originRepo);
      if (known == null || known.usedAt < row.createdAt) {
        latest.set(row.originRepo, { originRepo: row.originRepo, repoName: parsed.repoName, usedAt: row.createdAt });
      }
    }
    return [...latest.values()];
  }

  private planCell(id: string, name: string, cell: SpawnCellParams): { spaceDir: string; reserve: ReserveRequest; base: CellBase } {
    const originRepo = resolve(cell.originRepo);
    if (!existsSync(join(originRepo, ".git"))) {
      throw new RpcError("invalid_request", `spawn: cell.originRepo ${originRepo} is not a git repository (no .git)`);
    }
    const pinned = cell.sha === undefined ? null : revParse(originRepo, cell.sha);
    const base: CellBase | null = cell.sha === undefined
      ? resolveCellBase(originRepo)
      : pinned == null ? null : { sha: pinned, source: "pinned" };
    const sha = base?.sha ?? null;
    if (base == null || sha == null) {
      throw new RpcError(
        "invalid_request",
        cell.sha === undefined
          ? `spawn: origin ${originRepo} has no HEAD commit`
          : `spawn: cell.sha '${cell.sha}' does not resolve to a commit in ${originRepo}`,
      );
    }
    const cellId = createHash("sha1").update(id).digest("hex").slice(0, 12);
    const wrapper = `${sanitizeComponent(name)}-${cellId}`;
    const repoName = sanitizeComponent(basename(originRepo));
    const warmArtifacts =
      cell.warm === true ? (this.cfg.cellWarm[originRepo] ?? []) : Array.isArray(cell.warm) ? cell.warm : [];
    const paths = cellPaths(this.cfg.cellsRoot, wrapper, repoName, cellId);
    return {
      spaceDir: paths.spaceDir,
      base,
      reserve: {
        beeId: id,
        originRepo,
        sha,
        wrapper,
        repoName,
        cellId,
        warmArtifacts,
        sandbox: cell.sandbox ?? null,
      },
    };
  }

  // -------------------------------------------------------------------------
  // WP6 §5 — cell exit path (spec 05 points 4 + 6)
  // -------------------------------------------------------------------------

  /** Bee with a registry Cell (active or retained). Capture uses this; spawn/legacy remove do not. */
  private requireCellBee(params: Record<string, unknown>): { beeId: string; cell: CellDriver; cellId: string | null } {
    const beeId = this.requireBee(params);
    const bee = this.mustStore().getBee(beeId);
    const row = bee?.cellId ? this.mustStore().getCell(bee.cellId) : null;
    if (!row && bee?.substrate !== "cell") {
      throw new RpcError("invalid_request", `bee ${beeId} is on substrate '${bee?.substrate}', not cell`);
    }
    const driver = this.driver;
    if (!driver) throw new RpcError("node_stopped", "daemon is shutting down");
    return { beeId, cell: driver.cell, cellId: row && row.state !== "removed" ? row.id : null };
  }

  /** Legacy `cell.remove` only: an active (or evicted) Cell allocation. Retained cells use `cell.retained.remove`. */
  private requireActiveCellBee(params: Record<string, unknown>): { beeId: string; cell: CellDriver; cellId: string } {
    const beeId = this.requireBee(params);
    const bee = this.mustStore().getBee(beeId);
    const row = bee?.cellId ? this.mustStore().getCell(bee.cellId) : null;
    if (!bee || bee.substrate !== "cell" || !row || (row.state !== "active" && row.state !== "evicted")) {
      throw new RpcError(
        "invalid_request",
        `cell.remove is for an active Cell bee; retained allocations use cell.retained.remove`,
      );
    }
    const driver = this.driver;
    if (!driver) throw new RpcError("node_stopped", "daemon is shutting down");
    return { beeId, cell: driver.cell, cellId: row.id };
  }

  /**
   * `cell.capture`: CellDriver.capture verbatim. Refusals and conflicts are
   * RESULTS (the report is the answer — the UI renders a branch picker or a
   * conflict staging state), never RPC errors. The transient ref is named by
   * the idempotency key when given, so a replayed operation is one operation.
   */
  private rpcCellCapture(params: Record<string, unknown>): CellCaptureResult {
    const { beeId, cell, cellId } = this.requireCellBee(params);
    const targetBranch = this.param(params, "targetBranch");
    const mode = params.mode;
    if (mode !== "merge" && mode !== "rebase") {
      throw new RpcError("invalid_request", "cell.capture: mode must be merge|rebase");
    }
    if (cellId) {
      this.releaseAbsentCellOps(cellId);
      if (this.cellHasInFlightOp(cellId)) {
        throw new RpcError("runtime_refused", `cell ${cellId} has an in-flight Cell operation`);
      }
    }
    const key = this.idempotencyKeyOf(params);
    const opId = `capture-${key ?? randomUUID()}`;
    if (!cell.cellOf(beeId)) {
      // Reserved but never provisioned (or already removed): nothing to capture.
      return {
        status: "refused",
        targetBranch,
        mode: mode as CellCaptureMode,
        cellHead: null,
        baseTarget: null,
        resultSha: null,
        conflicts: [],
        reason: "no_cell_head",
      };
    }
    const report = cell.capture(beeId, { targetBranch, mode: mode as CellCaptureMode, opId });
    this.log(
      `cell.capture bee=${beeId} onto=${targetBranch} mode=${mode} status=${report.status}` +
        (report.reason ? ` reason=${report.reason}` : "") +
        (report.resultSha ? ` result=${report.resultSha}` : "") +
        (report.conflicts.length > 0 ? ` conflicts=${report.conflicts.length}` : ""),
    );
    return { ...report };
  }

  /**
   * `cell.remove`: the A2 dirty guard (CellDriver.removeCell) then the bee's
   * lifecycle `delete` in the same call. Refused ⇒ nothing changed, no
   * command. A live runtime is a typed `runtime_refused` — stop it first.
   */
  private rpcCellRemove(params: Record<string, unknown>): CellRemoveResult {
    const { beeId, cell, cellId } = this.requireActiveCellBee(params);
    const store = this.mustStore();
    if (params.force !== undefined && typeof params.force !== "boolean") {
      throw new RpcError("invalid_request", "cell.remove: force must be a boolean when given");
    }
    const force = params.force === true;
    this.releaseAbsentCellOps(cellId);
    if (this.cellHasInFlightOp(cellId)) {
      throw new RpcError("runtime_refused", `cell ${cellId} has an in-flight Cell operation`);
    }
    const rt = store.currentRuntime(beeId);
    if ((rt && rt.state !== "stopped") || (rt && this.driver?.hasProcess(beeId, rt.generation))) {
      throw new RpcError("runtime_refused", `bee ${beeId} has a live runtime (${rt.state}); stop it before removing its cell`);
    }
    let result: CellRemoveResult;
    try {
      const res = cell.removeCell(beeId, { force, receipts: store.listLandingReceipts(beeId) });
      result = res.deleted
        ? { status: "deleted", forced: res.forced, report: res.report, commandId: null }
        : { status: "absent", forced: false, report: null, commandId: null };
    } catch (err) {
      if (err instanceof CellDeleteRefused) {
        this.log(`cell.remove bee=${beeId} refused dirty=${JSON.stringify(err.report)} causes=${JSON.stringify(dirtyCauses(err.report))}`);
        return { status: "refused", forced: false, report: err.report, commandId: null };
      }
      if (err instanceof CellRuntimeLiveError) throw new RpcError("runtime_refused", err.message);
      throw err;
    }
    const key = this.idempotencyKeyOf(params);
    const cmd = store.enqueueCommand("delete", beeId, {}, key == null ? {} : { idempotencyKey: key });
    result.commandId = cmd.id;
    this.log(`cell.remove bee=${beeId} status=${result.status} forced=${result.forced} delete=${cmd.id}`);
    return result;
  }

  /** v31 — the driver put a checkout back under an evicted allocation: `evicted → active`. */
  private onCellMaterialized(beeId: string, execution?: ExecutionStart): void {
    const store = this.store;
    if (!store) return;
    const bee = store.getBee(beeId);
    if (!bee?.cellId) return;
    if (execution) store.executionRuntimeHooks().check(execution,"reactivate_cell");
    try {
      const res = store.reactivateCell(bee.cellId);
      if (res.applied) this.log(`cell.reprovisioned bee=${beeId} cell=${bee.cellId} sha=${res.cell.sha}`);
    } catch (err) {
      this.log(`cell.reprovision_record_failed bee=${beeId} ${err instanceof Error ? err.message : String(err)}`);
    }
    if (execution) store.executionRuntimeHooks().check(execution,"restore_cell_env");
    try {
      const row = store.getCell(bee.cellId);
      const restored = row ? restoreEnvFiles(this.cfg.cellsRoot, row.spaceDir) : [];
      if (restored.length > 0) this.log(`cell.env.restored bee=${beeId} cell=${bee.cellId} files=${restored.length} ${JSON.stringify(restored)}`);
    } catch (err) {
      this.log(`cell.env.restore_failed bee=${beeId} ${err instanceof Error ? err.message : String(err)}`);
    }
    if (execution) store.executionRuntimeHooks().check(execution,"restore_kept_paths");
    try {
      const row = store.getCell(bee.cellId);
      const { restored, conflicts } = row ? restoreKeptPaths(this.cfg.cellsRoot, row.spaceDir) : { restored: [], conflicts: [] };
      if (restored.length > 0 || conflicts.length > 0) {
        this.log(`cell.keep.restored bee=${beeId} cell=${bee.cellId} paths=${restored.length} conflicts=${conflicts.length}${conflicts.length > 0 ? ` ${JSON.stringify(conflicts)}` : ""}`);
      }
    } catch (err) {
      this.log(`cell.keep.restore_failed bee=${beeId} ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * `cell.gc` — plan a retention pass (default dry run) or apply it now. The
   * inspection runs in a worker; apply re-checks every precondition per Cell.
   */
  private async rpcCellGc(params: Record<string, unknown>): Promise<CellGcResult> {
    if (params.dryRun !== undefined && typeof params.dryRun !== "boolean") {
      throw new RpcError("invalid_request", "cell.gc: dryRun must be a boolean when given");
    }
    if (params.measure !== undefined && typeof params.measure !== "boolean") {
      throw new RpcError("invalid_request", "cell.gc: measure must be a boolean when given");
    }
    const retention = this.retention;
    if (!retention) throw new RpcError("node_stopped", "daemon is shutting down");
    return retention.run({ dryRun: params.dryRun !== false, measure: params.measure !== false });
  }

  /** H2: a new Cell is refused with a typed error while the node is below its disk floor with enforcement on. */
  private assertCellAdmission(verb: string): void {
    const refusing = this.retention?.refusingNewCells();
    if (!refusing) return;
    const free = (refusing.cells.freeBytes / 1024 ** 3).toFixed(1);
    const floor = ((refusing.cells.floorBytes ?? 0) / 1024 ** 3).toFixed(1);
    throw new RpcError("resource_blocked", `${verb}: this node is below its disk floor (${free} GiB free, floor ${floor} GiB); new Cells are refused until space is reclaimed (hive cell gc)`);
  }

  /**
   * `cell.park` — park ONE bee's Cell now: the checkout, bee, mailbox and
   * transcript stay; its reproducible ignored paths go (trim patterns, or every
   * ignored path under `cells.retention.purgeIgnoredOnPark`). A live runtime,
   * in-flight Cell operation, move or handoff is a typed refusal; dirty work
   * never blocks a park because parking touches only ignored paths.
   */
  private rpcCellPark(params: Record<string, unknown>): CellParkResult {
    const beeId = this.requireBee(params);
    const store = this.mustStore();
    const bee = store.getBee(beeId);
    const row = bee?.cellId ? store.getCell(bee.cellId) : null;
    if (!bee || bee.substrate !== "cell" || !row || row.state === "removed" || row.state === "removing") {
      throw new RpcError("invalid_request", `cell.park: bee ${beeId} has no Cell allocation`);
    }
    const retention = this.retention;
    if (!retention) throw new RpcError("node_stopped", "daemon is shutting down");
    if (row.state === "evicted") return { cell: row, status: "absent", mode: retention.parkMode(), paths: [], skipped: [], bytes: null, envFiles: [] };
    if (row.state !== "active") throw new RpcError("invalid_request", `cell.park: cell ${row.id} is ${row.state}; only active Cells park`);
    this.releaseAbsentCellOps(row.id);
    if (this.cellHasInFlightOp(row.id)) throw new RpcError("runtime_refused", `cell ${row.id} has an in-flight Cell operation`);
    if (bee.activeMoveId) throw new RpcError("move_in_progress", `bee ${beeId} has a move in flight`);
    if (bee.activeHandoffId) throw new RpcError("handoff_in_progress", `bee ${beeId} has a handoff in flight`);
    const rt = store.currentRuntime(beeId);
    if ((rt && rt.state !== "stopped") || (rt && this.driver?.hasProcess(beeId, rt.generation))) {
      throw new RpcError("runtime_refused", `bee ${beeId} has a live runtime (${rt.state}); a Cell is never parked mid-turn`);
    }
    return retention.parkNow(row, beeId);
  }

  /**
   * `cell.evict` — reclaim ONE bee's Cell directory now, keeping the bee. The
   * A2 dirty guard applies unless `force`; a live runtime or in-flight Cell
   * operation is a typed refusal. Refused-dirty is a RESULT, never an error.
   */
  private rpcCellEvict(params: Record<string, unknown>): CellEvictResult {
    const beeId = this.requireBee(params);
    const store = this.mustStore();
    if (params.force !== undefined && typeof params.force !== "boolean") {
      throw new RpcError("invalid_request", "cell.evict: force must be a boolean when given");
    }
    const force = params.force === true;
    const bee = store.getBee(beeId);
    const row = bee?.cellId ? store.getCell(bee.cellId) : null;
    if (!bee || bee.substrate !== "cell" || !row || row.state === "removed" || row.state === "removing") {
      throw new RpcError("invalid_request", `cell.evict: bee ${beeId} has no Cell allocation`);
    }
    if (row.state === "evicted") return { cell: row, status: "absent", forced: false, report: null, bytes: null, envFiles: [], keptPaths: [] };
    if (row.state !== "active") {
      throw new RpcError("invalid_request", `cell.evict: cell ${row.id} is ${row.state}; retained allocations use cell.retained.remove`);
    }
    this.releaseAbsentCellOps(row.id);
    if (this.cellHasInFlightOp(row.id)) throw new RpcError("runtime_refused", `cell ${row.id} has an in-flight Cell operation`);
    if (bee.activeMoveId) throw new RpcError("move_in_progress", `bee ${beeId} has a move in flight`);
    if (bee.activeHandoffId) throw new RpcError("handoff_in_progress", `bee ${beeId} has a handoff in flight`);
    const rt = store.currentRuntime(beeId);
    if ((rt && rt.state !== "stopped") || (rt && this.driver?.hasProcess(beeId, rt.generation))) {
      throw new RpcError("runtime_refused", `bee ${beeId} has a live runtime (${rt.state}); stop it before evicting its cell`);
    }
    const driver = this.driver;
    if (!driver) throw new RpcError("node_stopped", "daemon is shutting down");
    const wrapperDir = dirname(resolve(row.spaceDir));
    try {
      const parked = evictCellWrapper(this.cfg.cellsRoot, wrapperDir, {
        force,
        trimPatterns: this.cfg.cellRetention.trimPatterns,
        receipts: store.listLandingReceipts(beeId),
        upstream: this.cfg.cellRetention.fetchUpstream ? readUpstreamMirror(row.originRepo, upstreamRootFor(this.cfg.dataDir)) : null,
      });
      driver.cell.forgetCell(beeId);
      if (parked == null) {
        const evicted = store.evictCell(row.id, { head: null, bytes: null, reason: "operator" });
        return { cell: evicted, status: "absent", forced: false, report: null, bytes: null, envFiles: [], keptPaths: [] };
      }
      let evicted: CellRow;
      try {
        evicted = store.evictCell(row.id, { head: parked.head, bytes: null, reason: "operator", envFiles: parked.envFiles, keptPaths: parked.keptPaths });
      } catch (err) {
        try {
          unparkCellWrapper(this.cfg.cellsRoot, wrapperDir, parked);
          this.log(`cell.evict.unparked bee=${beeId} cell=${row.id} err=${JSON.stringify(err instanceof Error ? err.message : String(err))}`);
        } catch (undoErr) {
          this.log(`cell.evict.unpark_failed bee=${beeId} cell=${row.id} parked=${parked.parkedDir} undo_err=${JSON.stringify(undoErr instanceof Error ? undoErr.message : String(undoErr))}`);
        }
        throw err;
      }
      this.log(`cell.evict bee=${beeId} cell=${row.id} forced=${parked.forced} head=${parked.head ?? "-"} parked=${parked.parkedDir} env_files=${parked.envFiles.length} kept=${parked.keptPaths.length}`);
      void this.retention?.sweep();
      return { cell: evicted, status: "evicted", forced: parked.forced, report: parked.report, bytes: null, envFiles: parked.envFiles, keptPaths: parked.keptPaths };
    } catch (err) {
      if (err instanceof CellDeleteRefused) {
        this.log(`cell.evict bee=${beeId} refused dirty=${JSON.stringify(err.report)}`);
        return { cell: row, status: "refused", forced: false, report: err.report, bytes: null, envFiles: [], keptPaths: [] };
      }
      if (err instanceof CellHeadMovedError) throw new RpcError("runtime_refused", err.message);
      throw err;
    }
  }

  private backfillCellRegistry(store: CoreStore): void {
    for (const bee of store.listBees()) {
      if (bee.substrate !== "cell" || bee.cellId) continue;
      try {
        const wrapperDir = dirname(bee.cwd);
        const ledger = readLedger(join(wrapperDir, "box", "cell.json"));
        if (!ledger || ledger.beeId !== bee.id) {
          this.log(`cell.backfill_skip bee=${bee.id} reason=no_ledger`);
          continue;
        }
        const parsed = parseSpaceName(ledger.spaceName);
        if (!parsed) {
          this.log(`cell.backfill_skip bee=${bee.id} reason=malformed_space`);
          continue;
        }
        const identity = localRepoIdentity(ledger.origin) ?? localRepoIdentity(bee.cwd);
        if (!identity) {
          this.log(`cell.backfill_skip bee=${bee.id} reason=no_git_identity`);
          continue;
        }
        store.putCell({
          sourceBeeId: bee.id,
          originRepo: ledger.origin,
          sha: ledger.sha,
          wrapper: ledger.wrapper || basename(wrapperDir),
          spaceName: ledger.spaceName,
          spaceDir: bee.cwd,
          gitCommonDirRealpath: identity.gitCommonDirRealpath,
          objectFormat: identity.objectFormat,
          sandbox: ledger.sandbox ?? null,
        });
        this.log(`cell.backfill bee=${bee.id} space=${bee.cwd}`);
      } catch (err) {
        this.log(`cell.backfill_failed bee=${bee.id} ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private sourceProcessAbsent(beeId: string, generation: number): boolean {
    if (this.driver?.hasProcess(beeId, generation)) return false;
    const rt = this.mustStore().currentRuntime(beeId);
    if (!rt || rt.generation !== generation) return true;
    if (rt.pid != null) {
      const binding = this.mustStore().runtimeProcessIdentity(beeId, generation);
      if (binding.kind === "bound" && verifyProcessIdentity(rt.pid, binding.identity)) return false;
      if (pidAlive(rt.pid)) {
        this.log(`move.source_pid_unverified bee=${beeId} gen=${generation} pid=${rt.pid}`);
        return false;
      }
    }
    return rt.state === "stopped";
  }

  private claudeHomeFor(bee: BeeRow): string {
    const key = homeEnvFor("claude");
    if (bee.account) {
      if (!this.accounts) {
        throw new ContinuationUnsupportedError(`account-bound bee ${bee.id} has no account manager`);
      }
      const account = this.mustStore().getAccount(bee.account);
      if (!account) {
        throw new ContinuationUnsupportedError(`account-bound bee ${bee.id} references unknown account ${bee.account}`);
      }
      const env = this.accounts.homeEnvOf(account);
      const home = key ? env[key] : undefined;
      if (!home) {
        throw new ContinuationUnsupportedError(`account ${bee.account} has no Claude home`);
      }
      return home;
    }
    const fromBee = key ? bee.env[key] : undefined;
    if (fromBee) return fromBee;
    return join(homedir(), ".claude");
  }

  private relocateMoveSession(move: BeeMoveRow, bee: BeeRow): "copied" | "present" | "none" {
    if (bee.agent !== "claude") return "none";
    const seed = bee.providerSessionId ?? bee.forkSeed;
    if (!seed) {
      throw new ContinuationUnsupportedError(
        `claude move ${move.id} has no provider session id; refusing a fresh conversation as continuity`,
      );
    }
    return relocateClaudeSession({
      home: this.claudeHomeFor(bee),
      sessionId: seed,
      fromCwd: move.from.cwd,
      toCwd: move.to.cwd,
      moveId: move.id,
    });
  }

  private validateMoveDestination(move: BeeMoveRow, _bee: BeeRow): void {
    const cwd = move.to.cwd;
    if (!existsSync(cwd)) {
      throw new Error(`destination ${cwd} no longer exists`);
    }
    const identity = localRepoIdentity(cwd);
    const cell = this.mustStore().getCell(move.retainedCellId);
    if (!identity || !cell) {
      throw new Error(`destination ${cwd} is not a git checkout of the retained cell origin`);
    }
    if (
      identity.gitCommonDirRealpath !== cell.repository.gitCommonDirRealpath
      || identity.objectFormat !== cell.repository.objectFormat
    ) {
      throw new Error(`destination repository at ${cwd} no longer matches the retained cell origin`);
    }
    if (move.observedHead) {
      const head = revParse(cwd, "HEAD");
      if (head !== move.observedHead) {
        throw new Error(`destination HEAD at ${cwd} no longer matches observedHead`);
      }
    }
  }

  private localMoveNodeRefused(params: Record<string, unknown>, destination: Record<string, unknown>): void {
    for (const raw of [params.node, destination.node]) {
      if (raw == null) continue;
      if (typeof raw !== "string") {
        throw new RpcError("invalid_request", "bee.move: node must be a string when given");
      }
      const v = raw.trim().toLowerCase();
      if (v === "" || v === "local" || v === "this") continue;
      throw new RpcError("remote_move_unsupported", "bee.move: only the local node is supported");
    }
  }

  private rpcBeeMove(params: Record<string, unknown>): BeeMoveResult {
    const store = this.mustStore();
    const beeId = this.requireBee(params);
    const bee = store.getBee(beeId);
    if (!bee) throw new RpcError("bee_not_found", `bee not found: ${beeId}`);
    const dest = params.destination;
    if (!dest || typeof dest !== "object" || Array.isArray(dest)) {
      throw new RpcError("invalid_request", "bee.move: destination is required");
    }
    const destination = dest as Record<string, unknown>;
    if (destination.kind !== "local_checkout") {
      throw new RpcError("remote_move_unsupported", "bee.move: only local_checkout is supported");
    }
    this.localMoveNodeRefused(params, destination);
    const cwd = destination.cwd;
    if (typeof cwd !== "string" || !isAbsolute(cwd)) {
      throw new RpcError("invalid_request", "bee.move: destination.cwd must be an absolute directory");
    }
    const expectedRaw = params.expected;
    if (!expectedRaw || typeof expectedRaw !== "object" || Array.isArray(expectedRaw)) {
      throw new RpcError("invalid_request", "bee.move: expected {placementVersion, cellId} is required");
    }
    const expected = expectedRaw as { placementVersion?: unknown; cellId?: unknown };
    if (typeof expected.placementVersion !== "number" || typeof expected.cellId !== "string") {
      throw new RpcError("invalid_request", "bee.move: expected.placementVersion and expected.cellId are required");
    }
    const key = this.idempotencyKeyOf(params);
    if (key == null) throw new RpcError("invalid_request", "bee.move: idempotencyKey is required");
    const repo = destination.repository as Record<string, unknown> | undefined;
    const observedHead = destination.observedHead;
    if (typeof observedHead !== "string" || observedHead.length === 0) {
      throw new RpcError("invalid_request", "bee.move: destination.observedHead is required");
    }
    if (
      !repo || repo.version !== 1
      || typeof repo.gitCommonDirRealpath !== "string" || repo.gitCommonDirRealpath.length === 0
      || (repo.objectFormat !== "sha1" && repo.objectFormat !== "sha256")
    ) {
      throw new RpcError("invalid_request", "bee.move: destination.repository {version:1, gitCommonDirRealpath, objectFormat} is required");
    }
    const repository = {
      version: 1 as const,
      gitCommonDirRealpath: repo.gitCommonDirRealpath,
      objectFormat: repo.objectFormat as "sha1" | "sha256",
    };
    const requestHash = hashBeeMoveRequest({
      beeId,
      expected: { placementVersion: expected.placementVersion, cellId: expected.cellId },
      destination: { kind: "local_checkout", cwd, repository, observedHead },
    });
    const existing = store.getBeeMoveByKey(key);
    if (existing) {
      if (existing.requestHash !== requestHash) throw new RpcError("idempotency_conflict", "idempotency key already bound to a different request");
      return { ...toBeeMoveView(existing), deduped: true };
    }
    const continuationOk = (MOVE_CONTINUATION_AGENTS as readonly string[]).includes(bee.agent)
      || (bee.agent === "stub" && this.cfg.cellMoveAllowStub);
    if (!continuationOk) {
      throw new RpcError("continuation_unsupported", `bee.move: agent '${bee.agent}' cannot continue a conversation in a new cwd`);
    }
    if (!existsSync(cwd)) {
      throw new RpcError("invalid_request", "bee.move: destination.cwd must be an existing absolute directory");
    }
    const cell = store.getCell(expected.cellId);
    if (!cell || cell.state === "removed") throw new RpcError("cell_not_found", `cell not found: ${expected.cellId}`);
    const identity = localRepoIdentity(cwd);
    if (!identity) throw new RpcError("repo_mismatch", `bee.move: ${cwd} is not a git checkout`);
    if (
      identity.gitCommonDirRealpath !== repository.gitCommonDirRealpath
      || identity.objectFormat !== repository.objectFormat
      || identity.gitCommonDirRealpath !== cell.repository.gitCommonDirRealpath
      || identity.objectFormat !== cell.repository.objectFormat
    ) {
      throw new RpcError("repo_mismatch", "bee.move: destination is not the same origin checkout");
    }
    const head = revParse(cwd, "HEAD");
    if (head !== observedHead) {
      throw new RpcError("repo_mismatch", "bee.move: destination HEAD does not match observedHead");
    }
    const move = store.admitBeeMove({
      beeId,
      idempotencyKey: key,
      requestHash,
      expected: { placementVersion: expected.placementVersion, cellId: expected.cellId },
      destinationCwd: cwd,
      observedHead,
    });
    this.log(`bee.move bee=${beeId} move=${move.id} phase=${move.phase} dest=${cwd}`);
    return toBeeMoveView(move);
  }

  private rpcBeeMoveGet(params: Record<string, unknown>): BeeMoveResult {
    const moveId = this.param(params, "moveId");
    const move = this.mustStore().getBeeMove(moveId);
    if (!move) throw new RpcError("invalid_request", `bee.move.get: unknown move ${moveId}`);
    return toBeeMoveView(move);
  }

  // -------------------------------------------------------------------------
  // v23 — durable session handoff
  // -------------------------------------------------------------------------

  /**
   * `bee.handoff`: validate everything the daemon owns (target harness spec +
   * adapter, args shape, target account for the TARGET harness, stopAt) with
   * the source untouched, then admit through the core (dedupe by key, CAS on
   * expected.generation, fence, enqueue the stop). Summarization and the
   * switch run later in the daemon loop, never here.
   */
  private async rpcBeeHandoffWithAdmission(params: Record<string, unknown>): Promise<BeeHandoffResult> {
    const key = this.idempotencyKeyOf(params);
    if (key && this.mustStore().getBeeHandoffByKey(key)) return this.rpcBeeHandoff(params);
    const bee = typeof params.beeId === "string" ? this.mustStore().getBee(params.beeId) : null;
    const target = params.target && typeof params.target === "object" && !Array.isArray(params.target)
      ? params.target as Record<string, unknown>
      : null;
    const targetAgent = typeof target?.agent === "string" ? target.agent : null;
    const automatic = target?.account === undefined || target?.account === "auto";
    if (bee && targetAgent && automatic && this.accounts && !this.allocationClaimParam(params)
      && this.accounts.allocationMode() === "shadow") {
      await this.accounts.ensureFreshAdmissionLimits(targetAgent, {
        model: this.modelParamOf({ args: Array.isArray(target?.args) ? target.args : [] }, targetAgent),
      });
    }
    return this.rpcBeeHandoff(params);
  }

  private rpcBeeHandoff(params: Record<string, unknown>): BeeHandoffResult {
    const store = this.mustStore();
    const key = this.idempotencyKeyOf(params);
    if (key == null) throw new RpcError("invalid_request", "bee.handoff: idempotencyKey is required");
    const beeId = this.param(params, "beeId");
    const expectedRaw = params.expected;
    if (expectedRaw === null || typeof expectedRaw !== "object" || Array.isArray(expectedRaw)) {
      throw new RpcError("invalid_request", "bee.handoff: expected {generation, agent?} is required");
    }
    const expectedObj = expectedRaw as Record<string, unknown>;
    if (typeof expectedObj.generation !== "number" || !Number.isInteger(expectedObj.generation) || expectedObj.generation < 0) {
      throw new RpcError("invalid_request", "bee.handoff: expected.generation must be a non-negative integer");
    }
    if (expectedObj.agent !== undefined && (typeof expectedObj.agent !== "string" || expectedObj.agent.length === 0)) {
      throw new RpcError("invalid_request", "bee.handoff: expected.agent must be a non-empty string when given");
    }
    const expected: { generation: number; agent?: string } = {
      generation: expectedObj.generation,
      ...(typeof expectedObj.agent === "string" ? { agent: expectedObj.agent } : {}),
    };
    const targetRaw = params.target;
    if (targetRaw === null || typeof targetRaw !== "object" || Array.isArray(targetRaw)) {
      throw new RpcError("invalid_request", "bee.handoff: target {agent, args?, account?} is required");
    }
    const targetObj = targetRaw as Record<string, unknown>;
    const targetAgent = this.param(targetObj, "agent");
    const instruction = params.instruction === undefined || params.instruction === null
      ? null
      : this.param(params, "instruction");
    const stopAtRaw = params.stopAt ?? "idle";
    if (typeof stopAtRaw !== "string" || !(BEE_HANDOFF_STOP_AT as readonly string[]).includes(stopAtRaw)) {
      throw new RpcError("invalid_request", `bee.handoff: stopAt must be one of ${BEE_HANDOFF_STOP_AT.join("|")}`);
    }
    const stopAt = stopAtRaw as BeeHandoffStopAt;
    const bee = store.getBee(beeId);
    if (!bee) throw new RpcError("bee_not_found", `bee not found: ${beeId}`);
    const existing = store.getBeeHandoffByKey(key);
    // Replays expand omitted defaults against the original source, even after
    // this or a later handoff has changed the bee's harness, args or account.
    const source = existing?.from ?? bee;
    // Args: explicit wins; omitted keeps the bee's args for a same-family
    // handoff and drops them across families (they name another CLI's flags).
    const args = targetObj.args === undefined
      ? (targetAgent === source.agent ? source.args : null)
      : this.argsParam(targetObj, "bee.handoff", true);
    const accountRequest = targetObj.account === undefined
      ? (targetAgent === source.agent && source.account ? source.account : "auto")
      : this.accountParam(targetObj);
    const allocationClaim = this.allocationClaimParam(params);
    const requestShape = {
      beeId,
      expected,
      target: { agent: targetAgent, args, account: accountRequest },
      instruction,
      stopAt,
      allocationClaimId: allocationClaim?.id ?? null,
    };
    const requestHash = hashBeeHandoffRequest(requestShape);
    if (existing) {
      // v28 added the claim identity to the hash. An old pre-v28 automatic
      // handoff had no such field; keep that exact keyed replay valid.
      const legacyHash = allocationClaim
        ? null
        : hashBeeHandoffRequest({ beeId, expected, target: requestShape.target, instruction, stopAt });
      if (existing.requestHash !== requestHash && existing.requestHash !== legacyHash) {
        throw new RpcError("idempotency_conflict", "idempotency key already bound to a different bee.handoff request");
      }
      const replayAdmission = store.getAccountAdmissionByRequestKey(`account-admission:handoff:${key}`);
      return { ...toBeeHandoffView(existing), deduped: true,
        ...(allocationClaim ? { allocation: allocationClaim.allocation, allocationClaimId: allocationClaim.id } : {}),
        ...(!allocationClaim && replayAdmission ? { allocation: replayAdmission.receipt as unknown as AccountAllocationReceipt } : {}) };
    }
    if (bee.lifecycle !== "active") {
      throw new RpcError("lifecycle_refused", `bee.handoff: bee ${beeId} is ${bee.lifecycle}; unarchive it first`);
    }
    if (bee.activeHandoffId) throw new RpcError("handoff_in_progress", `bee ${beeId} already has an in-flight handoff ${bee.activeHandoffId}`);
    if (bee.activeMoveId) throw new RpcError("move_in_progress", `bee ${beeId} has an in-flight move ${bee.activeMoveId}`);
    const targetSpec = this.cfg.agents[targetAgent];
    const targetAdapter = targetSpec?.adapter ?? targetAgent;
    if (!targetSpec || !(ADAPTER_NAMES as readonly string[]).includes(targetAdapter)) {
      throw new RpcError("invalid_request", `bee.handoff: unknown target agent '${targetAgent}' (no spawn spec/adapter configured)`);
    }
    if (bee.substrate === "tmux" && targetAgent !== bee.agent) {
      // The tmux seat's TUI harness is baked into the pane; only the headless substrates re-resolve the harness per generation.
      throw new RpcError("invalid_request", `bee.handoff: bee ${beeId} runs the ${bee.agent} TUI on tmux; cross-family handoff is available on hsr/cell bees`);
    }
    return store.transact(() => {
      const claim = allocationClaim;
      const automatic = targetObj.account === undefined || targetObj.account === "auto";
      if (claim && !automatic) throw new RpcError("invalid_request", "bee.handoff: allocationClaim requires an automatic target account");
      const claimedAccount = claim
        ? this.accountFromClaim(
            claim, "handoff", targetAgent, beeId, expected.generation, source.account,
            this.modelParamOf({ args: args ?? [] }, targetAgent),
          )
        : null;
      if (automatic && this.accounts && !claim && this.accounts.allocationMode() === "active") {
        this.ownerClaimRequired(targetAgent, "handoff");
      }
      const inherited = !claim && targetObj.account === undefined && targetAgent === source.agent && source.account && this.accounts
        ? this.accounts.admitNewWork(targetAgent, {
            operation: "handoff",
            requestKey: key,
            model: this.modelParamOf({ args: args ?? [] }, targetAgent),
            context: this.allocationContextParam(params),
            onlyAccountIds: new Set([source.account]),
            beeId,
            sourceAccount: source.account,
            reconcileAfterGeneration: expected.generation,
          })
        : null;
      if (inherited && !inherited.ok) {
        throw new RpcError(inherited.code, inherited.message, { allocation: inherited.receipt as unknown as Record<string, unknown> });
      }
      const resolved = claimedAccount
        ? { account: claimedAccount, reason: "allocator owner claim", allocation: claim!.allocation, claim, reservationId: undefined }
        : inherited?.ok
        ? { account: inherited.account, reason: inherited.reason, allocation: inherited.receipt, reservationId: inherited.reservation?.id }
        : this.resolveSpawnAccount(accountRequest, targetAgent,
            { args: args ?? [], allocationContext: params.allocationContext, allocationClaim: params.allocationClaim },
            key, "handoff", expected.generation, source.account, beeId);
      const { account, reason, allocation, reservationId } = resolved;
      // The switch installs the target account's home env over the bee's own
      // env minus the SOURCE harness home key (a Codex home must not leak into
      // a Claude runtime and vice versa).
      const env = { ...bee.env };
      const sourceHomeKey = homeEnvFor(bee.agent);
      if (sourceHomeKey) delete env[sourceHomeKey];
      const targetHomeKey = homeEnvFor(targetAgent);
      if (targetHomeKey) delete env[targetHomeKey];
      const targetEnv = { ...env, ...(account && this.accounts ? this.accounts.homeEnvOf(account) : {}) };
      // The target segment's log lives beside the bee's canonical Honeybee log
      // (never beside a foreign/imported transcript path).
      const nextOrdinal = (store.currentTranscriptSegment(beeId)?.ordinal ?? 0) + 1;
      const targetSessionLogPath = bee.substrate === "tmux" && !this.cfg.sessionLogDir
        ? null
        : segmentSessionLogPath(this.canonicalSessionLogPath(beeId), nextOrdinal);
      const handoff = store.admitBeeHandoff({
        beeId,
        idempotencyKey: key,
        requestHash,
        expected,
        target: { agent: targetAgent, args, account: account?.id ?? null, env: targetEnv },
        instruction,
        stopAt,
        targetSessionLogPath,
      });
      if (claim) this.consumeAccountClaim(claim, beeId);
      else if (reservationId) store.bindAccountAdmission(reservationId, beeId);
      this.log(
        `bee.handoff bee=${beeId} handoff=${handoff.id} ${bee.agent}→${targetAgent} gen=${handoff.sourceGeneration} stopAt=${stopAt} account=${account?.id ?? "-"}${reason ? ` reason=${JSON.stringify(reason)}` : ""}`,
      );
      return { ...toBeeHandoffView(handoff), ...(allocation ? { allocation } : {}),
        ...(claim ? { allocationClaimId: claim.id } : {}) };
    });
  }

  /** A session log path this daemon owns (under its sessionLogDir); anything else is foreign evidence. */
  private ownedSessionLogPath(path: string | null): string | null {
    if (!path) return null;
    const dir = resolve(this.cfg.sessionLogDir);
    const target = resolve(path);
    return target.startsWith(`${dir}/`) ? target : null;
  }

  /** The canonical Honeybee session log for a bee (segment 0), whatever the row says. */
  private canonicalSessionLogPath(beeId: string): string {
    return join(this.cfg.sessionLogDir, `${beeId}.jsonl`);
  }

  // -------------------------------------------------------------------------
  // v24 — durable per-bee action queue
  // -------------------------------------------------------------------------

  private objectParam(params: Record<string, unknown>, key: string, verb: string): Record<string, unknown> | undefined {
    const v = params[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "object" || Array.isArray(v)) throw new RpcError("invalid_request", `${verb}: ${key} must be an object`);
    return v as Record<string, unknown>;
  }

  private optionalBool(params: Record<string, unknown>, key: string, verb: string): boolean {
    const v = params[key];
    if (v === undefined || v === null) return false;
    if (typeof v !== "boolean") throw new RpcError("invalid_request", `${verb}: ${key} must be a boolean when given`);
    return v;
  }

  private optionalString(params: Record<string, unknown>, key: string, verb: string): string | null {
    const v = params[key];
    if (v === undefined || v === null) return null;
    if (typeof v !== "string") throw new RpcError("invalid_request", `${verb}: ${key} must be a string when given`);
    return v;
  }

  private actionQueueView(store: CoreStore, beeId: string): ActionQueueView {
    const queue = store.getActionQueue(beeId);
    if (queue) return toActionQueueView(queue);
    const at = this.nowMs();
    return { beeId, paused: false, pausedAt: null, activeActionId: null, counts: emptyActionCounts(), createdAt: at, updatedAt: at };
  }

  private nowMs(): number {
    return Date.now();
  }

  private rpcActionEnqueue(params: Record<string, unknown>): ActionEnqueueResult {
    const store = this.mustStore();
    const beeId = this.requireBee(params);
    const key = this.idempotencyKeyOf(params);
    if (key == null) throw new RpcError("invalid_request", "action.enqueue: idempotencyKey is required");
    const rawItems = params.items;
    if (!Array.isArray(rawItems) || rawItems.length === 0) throw new RpcError("invalid_request", "action.enqueue: items must be a non-empty array");
    const items = rawItems.map((raw, index) => {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new RpcError("invalid_request", `action.enqueue: items[${index}] must be an object`);
      const item = raw as Record<string, unknown>;
      if (typeof item.kind !== "string" || item.kind.length === 0) throw new RpcError("invalid_request", `action.enqueue: items[${index}].kind is required`);
      const version = item.version === undefined || item.version === null ? null : item.version;
      if (version !== null && (typeof version !== "number" || !Number.isInteger(version) || version < 1)) {
        throw new RpcError("invalid_request", `action.enqueue: items[${index}].version must be a positive integer when given`);
      }
      const inputs = this.objectParam(item, "inputs", `action.enqueue items[${index}]`) ?? {};
      const clientRef = this.optionalString(item, "clientRef", `action.enqueue items[${index}]`);
      const title = this.optionalString(item, "title", `action.enqueue items[${index}]`);
      return { kind: item.kind, version, inputs, clientRef, title };
    });
    const requestHash = hashActionEnqueueRequest({ beeId, items });
    const res = store.enqueueActions({ beeId, idempotencyKey: key, requestHash, items });
    this.log(`action.enqueue bee=${beeId} key=${key} items=${items.map((i) => i.kind).join(",")} deduped=${res.deduped}`);
    const lane = store.listActionsOf(beeId);
    const queue = store.getActionQueue(beeId);
    return {
      actions: res.actions.map((row) => toActionView(row, lane, queue)),
      queue: this.actionQueueView(store, beeId),
      deduped: res.deduped,
    };
  }

  private rpcActionGet(params: Record<string, unknown>): ActionGetResult {
    const store = this.mustStore();
    const actionId = this.param(params, "actionId");
    if (!store.getAction(actionId)) throw new RpcError("action_not_found", `action not found: ${actionId}`);
    return { action: store.actionView(actionId) };
  }

  private rpcActionList(params: Record<string, unknown>): ActionListResult {
    const store = this.mustStore();
    const beeId = params.beeId === undefined || params.beeId === null ? undefined : this.requireBee(params);
    const statuses = this.stringListParam(params, "statuses", "action.list");
    if (statuses && statuses.some((s) => !(ACTION_STATUSES as readonly string[]).includes(s))) {
      throw new RpcError("invalid_request", `action.list: statuses must be among ${ACTION_STATUSES.join("|")}`);
    }
    return { actions: store.listActionViews({ ...(beeId ? { beeId } : {}), ...(statuses ? { statuses: statuses as ActionStatus[] } : {}) }) };
  }

  private rpcActionCancel(params: Record<string, unknown>): ActionCancelResult {
    const store = this.mustStore();
    const actionId = this.param(params, "actionId");
    if (!store.getAction(actionId)) throw new RpcError("action_not_found", `action not found: ${actionId}`);
    const force = this.optionalBool(params, "force", "action.cancel");
    const res = store.cancelAction(actionId, { force });
    this.log(`action.cancel action=${actionId} force=${force} applied=${res.applied} status=${res.action.status}`);
    return res;
  }

  private rpcActionRetry(params: Record<string, unknown>): ActionRetryResult {
    const store = this.mustStore();
    const actionId = this.param(params, "actionId");
    if (!store.getAction(actionId)) throw new RpcError("action_not_found", `action not found: ${actionId}`);
    const force = this.optionalBool(params, "force", "action.retry");
    const res = store.retryAction(actionId, { force });
    this.log(`action.retry action=${actionId} force=${force} attempt=${res.action.attempt} status=${res.action.status}`);
    return res;
  }

  /**
   * `action.complete` (bee.actions.complete.v1): the operator settles an open or failed agent action. For
   * `commit`, an omitted `commitSha` is read from the bee's checkout HEAD
   * (the Cell space for Cell bees, else the bee's cwd), with `branch` when
   * HEAD is on one; an unreadable HEAD is `invalid_request`.
   */
  private rpcActionComplete(params: Record<string, unknown>): ActionCompleteResult {
    const store = this.mustStore();
    const actionId = this.param(params, "actionId");
    const row = store.getAction(actionId);
    if (!row) throw new RpcError("action_not_found", `action not found: ${actionId}`);
    const raw = this.objectParam(params, "outputs", "action.complete") ?? {};
    const outputs: Record<string, string> = {};
    for (const [name, value] of Object.entries(raw)) {
      if (typeof value !== "string") throw new RpcError("invalid_request", `action.complete: outputs.${name} must be a string`);
      outputs[name] = value;
    }
    const detail = this.optionalString(params, "detail", "action.complete");
    // Refusals first: a closed or non-agent action never needs (or reads) a HEAD.
    if (row.kind === "commit" && deriveActionControls(row).complete && outputs.commitSha === undefined) {
      const dir = this.checkoutDirOf(store, row.beeId);
      const head = dir ? revParse(dir, "HEAD") : null;
      if (!head) {
        throw new RpcError("invalid_request", `action.complete: could not read the HEAD of bee ${row.beeId}'s checkout${dir ? ` (${dir})` : ""}; pass outputs.commitSha`);
      }
      outputs.commitSha = head;
      if (outputs.branch === undefined) {
        const branch = currentBranch(dir as string);
        if (branch) outputs.branch = branch;
      }
    }
    const res = store.completeAction(actionId, { outputs, detail });
    this.log(`action.complete action=${actionId} kind=${row.kind} attempt=${res.action.attempt} applied=${res.applied} status=${res.action.status}`);
    return res;
  }

  /** The directory holding the bee's working checkout: its Cell space when it is on a Cell, else its cwd. */
  private checkoutDirOf(store: CoreStore, beeId: string): string | null {
    const bee = store.getBee(beeId);
    if (!bee) return null;
    const dir = bee.substrate === "cell" ? (this.driver?.cell.cellOf(beeId)?.paths.spaceDir ?? bee.cwd) : bee.cwd;
    return dir && existsSync(dir) ? dir : null;
  }

  private rpcActionReorder(params: Record<string, unknown>): ActionReorderResult {
    const store = this.mustStore();
    const beeId = this.requireBee(params);
    const order = this.stringListParam(params, "order", "action.reorder");
    if (!order) throw new RpcError("invalid_request", "action.reorder: order must be an array of action ids");
    const res = store.reorderActions(beeId, order);
    this.log(`action.reorder bee=${beeId} order=${order.join(",")}`);
    return res;
  }

  private rpcActionQueueControl(params: Record<string, unknown>, verb: "pause" | "resume"): ActionQueueControlResult {
    const store = this.mustStore();
    const beeId = this.requireBee(params);
    const res = verb === "pause" ? store.pauseActionQueue(beeId) : store.resumeActionQueue(beeId);
    this.log(`action.queue.${verb} bee=${beeId} applied=${res.applied}`);
    return res;
  }

  private rpcActionReportIdempotent(params: Record<string, unknown>): ActionReportResult | (ActionReportResult & { deduped: true }) {
    const key = this.idempotencyKeyOf(params);
    const store = this.mustStore();
    if (key != null) {
      const hit = store.lookupRpcResult(key);
      if (hit) {
        this.log(`rpc.dedup verb=action.report key=${key}`);
        return { ...(hit.result as ActionReportResult), deduped: true as const };
      }
    }
    const result = this.rpcActionReport(params);
    if (key != null) store.transact(() => store.recordRpcResult(key, "action.report", null, result));
    return result;
  }

  private rpcActionReport(params: Record<string, unknown>): ActionReportResult {
    const store = this.mustStore();
    const actionId = this.param(params, "actionId");
    if (!store.getAction(actionId)) throw new RpcError("action_not_found", `action not found: ${actionId}`);
    const attempt = this.numberParam(params, "attempt");
    const token = this.param(params, "token");
    const kind = params.kind;
    if (kind !== "progress" && kind !== "question" && kind !== "result") {
      throw new RpcError("invalid_request", "action.report: kind must be progress|question|result");
    }
    const beeId = this.optionalString(params, "beeId", "action.report");
    if (beeId !== null && !store.getBee(beeId)) throw new RpcError("bee_not_found", `bee not found: ${beeId}`);
    const executor = this.optionalString(params, "executor", "action.report");
    const outcome = params.outcome === undefined || params.outcome === null ? null : params.outcome;
    if (outcome !== null && outcome !== "succeeded" && outcome !== "failed" && outcome !== "uncertain") {
      throw new RpcError("invalid_request", "action.report: outcome must be succeeded|failed|uncertain");
    }
    if (kind === "result" && outcome === null) throw new RpcError("invalid_request", "action.report: result reports need an outcome");
    const question = this.objectParam(params, "question", "action.report");
    if (kind === "question" && (!question || typeof question.text !== "string" || question.text.length === 0)) {
      throw new RpcError("invalid_request", "action.report: question reports need question.text");
    }
    const failure = this.objectParam(params, "failure", "action.report");
    const res = store.reportAction({
      actionId,
      attempt,
      token,
      reporter: { beeId, executor },
      kind,
      note: this.optionalString(params, "note", "action.report"),
      question: question
        ? { text: String(question.text), options: this.stringListParam(question, "options", "action.report question") ?? null }
        : null,
      outcome: outcome as ActionReportOutcome | null,
      outputs: this.objectParam(params, "outputs", "action.report") ?? null,
      receipt: this.objectParam(params, "receipt", "action.report") ?? null,
      detail: this.optionalString(params, "detail", "action.report"),
      failure: failure
        ? {
            code: this.optionalString(failure, "code", "action.report failure"),
            detail: this.optionalString(failure, "detail", "action.report failure"),
            retryable: typeof failure.retryable === "boolean" ? failure.retryable : null,
          }
        : null,
    });
    this.log(`action.report action=${actionId} attempt=${attempt} kind=${kind}${outcome ? ` outcome=${outcome}` : ""} by=${beeId ?? executor ?? "?"} applied=${res.applied} status=${res.action.status}`);
    return res;
  }

  private rpcActionClaim(params: Record<string, unknown>): ActionClaimResult {
    const store = this.mustStore();
    const executor = this.param(params, "executor");
    const actionId = this.optionalString(params, "actionId", "action.claim");
    if (actionId !== null && !store.getAction(actionId)) throw new RpcError("action_not_found", `action not found: ${actionId}`);
    const beeId = params.beeId === undefined || params.beeId === null ? null : this.requireBee(params);
    const kinds = this.stringListParam(params, "kinds", "action.claim") ?? null;
    const res = store.claimAction({ executor, actionId, kinds, beeId });
    if (!res) return { claim: null };
    this.log(`action.claim executor=${executor} action=${res.action.id} attempt=${res.action.attempt} deduped=${res.deduped}`);
    return { claim: { action: res.action, attempt: res.action.attempt, token: res.token, resolvedInputs: res.resolvedInputs, deduped: res.deduped } };
  }

  /**
   * The Cell landing owner as the action scheduler sees it: registry + driver
   * facts, the real `captureWork`, and a read-only landed probe for recovery.
   */
  private cellCaptureExecutor(store: CoreStore): CellCaptureExecutor {
    const cellOf = (beeId: string) => {
      const bee = store.getBee(beeId);
      if (!bee || bee.substrate !== "cell" || !bee.cellId) return null;
      const row = store.getCell(bee.cellId);
      if (!row || row.state !== "active") return null;
      const cell = this.driver?.cell.cellOf(beeId);
      if (!cell) return null;
      return { row, cell };
    };
    return {
      inspect: (beeId) => {
        const found = cellOf(beeId);
        if (!found) return null;
        this.releaseAbsentCellOps(found.row.id);
        return {
          cellId: found.row.id,
          originRepo: found.cell.originRepo,
          spaceDir: found.cell.paths.spaceDir,
          head: revParse(found.cell.paths.spaceDir, "HEAD"),
          busy: this.cellHasInFlightOp(found.row.id),
        };
      },
      capture: (beeId, opts) => {
        const driver = this.driver;
        if (!driver) throw new Error("daemon is shutting down");
        return driver.cell.capture(beeId, opts);
      },
      landed: (beeId, opts) => {
        const found = cellOf(beeId);
        if (!found) return null;
        const tip = revParse(found.cell.originRepo, `refs/heads/${opts.targetBranch}`);
        if (tip === null) return { landed: false, targetTip: null };
        return { landed: isAncestor(found.cell.originRepo, opts.cellHead, tip), targetTip: tip };
      },
    };
  }

  private rpcBeeHandoffGet(params: Record<string, unknown>): BeeHandoffGetResult {
    const handoffId = this.param(params, "handoffId");
    const handoff = this.mustStore().getBeeHandoff(handoffId);
    if (!handoff) throw new RpcError("handoff_not_found", `handoff not found: ${handoffId}`);
    return toBeeHandoffView(handoff);
  }

  /**
   * Bounded read of the source transcript for the context artifact: the
   * tail of every pre-handoff segment's session log, rendered with the
   * harness that WROTE it (never the target's). Runs after the source is
   * quiesced (its host has closed the file), off the RPC path.
   */
  private readHandoffTranscript(bee: BeeRow, segments: TranscriptSegmentRow[]): { turns: HandoffContextTurn[]; truncated: boolean } {
    const turns: HandoffContextTurn[] = [];
    let truncated = false;
    let budget = HANDOFF_TRANSCRIPT_TAIL_BYTES;
    // Newest segment first so the tail budget favors recent history.
    const ordered = [...segments].sort((a, b) => b.ordinal - a.ordinal);
    const rendered: Array<{ ordinal: number; turns: HandoffContextTurn[] }> = [];
    for (const segment of ordered) {
      if (!segment.path || !existsSync(segment.path) || budget <= 0) {
        if (segment.path && budget <= 0) truncated = true;
        continue;
      }
      const size = statSync(segment.path).size;
      const start = Math.max(0, size - budget);
      if (start > 0) truncated = true;
      const buf = Buffer.alloc(size - start);
      const fd = openSync(segment.path, "r");
      try {
        readSync(fd, buf, 0, buf.length, start);
      } finally {
        closeSync(fd);
      }
      budget -= buf.length;
      let text = buf.toString("utf8");
      if (start > 0) {
        const nl = text.indexOf("\n");
        text = nl < 0 ? "" : text.slice(nl + 1);
      }
      const lines = text.split("\n").filter((l) => l.length > 0);
      rendered.push({ ordinal: segment.ordinal, turns: renderTranscriptLines(segment.harness, lines) });
    }
    rendered.sort((a, b) => a.ordinal - b.ordinal);
    for (const r of rendered) turns.push(...r.turns);
    return { turns, truncated };
  }

  private cellExecResultFromOp(
    op: { id: string; cellId: string; status: CellOpRow["status"]; exitCode: number | null; stdout: string; stderr: string; truncated: boolean; timeoutMs: number | null; failure: string | null },
    deduped: boolean,
  ): CellExecResult {
    const failure = op.failure ?? "";
    let reason: CellExecResult["reason"] = null;
    if (op.status === "failed") {
      if (failure === "busy") reason = "busy";
      else if (failure === "secret_execution_containment_unavailable") reason = "secret_execution_containment_unavailable";
      else if (failure === "cell_runtime_live") reason = "cell_runtime_live";
      else if (failure === "no_cell") reason = "no_cell";
      else if (failure === "containment" || /escapes|space-relative|does not exist/.test(failure)) reason = "containment";
      else if (failure && failure !== "timeout" && failure !== "interrupted") reason = "argv_invalid";
    }
    return {
      id: op.id,
      cellId: op.cellId,
      status: op.status,
      exitCode: op.exitCode,
      stdout: op.stdout,
      stderr: op.stderr,
      truncated: op.truncated,
      timeoutMs: op.timeoutMs ?? 0,
      reason,
      ...(deduped ? { deduped: true } : {}),
    };
  }

  private cellOpProcessPresent(op: CellOpRow): boolean {
    if (op.pid == null) return false;
    if (pidAlive(op.pid)) {
      this.log(`cell_op.pid_unverified op=${op.id} pid=${op.pid}`);
      return true;
    }
    return false;
  }

  /**
   * Gate: a known live PID holds. A missing exec PID is a possible orphan —
   * elapsed time is not absence, and `outcome_unknown` with
   * `process_identity_unavailable` stays closed regardless of status.
   * A known PID that is gone releases. Remove has no child process and never
   * holds this gate.
   */
  private cellOpHoldsGate(op: CellOpRow): boolean {
    if (op.kind === "remove") return false;
    if (op.pid != null) return this.cellOpProcessPresent(op);
    if (op.failure === "process_identity_unavailable") return true;
    return op.status === "queued" || op.status === "running";
  }

  private cellHasInFlightOp(cellId: string, exceptKey?: string): boolean {
    return this.mustStore().listCellOps().some(
      (op) => op.cellId === cellId && op.idempotencyKey !== exceptKey && this.cellOpHoldsGate(op),
    );
  }

  private settleAbsentCellOp(op: CellOpRow, failure: string): void {
    this.mustStore().updateCellOp(op.id, { status: "outcome_unknown", failure });
    this.log(`cell_op.unknown op=${op.id} cell=${op.cellId} failure=${failure}`);
  }

  /**
   * Exec only for process identity. Queued/pre-PID → unknown +
   * process_identity_unavailable (gate stays closed). Known dead PID →
   * unknown + process_absent (gate releases). Never replay argv.
   * Remove: wrapper still present → unknown/refused and no gate; wrapper
   * gone is left running for filesystem recovery on the remove RPC.
   */
  private reconcileCellOpsAtBoot(): void {
    const store = this.mustStore();
    for (const op of store.listCellOps()) {
      if (op.kind === "remove") {
        if (op.status !== "queued" && op.status !== "running") continue;
        const cell = store.getCell(op.cellId);
        if (!cell || cell.state === "removed") continue;
        const parsed = parseSpaceName(cell.spaceName);
        const gone = !parsed
          || !existsSync(cellPaths(this.cfg.cellsRoot, cell.wrapper, parsed.repoName, parsed.cellId).wrapperDir);
        if (!gone) {
          store.updateCellOp(op.id, {
            status: "outcome_unknown",
            failure: "daemon_restart",
            stdout: JSON.stringify({ status: "refused", forced: false, report: null }),
          });
        }
        continue;
      }
      if (op.kind !== "exec") continue;
      if (op.status === "queued" || (op.status === "running" && op.pid == null)) {
        this.settleAbsentCellOp(op, "process_identity_unavailable");
      } else if (op.status === "running" && op.pid != null && !this.cellOpProcessPresent(op)) {
        this.settleAbsentCellOp(op, "process_absent");
      }
    }
  }

  private releaseAbsentCellOps(cellId: string): void {
    for (const op of this.mustStore().listCellOps()) {
      if (op.cellId !== cellId || op.kind !== "exec" || op.status !== "running") continue;
      if (this.cellOpHoldsGate(op)) continue;
      this.settleAbsentCellOp(op, "process_absent");
    }
  }

  private async rpcCellExecSecret(params: Record<string, unknown>, conn: RpcConn): Promise<CellExecResult> {
    const admission = admitSecretExecution(params, conn.secretExecution, conn.secretExecutionNodeId);
    try {
      const bee = this.mustStore().getBee(admission.beeId);
      const cell = this.mustStore().getCell(admission.cellId);
      if (!bee || bee.lifecycle !== "active" || !cell || cell.sourceBeeId !== bee.id || cell.state === "removed" || cell.state === "evicted") throw new RpcError("invalid_request", "secret_execution_refused");
      return await this.rpcCellExec(params, admission, conn.captureSecretOutput);
    } catch (error) {
      if (error instanceof RpcError) throw error;
      throw new RpcError("invalid_request", "secret_execution_failed");
    } finally {
      for (const name of Object.keys(admission.env)) delete admission.env[name];
      if (conn.secretExecution) for (const name of Object.keys(conn.secretExecution.env ?? {})) delete conn.secretExecution.env![name];
    }
  }

  private async rpcCellExec(params: Record<string, unknown>, secret?: import("./protocol.ts").SecretExecutionContext, captureSecretOutput?: (leaseId: string, bytes: Buffer) => void): Promise<CellExecResult> {
    const store = this.mustStore();
    const cellId = this.param(params, "cellId");
    this.releaseAbsentCellOps(cellId);
    const key = this.idempotencyKeyOf(params);
    if (key == null) throw new RpcError("invalid_request", "cell.exec: idempotencyKey is required");
    const argv = params.argv;
    if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== "string")) {
      throw new RpcError("invalid_request", "cell.exec: argv must be a non-empty string array");
    }
    if (params.timeoutMs !== undefined && typeof params.timeoutMs !== "number") {
      throw new RpcError("invalid_request", "cell.exec: timeoutMs must be a number when given");
    }
    if (params.cwd !== undefined && typeof params.cwd !== "string") {
      throw new RpcError("invalid_request", "cell.exec: cwd must be a string when given");
    }
    const timeoutMs = params.timeoutMs;
    const cwd = params.cwd;
    const hash = hashCellOpRequest({ cellId, kind: "exec", argv, cwd: cwd ?? null, timeoutMs: timeoutMs ?? null, ...(secret ? { secretExecution: { beeId: secret.beeId, nodeId: secret.nodeId, executionId: secret.executionId, argvDigest: secret.argvDigest, ...(secret.outputCapture ? { outputCapture: secret.outputCapture } : {}) } } : {}) });
    const existing = store.getCellOpByKey(key);
    if (existing) {
      if (existing.requestHash !== hash || existing.kind !== "exec" || existing.cellId !== cellId) {
        throw new RpcError("idempotency_conflict", "idempotency key already bound to a different cell.exec request");
      }
      if (existing.status === "running") {
        if (existing.pid != null && this.cellOpProcessPresent(existing)) {
          return this.cellExecResultFromOp(existing, true);
        }
        const failure = existing.pid == null ? "process_identity_unavailable" : "process_absent";
        const unknown = store.updateCellOp(existing.id, { status: "outcome_unknown", failure });
        return this.cellExecResultFromOp(unknown, true);
      }
      if (existing.status !== "queued") return this.cellExecResultFromOp(existing, true);
    }
    const cell = store.getCell(cellId);
    if (!cell || cell.state === "removed") {
      return { id: existing?.id ?? "", cellId, status: "failed", exitCode: null, stdout: "", stderr: "", truncated: false, timeoutMs: 0, reason: "no_cell" };
    }
    const busy = this.cellHasInFlightOp(cellId, key);
    const persistRefusal = (failure: "busy" | "cell_runtime_live"): CellExecResult => {
      const op = store.putCellOp({
        cellId,
        kind: "exec",
        idempotencyKey: key,
        requestHash: hash,
        argv: argv as string[],
        cwd: cwd ?? null,
        timeoutMs: timeoutMs ?? null,
      });
      return this.cellExecResultFromOp(store.updateCellOp(op.id, { status: "failed", failure }), false);
    };
    if (busy) return persistRefusal("busy");
    if (!secret && this.driver?.cell.hasProcess(cell.sourceBeeId, store.currentRuntime(cell.sourceBeeId)?.generation ?? 0)) {
      return persistRefusal("cell_runtime_live");
    }
    const op = existing ?? store.putCellOp({
      cellId,
      kind: "exec",
      idempotencyKey: key,
      requestHash: hash,
      argv: argv as string[],
      cwd: cwd ?? null,
      timeoutMs: timeoutMs ?? null,
    });
    // Persist attempted before OS spawn so a death before PID-save never replays argv.
    if (op.status === "queued") store.updateCellOp(op.id, { status: "running" });
    const parsed = parseSpaceName(cell.spaceName);
    if (!parsed) throw new RpcError("invalid_request", `cell.exec: malformed space name ${cell.spaceName}`);
    const paths = cellPaths(this.cfg.cellsRoot, cell.wrapper, parsed.repoName, parsed.cellId);
    const controller = secret ? new AbortController() : undefined;
    if (secret && controller) this.secretExecutions.set(secret.executionId, { beeId: secret.beeId, cellId, nodeId: secret.nodeId, controller });
    try {
      if (secret && (secret.expiresAt <= Date.now() || secret.outputCapture && secret.outputCapture.expiresAt <= Date.now())) throw new Error("secret_execution_expired");
      const outcome = await runCellExec(
        paths,
        {
          argv: argv as string[],
          cwd,
          timeoutMs,
          sandbox: cell.sandbox,
          nodeKind: this.cfg.nodeKind,
          kvm: this.cfg.cellKvm,
          ...(secret ? { secretEnv: secret.outputCapture ? undefined : secret.env, ...(secret.outputCapture ? { outputCapture: { maxBytes: secret.outputCapture.maxBytes, expiresAt: secret.outputCapture.expiresAt, receive: (bytes: Buffer) => captureSecretOutput?.(secret.outputCapture!.leaseId, bytes) } } : {}), signal: controller!.signal } : {}),

        },
        (spawned) => {
          store.updateCellOp(op.id, { pid: spawned.pid, pidStartedAt: spawned.pidStartedAt });
        },
      );
      const saved = store.updateCellOp(op.id, {
        status: outcome.status === "timeout" || outcome.status === "interrupted" ? "failed" : "done",
        pid: outcome.pid,
        pidStartedAt: outcome.pidStartedAt,
        exitCode: outcome.exitCode,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        truncated: outcome.truncated,
        failure: outcome.status === "timeout" ? "timeout" : outcome.status === "interrupted" ? "interrupted" : null,
      });
      return this.cellExecResultFromOp({ ...saved, timeoutMs: saved.timeoutMs ?? outcome.timeoutMs }, false);
    } catch (err) {
      const detail = secret ? err instanceof Error && err.message === "secret_execution_containment_unavailable" ? err.message : "secret_execution_failed" : err instanceof Error ? err.message : String(err);
      const reason = detail === "secret_execution_containment_unavailable" ? "secret_execution_containment_unavailable" : /escapes|space-relative|does not exist/.test(detail) ? "containment" : "argv_invalid";
      const saved = store.updateCellOp(op.id, { status: "failed", failure: reason === "containment" ? "containment" : detail });
      return { ...this.cellExecResultFromOp(saved, false), reason, stderr: detail, timeoutMs: timeoutMs ?? 0 };
    } finally {
      if (secret) this.secretExecutions.delete(secret.executionId);
    }
  }

  private parseRetainedRemoveResult(op: { stdout: string; status: string }, cell: CellRow, deduped: boolean): CellRetainedRemoveResult {
    let parsed: { status?: CellRetainedRemoveResult["status"]; forced?: boolean; report?: CellRetainedRemoveResult["report"] } = {};
    try {
      parsed = op.stdout ? JSON.parse(op.stdout) as typeof parsed : {};
    } catch {
      parsed = {};
    }
    const status = parsed.status
      ?? (cell.state === "removed" ? "deleted"
        : op.status === "failed" || op.status === "outcome_unknown" ? "refused"
        : "absent");
    return {
      cell,
      status,
      forced: parsed.forced === true,
      report: parsed.report ?? null,
      ...(deduped ? { deduped: true } : {}),
    };
  }

  private rpcCellRetainedRemove(params: Record<string, unknown>): CellRetainedRemoveResult {
    const store = this.mustStore();
    const cellId = this.param(params, "cellId");
    this.releaseAbsentCellOps(cellId);
    const key = this.idempotencyKeyOf(params);
    if (key == null) throw new RpcError("invalid_request", "cell.retained.remove: idempotencyKey is required");
    if (params.force !== undefined && typeof params.force !== "boolean") {
      throw new RpcError("invalid_request", "cell.retained.remove: force must be a boolean when given");
    }
    const force = params.force === true;
    const hash = hashCellOpRequest({ cellId, kind: "remove", force });
    const existing = store.getCellOpByKey(key);
    if (existing) {
      if (existing.requestHash !== hash || existing.kind !== "remove" || existing.cellId !== cellId) {
        throw new RpcError("idempotency_conflict", "idempotency key already bound to a different cell.retained.remove request");
      }
      const cell = store.getCell(cellId);
      if (!cell) throw new RpcError("cell_not_found", `cell not found: ${cellId}`);
      if (existing.status === "done" || existing.status === "failed" || existing.status === "outcome_unknown") {
        return this.parseRetainedRemoveResult(existing, cell, true);
      }
      if (existing.status === "running") {
        const parsed = parseSpaceName(cell.spaceName);
        const gone = parsed
          ? !existsSync(cellPaths(this.cfg.cellsRoot, cell.wrapper, parsed.repoName, parsed.cellId).wrapperDir)
          : cell.state === "removed";
        if (gone) {
          const marked = cell.state === "removed" ? cell : store.markCellRemoved(cellId);
          const saved = store.updateCellOp(existing.id, {
            status: "done",
            stdout: JSON.stringify({ status: "deleted", forced: force, report: null }),
          });
          return this.parseRetainedRemoveResult(saved, marked, true);
        }
        const unknown = store.updateCellOp(existing.id, {
          status: "outcome_unknown",
          failure: "daemon_restart",
          stdout: JSON.stringify({ status: "refused", forced: false, report: null }),
        });
        return this.parseRetainedRemoveResult(unknown, cell, true);
      }
    }
    const cell = store.getCell(cellId);
    if (!cell) throw new RpcError("cell_not_found", `cell not found: ${cellId}`);
    if (cell.state === "removed") return { cell, status: "absent", forced: false, report: null };
    if (cell.state !== "retained") {
      throw new RpcError("invalid_request", `cell.retained.remove: cell ${cellId} is ${cell.state}, not retained`);
    }
    if (this.cellHasInFlightOp(cellId, key)) {
      throw new RpcError("runtime_refused", `cell ${cellId} has an in-flight Cell operation`);
    }
    const driver = this.driver;
    if (!driver) throw new RpcError("node_stopped", "daemon is shutting down");
    if (driver.cell.hasProcess(cell.sourceBeeId, store.currentRuntime(cell.sourceBeeId)?.generation ?? 0)) {
      throw new RpcError("runtime_refused", `cell ${cellId} still has a live Cell runtime`);
    }
    const op = existing ?? store.putCellOp({ cellId, kind: "remove", idempotencyKey: key, requestHash: hash });
    const parsed = parseSpaceName(cell.spaceName);
    if (!parsed) throw new RpcError("invalid_request", `cell.retained.remove: malformed space name ${cell.spaceName}`);
    const paths = cellPaths(this.cfg.cellsRoot, cell.wrapper, parsed.repoName, parsed.cellId);
    store.updateCellOp(op.id, { status: "running" });
    try {
      if (!existsSync(paths.wrapperDir)) {
        const marked = store.markCellRemoved(cellId);
        const saved = store.updateCellOp(op.id, {
          status: "done",
          stdout: JSON.stringify({ status: "absent", forced: false, report: null }),
        });
        return this.parseRetainedRemoveResult(saved, marked, false);
      }
      const res = deleteCell(paths.wrapperDir, { force, receipts: store.listLandingReceipts(cell.sourceBeeId) });
      const marked = store.markCellRemoved(cellId);
      const status = res.deleted ? "deleted" : "absent";
      const saved = store.updateCellOp(op.id, {
        status: "done",
        stdout: JSON.stringify({ status, forced: res.forced, report: res.report }),
      });
      return this.parseRetainedRemoveResult(saved, marked, false);
    } catch (err) {
      if (err instanceof CellDeleteRefused) {
        const saved = store.updateCellOp(op.id, {
          status: "done",
          stdout: JSON.stringify({ status: "refused", forced: false, report: err.report }),
        });
        return this.parseRetainedRemoveResult(saved, cell, false);
      }
      store.updateCellOp(op.id, { status: "failed", failure: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // v6 — pre-flip verb set: rename, tag, interrupt, fork, parenting, questions, seals
  // -------------------------------------------------------------------------

  /** Parse the paired local/external parent claim at the spawn RPC boundary. */
  private parentParam(params: Record<string, unknown>): { parentId: string | null; parentExternal: boolean } {
    const external = params.parentExternal;
    if (external !== undefined && typeof external !== "boolean") {
      throw new RpcError("invalid_request", "parentExternal must be a boolean when given");
    }
    const v = params.parentId;
    if (external === true) {
      if (v === undefined || v === null) {
        throw new RpcError("invalid_request", "parentExternal true requires parentId");
      }
      return {
        parentId: requireBeeId(v, "spawn: parentId"),
        parentExternal: true,
      };
    }
    if (v === undefined || v === null) return { parentId: null, parentExternal: false };
    if (typeof v !== "string" || v.length === 0) throw new RpcError("invalid_request", "parentId must be a non-empty string when given");
    if (!this.mustStore().getBee(v)) throw new RpcError("bee_not_found", `parent bee not found: ${v}`);
    return { parentId: v, parentExternal: false };
  }

  private stringListParam(params: Record<string, unknown>, key: string, verb: string): string[] | undefined {
    const v = params[key];
    if (v === undefined || v === null) return undefined;
    if (!Array.isArray(v) || v.some((t) => typeof t !== "string")) {
      throw new RpcError("invalid_request", `${verb}: ${key} must be an array of strings`);
    }
    return v as string[];
  }

  private rpcRename(params: Record<string, unknown>): RenameResult {
    const beeId = this.requireBee(params);
    const name = this.param(params, "name");
    const res = this.mustStore().renameBee(beeId, name);
    this.log(`bee.rename bee=${beeId} applied=${res.applied} name=${JSON.stringify(name)}`);
    return { bee: toPublicBee(res.bee), applied: res.applied };
  }

  private rpcConfigGet(): ConfigGetResult {
    try {
      this.naming = loadNodeConfig(this.cfg.dataDir, this.cfg.configPath).naming;
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      throw new RpcError("invalid_request", err.message);
    }
    return { naming: publicNamingConfig(this.naming), configPath: this.cfg.configPath };
  }

  private rpcConfigPatch(params: Record<string, unknown>): ConfigPatchResult {
    const namingRaw = params.naming;
    if (namingRaw === null || typeof namingRaw !== "object" || Array.isArray(namingRaw)) {
      throw new RpcError("invalid_request", "config.patch: naming must be an object");
    }
    const raw = namingRaw as Record<string, unknown>;
    const patch: NamingConfig = {};
    if (raw.auto !== undefined) {
      if (typeof raw.auto !== "boolean") throw new RpcError("invalid_request", "config.patch: naming.auto must be a boolean");
      patch.auto = raw.auto;
    }
    if (raw.backend !== undefined) {
      if (raw.backend !== "codex-app-server" && raw.backend !== "openai-api" && raw.backend !== "claude-cli") {
        throw new RpcError(
          "invalid_request",
          'config.patch: naming.backend must be "codex-app-server", "openai-api", or "claude-cli"',
        );
      }
      patch.backend = raw.backend;
    }
    if (raw.tool !== undefined) {
      if (raw.tool !== "codex" && raw.tool !== "claude") {
        throw new RpcError("invalid_request", 'config.patch: naming.tool must be "codex" or "claude"');
      }
      patch.tool = raw.tool;
    }
    if (raw.model !== undefined) {
      if (typeof raw.model !== "string" || raw.model.length === 0) {
        throw new RpcError("invalid_request", "config.patch: naming.model must be a non-empty string");
      }
      patch.model = raw.model;
    }
    if (raw.effort !== undefined) {
      if (typeof raw.effort !== "string" || raw.effort.length === 0) {
        throw new RpcError("invalid_request", "config.patch: naming.effort must be a non-empty string");
      }
      patch.effort = raw.effort as NamingConfig["effort"];
    }
    if (raw.apiKey !== undefined) {
      if (typeof raw.apiKey !== "string") {
        throw new RpcError("invalid_request", "config.patch: naming.apiKey must be a string");
      }
      patch.apiKey = raw.apiKey;
    }
    if (raw.apiKeyRef !== undefined) {
      if (typeof raw.apiKeyRef !== "string") {
        throw new RpcError("invalid_request", "config.patch: naming.apiKeyRef must be a string");
      }
      patch.apiKeyRef = raw.apiKeyRef;
    }
    if (raw.command !== undefined) {
      if (typeof raw.command !== "string") {
        throw new RpcError("invalid_request", "config.patch: naming.command must be a string");
      }
      patch.command = raw.command;
    }
    if (Object.keys(patch).length === 0) {
      throw new RpcError("invalid_request", "config.patch: give at least one naming field");
    }
    try {
      this.naming = patchNamingConfig(this.cfg.configPath, this.cfg.dataDir, patch);
    } catch (err) {
      throw new RpcError("invalid_request", err instanceof Error ? err.message : String(err));
    }
    this.titleGenerator?.reconfigure(this.naming);
    this.log(`config.patch naming=${JSON.stringify(publicNamingConfig(this.naming))}`);
    return { naming: publicNamingConfig(this.naming), configPath: this.cfg.configPath };
  }

  private runtimeEnvOf(bee: BeeRow, spec: AgentSpecConfig, label: string): Record<string, string> {
    let accountEnv: Record<string, string> = {};
    let beeEnv = bee.env;
    if (bee.account && this.accounts) {
      const account = this.mustStore().getAccount(bee.account);
      if (!account) throw new Error(`${label}: bee ${bee.id} is bound to unknown account ${bee.account}`);
      accountEnv = { ...this.accounts.homeEnvOf(account), ...this.accounts.credentialEnvOf(account) };
      beeEnv = this.accounts.nativeBeeEnv(account, bee.env);
    }
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...(spec.env ?? {}),
      ...beeEnv,
      ...accountEnv,
    };
    return { ...env, ...beeIdentityEnv(bee, this.cfg.dataDir, resolve(this.cfg.socketPath)) };
  }

  private claudeContextLaunchFor(bee: BeeRow, args: readonly string[], env: Record<string, string>): ClaudeContextLaunch {
    return claudeContextLaunch(effectiveContextPolicy(this.contextPolicy, workspaceOfTags(bee.tags), roleOfTags(bee.tags), claudeLaunchFacts(env)), args, env, bee.env);
  }

  private applyContextEnv(env: Record<string, string>, context: ClaudeContextLaunch): void {
    for (const key of context.unset) delete env[key];
    Object.assign(env, context.env);
  }

  private contextPolicyWorkspaceParam(params: Record<string, unknown>, verb: string): string | null {
    const workspace = this.optionalString(params, "workspace", verb);
    if (workspace !== null && !validWorkspaceId(workspace)) throw new RpcError("invalid_request", `${verb}: workspace must be a non-empty workspace id when given`);
    return workspace;
  }

  private contextPolicyRoleParam(params: Record<string, unknown>, verb: string): ContextRole | null {
    if (params.role === undefined || params.role === null) return null;
    if (!isContextRole(params.role)) throw new RpcError("invalid_request", `${verb}: role must be one of ${CONTEXT_ROLES.join("|")} when given`);
    return params.role;
  }

  private contextPolicyResult(workspace: string | null, role: ContextRole | null, bee?: BeeRow): ContextPolicyResult {
    const harness = bee ? (this.cfg.agents[bee.agent]?.adapter ?? bee.agent) : null;
    const spec = bee ? this.cfg.agents[bee.agent] : undefined;
    let launchEnv: Record<string, string> | null = null;
    if (bee && harness === "claude" && spec) {
      try {
        launchEnv = { ...this.runtimeEnvOf(bee, spec, "contextPolicy.get"), ...(this.beeTmp ? beeTmpPaths(this.beeTmp, bee.id) : {}) };
      } catch {
        launchEnv = null;
      }
    }
    const launch = launchEnv ? claudeLaunchFacts(launchEnv) : NO_LAUNCH_FACTS;
    const effective = effectiveContextPolicy(this.contextPolicy, workspace, role, launch);
    const storedRole = role === null ? null : storedContextPolicy(this.contextPolicy, { role });
    const result: ContextPolicyResult = {
      workspace,
      stored: storedContextPolicy(this.contextPolicy, workspace !== null ? { workspace } : role !== null ? { role } : null),
      default: storedContextPolicy(this.contextPolicy, null),
      role,
      rolePolicy: role === null ? null : roleContextPolicy(this.contextPolicy, role, launch),
      rolePolicyBuiltin: role !== null && storedRole === null,
      effective,
      facts: contextPolicyFacts(effective, launch),
      configPath: this.cfg.configPath,
    };
    if (bee && harness !== null) {
      let model: string | null = null;
      if (launchEnv && spec) {
        const args = bee.substrate === "tmux" ? (bee.args ?? []) : composeSpawn(spec, harness, bee).args;
        const context = this.claudeContextLaunchFor(bee, args, launchEnv);
        model = argValue(composeArgv(grammarFor("claude"), [args, context.modelArgs]), "--model") ?? claudeHomeModel(launchEnv) ?? null;
      }
      result.bee = { beeId: bee.id, harness, applies: harness === "claude", model };
    }
    return result;
  }

  private rpcContextPolicyGet(params: Record<string, unknown>): ContextPolicyResult {
    if (params.beeId !== undefined) {
      if ((params.workspace !== undefined && params.workspace !== null) || (params.role !== undefined && params.role !== null)) throw new RpcError("invalid_request", "contextPolicy.get: give beeId alone, or workspace and/or role");
      const bee = this.mustStore().getBee(this.requireBee(params))!;
      return this.contextPolicyResult(workspaceOfTags(bee.tags), roleOfTags(bee.tags), bee);
    }
    return this.contextPolicyResult(this.contextPolicyWorkspaceParam(params, "contextPolicy.get"), this.contextPolicyRoleParam(params, "contextPolicy.get"));
  }

  private rpcContextPolicySet(params: Record<string, unknown>): ContextPolicySetResult {
    const workspace = this.contextPolicyWorkspaceParam(params, "contextPolicy.set");
    const role = this.contextPolicyRoleParam(params, "contextPolicy.set");
    if (workspace !== null && role !== null) throw new RpcError("invalid_request", "contextPolicy.set: give workspace or role, not both");
    if (!("policy" in params)) throw new RpcError("invalid_request", "contextPolicy.set: policy is required (an object, or null to clear)");
    let policy: ContextPolicy | null = null;
    if (params.policy !== null) {
      try {
        policy = contextPolicyOf(params.policy, "contextPolicy.set: policy");
      } catch (err) {
        if (err instanceof ContextPolicyError) throw new RpcError("invalid_request", err.message);
        throw err;
      }
    }
    const scope: ContextPolicyScope = workspace !== null ? { workspace } : role !== null ? { role } : null;
    const before = storedContextPolicy(this.contextPolicy, scope);
    const applied = !sameContextPolicy(before, policy);
    if (applied) {
      try {
        this.contextPolicy = writeContextPolicy(this.cfg.configPath, scope, policy);
      } catch (err) {
        throw new RpcError("invalid_request", err instanceof Error ? err.message : String(err));
      }
      this.log(`contextPolicy.set ${workspace !== null ? `workspace=${workspace}` : role !== null ? `role=${role}` : "default"} policy=${JSON.stringify(policy)}`);
    }
    return { ...this.contextPolicyResult(workspace, role), applied };
  }

  private assertApiaryTagWriter(verb: "spawn" | "bee.tag", params: Record<string, unknown>): void {
    const caller = params.callerBeeId;
    if (caller === undefined || caller === null) return;
    if (typeof caller !== "string" || caller.length === 0) throw new RpcError("invalid_request", `${verb}: callerBeeId must be a non-empty string when given`);
    const written = verb === "spawn" ? [params.tags] : [params.add, params.remove];
    const reserved = written.flatMap((list) => (Array.isArray(list) ? list : [])).filter((tag): tag is string => typeof tag === "string" && tag.startsWith(APIARY_TAG_PREFIX));
    if (reserved.length > 0) {
      throw new RpcError("tag_reserved", `${verb}: ${APIARY_TAG_PREFIX}* tags are written by Apiary only; bee ${caller} may not write ${reserved.join(", ")}`);
    }
  }

  private rpcTag(params: Record<string, unknown>): TagResult {
    const beeId = this.requireBee(params);
    const add = this.stringListParam(params, "add", "bee.tag");
    const remove = this.stringListParam(params, "remove", "bee.tag");
    if (add === undefined && remove === undefined) throw new RpcError("invalid_request", "bee.tag: give add and/or remove");
    const res = this.mustStore().tagBee(beeId, { add, remove });
    this.log(`bee.tag bee=${beeId} applied=${res.applied} added=${JSON.stringify(res.added)} removed=${JSON.stringify(res.removed)}`);
    return { bee: toPublicBee(res.bee), applied: res.applied, added: res.added, removed: res.removed };
  }

  private rpcReconnectTools(params: Record<string, unknown>): ReconnectToolsResult {
    for (const key of Object.keys(params)) if (!["beeId", "idempotencyKey"].includes(key)) throw new RpcError("invalid_request", `Reconnect does not accept '${key}'`);
    const store = this.mustStore();
    const beeId = this.requireBee(params);
    const key = this.idempotencyKeyOf(params);
    if (key) {
      const prior = store.getCommandByIdempotencyKey(key);
      if (prior) {
        if (prior.verb !== "reconnect_tools" || prior.beeId !== beeId) throw new RpcError("idempotency_conflict", "Key belongs to another command");
        return reconnectToolsResult(prior);
      }
      if (store.lookupRpcResult(key)) throw new RpcError("idempotency_conflict", "Key belongs to another mutation");
    }
    const bee = store.getBee(beeId)!;
    const rt = store.currentRuntime(beeId);
    if (bee.agent !== "codex" || !["hsr", "cell"].includes(bee.substrate)) throw new RpcError("reconnect_unsupported", "Reconnect tools requires a Codex HSR or Cell runtime");
    if (bee.activeMoveId || bee.activeHandoffId) throw new RpcError("reconnect_not_ready", "A move or handoff currently owns this bee");
    if (!rt || rt.state === "stopped") throw new RpcError("reconnect_not_ready", "Reconnect requires the existing live runtime");
    const support = this.driver?.reconnectToolsSupport(beeId, rt.generation);
    if (!support?.supported) throw new RpcError("reconnect_unsupported", support?.reason ?? "Runtime control unavailable");
    return reconnectToolsResult(store.enqueueCommand("reconnect_tools", beeId, {}, key ? { idempotencyKey: key } : {}));
  }

  /**
   * `bee.interrupt`: the driver's in-band turn interrupt against the bee's
   * CURRENT live generation. Idle / no runtime = a reasoned no-op result.
   * The runtime stays live; the turn_ended is observed by the loops.
   */
  private rpcInterrupt(params: Record<string, unknown>): InterruptResult {
    const store = this.mustStore();
    const beeId = this.requireBee(params);
    const rt = store.currentRuntime(beeId);
    const driver = this.driver;
    let outcome: InterruptOutcome;
    if (!rt || rt.state === "stopped" || !driver) outcome = { interrupted: false, reason: "no_process" };
    else if (rt.state === "idle") outcome = { interrupted: false, reason: "idle" };
    else if (rt.state === "booting") outcome = { interrupted: false, reason: "not_ready" };
    else outcome = driver.interrupt(beeId, rt.generation);
    store.recordInterrupt(beeId, rt?.generation ?? null, outcome);
    this.log(`bee.interrupt bee=${beeId} gen=${rt?.generation ?? "-"} interrupted=${outcome.interrupted}${outcome.reason ? ` reason=${outcome.reason}` : ""}`);
    return {
      beeId,
      generation: rt?.generation ?? null,
      interrupted: outcome.interrupted,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
    };
  }

  /**
   * `bee.fork`: a new bee cloned from the source's spawn shape with
   * `parentId` = `forkedFrom` = source and the one-shot fork seed (the
   * source's provider session id) so its first runtime forks the
   * conversation into a new session of its own. Same transaction: create,
   * fork provenance and spawn command. No instruction is accepted.
   */
  private removeThreadArtifacts(operationId: string): void {
    // Only daemon-owned paths, reconstructed from the operation UUID. Never
    // remove the source rollout or a caller-supplied directory.
    if (!/^[0-9a-f-]{36}$/.test(operationId)) return;
    rmSync(join(this.cfg.dataDir, "thread-operations", operationId), { recursive: true, force: true });
  }

  private requireThreadOperation(params: Record<string, unknown>): ThreadOperationRow {
    const row = this.mustStore().getThreadOperation(this.param(params, "operationId"));
    if (!row) throw new RpcError("thread_operation_not_found", "Unknown thread operation");
    return row;
  }

  private async rpcThreadOperationWithAdmission(kind: "fork" | "handoff", params: Record<string, unknown>) {
    const key = this.idempotencyKeyOf(params);
    if (key && this.mustStore().threadOperationByKey(key)) return this.rpcThreadOperation(kind, params);
    const source = typeof params.beeId === "string" ? this.mustStore().getBee(params.beeId) : null;
    if (source?.account && this.accounts && !this.allocationClaimParam(params) && this.accounts.allocationMode() === "shadow") {
      await this.accounts.ensureFreshAdmissionLimits(source.agent, {
        model: this.modelParamOf({ args: source.args ?? [] }, source.agent),
      });
    }
    return this.rpcThreadOperation(kind, params);
  }

  private rpcThreadOperation(kind: "fork" | "handoff", params: Record<string, unknown>) {
    const allowed = new Set(["beeId", "sourceProviderSessionId", "sourceNode", "idempotencyKey", "name", "allocationContext", "allocationClaim", "successorBeeId", ...(kind === "handoff" ? ["instruction"] : [])]);
    for (const key of Object.keys(params)) if (!allowed.has(key)) throw new RpcError("thread_unsupported", `${kind} does not accept '${key}'`);
    if (params.sourceNode !== undefined && params.sourceNode !== "local") throw new RpcError("thread_remote_unsupported", "Dispatch to the source's owning daemon; cross-node execution is unsupported");
    const key = this.idempotencyKeyOf(params);
    if (!key) throw new RpcError("invalid_request", "Thread operations require idempotencyKey");
    const sourceBeeId = this.param(params, "beeId");
    const sourceProviderSessionId = this.param(params, "sourceProviderSessionId");
    const instruction = kind === "handoff" ? this.param(params, "instruction") : null;
    if (instruction !== null && (!instruction.trim() || Buffer.byteLength(instruction) > 65536)) throw new RpcError("invalid_request", "Handoff instruction must contain 1..65536 UTF-8 bytes");
    const name = params.name === undefined ? null : this.param(params, "name");
    const claim = this.allocationClaimParam(params);
    const requestedSuccessorBeeId = params.successorBeeId === undefined
      ? (claim?.target.workId ?? null)
      : this.param(params, "successorBeeId");
    if (requestedSuccessorBeeId !== null) this.assertPortableWorkId(requestedSuccessorBeeId, "successorBeeId");
    const successorBeeId = requestedSuccessorBeeId ?? randomUUID();
    const requestHash = createHash("sha256").update(JSON.stringify({
      kind, sourceBeeId, sourceProviderSessionId, instruction, name,
      successorBeeId: requestedSuccessorBeeId, allocationClaimId: claim?.id ?? null,
    })).digest("hex");
    const store = this.mustStore();
    const previous = store.threadOperationByKey(key);
    if (previous) {
      // Pre-v28 receipts did not include successor/claim fields. Accept that
      // exact old intent only when no new placement identity was supplied.
      const legacyHash = !claim && requestedSuccessorBeeId === null
        ? createHash("sha256").update(JSON.stringify({ kind, sourceBeeId, sourceProviderSessionId, instruction, name })).digest("hex")
        : null;
      if (previous.requestHash !== requestHash && previous.requestHash !== legacyHash) {
        throw new RpcError("idempotency_conflict", "Thread operation key is already bound to another request");
      }
      const replayAdmission = store.getAccountAdmissionByRequestKey(`account-admission:${kind}:${key}`);
      return { operation: threadOperationView(previous), deduped: true,
        ...(claim ? { allocation: claim.allocation, allocationClaimId: claim.id } : {}),
        ...(!claim && replayAdmission ? { allocation: replayAdmission.receipt as unknown as AccountAllocationReceipt } : {}) };
    }
    if (store.lookupRpcResult(key) || store.getCommandByIdempotencyKey(key)) throw new RpcError("idempotency_conflict", "Key is already bound to another operation");
    const source = store.getBee(sourceBeeId);
    if (!source) throw new RpcError("bee_not_found", "Source bee is not owned by this daemon");
    if (source.providerSessionId !== sourceProviderSessionId) throw new RpcError("thread_history_unavailable", "Source provider identity changed; refresh its snapshot");
    if (source.agent !== "codex" || source.substrate !== "hsr" || (this.cfg.agents[source.agent]?.adapter ?? source.agent) !== "codex") throw new RpcError("thread_unsupported", "Thread operations currently support only local Codex HSR bees");
    if (source.activeHandoffId || source.activeMoveId || (store.threadOperationForSuccessor(source.id)?.phase ?? "ready") !== "ready") throw new RpcError("thread_busy", "Source is undergoing an execution transition");
    const spec = this.resolveSpawnSpec(source.id);
    const home = spec.env?.CODEX_HOME ?? join(homedir(), ".codex");
    let boundary: ThreadOperationRow["source"];
    try { boundary = pinThreadHistory(codexHistoryPath(home, sourceProviderSessionId), sourceProviderSessionId); }
    catch (error) { throw new RpcError("thread_history_unavailable", error instanceof Error ? error.message : String(error)); }
    const id = randomUUID();
    const successorProviderSessionId = randomUUID();
    const directory = join(this.cfg.dataDir, "thread-operations", id);
    let allocation: AccountAllocationReceipt | undefined;
    const operation = store.transact(() => {
      const claimedAccount = claim
        ? this.accountFromClaim(
            claim, kind, source.agent, successorBeeId, 0, null,
            this.modelParamOf({ args: source.args ?? [] }, source.agent),
          )
        : null;
      if (claimedAccount && claimedAccount.id !== source.account) {
        throw new RpcError("account_claim_refused", `${kind} claim ${claim!.id} does not preserve the source account`);
      }
      if (source.account && this.accounts && !claim && this.accounts.allocationMode() === "active") {
        this.ownerClaimRequired(source.agent, kind);
      }
      const admission = source.account && this.accounts && !claim
        ? this.accounts.admitNewWork(source.agent, {
            operation: kind,
            requestKey: key,
            model: this.modelParamOf({ args: source.args ?? [] }, source.agent),
            context: this.allocationContextParam(params),
            onlyAccountIds: new Set([source.account]),
            reconcileAfterGeneration: 0,
          })
        : null;
      if (admission && !admission.ok) {
        throw new RpcError(admission.code, admission.message, { allocation: admission.receipt as unknown as Record<string, unknown> });
      }
      if (admission?.ok) allocation = admission.receipt;
      const admitted = store.admitThreadOperation({ id, kind, sourceBeeId, sourceProviderSessionId, successorBeeId, successorProviderSessionId,
        idempotencyKey: key, requestHash, instruction, source: boundary, historyPath: join(directory, "history.jsonl"), sessionPath: join(directory, "successor.jsonl") }, {
        id: successorBeeId, name: name ?? `${source.name}-${kind}-${id.slice(0, 8)}`, agent: source.agent, substrate: source.substrate,
        cwd: source.cwd, title: source.title ?? undefined, tags: withoutRoleTags(source.tags), env: { ...source.env }, args: source.args,
        account: claimedAccount?.id ?? source.account,
        parentId: source.id, forkedFrom: source.id, sessionLogPath: this.canonicalSessionLogPath(successorBeeId),
      });
      if (claim) this.consumeAccountClaim(claim, successorBeeId);
      else if (admission?.ok && admission.reservation) store.bindAccountAdmission(admission.reservation.id, successorBeeId);
      return admitted;
    });
    return { operation: threadOperationView(operation), deduped: false,
      ...(claim ? { allocation: claim.allocation, allocationClaimId: claim.id } : {}),
      ...(allocation ? { allocation } : {}) };
  }

  private async rpcForkWithAdmission(params: Record<string, unknown>): Promise<ForkResult> {
    const store = this.mustStore();
    const key = this.idempotencyKeyOf(params);
    if (key != null && store.lookupRpcResult(key)) {
      return this.withIdempotency("bee.fork", params, () => this.rpcFork(params));
    }
    const source = store.getBee(this.requireBee(params));
    if (source?.account && this.accounts && !this.allocationClaimParam(params)
      && this.accounts.allocationMode() === "shadow") {
      await this.accounts.ensureFreshAdmissionLimits(source.agent, { model: this.modelParamOf({ args: source.args ?? [] }, source.agent) });
    }
    return this.withIdempotency("bee.fork", params, () => this.rpcFork(params));
  }

  private rpcFork(params: Record<string, unknown>): ForkResult {
    const store = this.mustStore();
    const key = this.idempotencyKeyOf(params);
    if (key != null) {
      const original = store.getCommandByIdempotencyKey(key);
      if (original) {
        const bee = store.getBee(original.beeId);
        if (bee) {
          return { beeId: bee.id, commandId: original.id, forkedFrom: bee.forkedFrom ?? "", forkSeed: bee.forkSeed, messageId: null, bee: toPublicBee(bee), status: original.status, deduped: true };
        }
      }
    }
    const sourceId = this.requireBee(params);
    const source = store.getBee(sourceId);
    if (!source) throw new RpcError("bee_not_found", `bee not found: ${sourceId}`);
    if (source.substrate === "cell") {
      throw new RpcError("invalid_request", `bee ${sourceId} runs in a cell (single-tenant checkout); spawn a new cell bee instead of forking`);
    }
    if (!source.providerSessionId) throw new RpcError("thread_history_unavailable", "Fork requires an existing provider conversation");
    const adapter = this.cfg.agents[source.agent]?.adapter ?? source.agent;
    if (adapter !== "claude" && adapter !== "codex") throw new RpcError("thread_unsupported", `Fork is unsupported for ${adapter}`);
    const name = params.name === undefined ? `${source.name}-fork` : this.param(params, "name");
    const id = typeof params.id === "string" && params.id.length > 0 ? params.id : randomUUID();
    const forkSeed = source.providerSessionId;
    const driver = this.driver;
    const claim = this.allocationClaimParam(params);
    const claimedAccount = claim
      ? this.accountFromClaim(
          claim, "fork", source.agent, id, 0, null,
          this.modelParamOf({ args: source.args ?? [] }, source.agent),
        )
      : null;
    if (claimedAccount && claimedAccount.id !== source.account) {
      throw new RpcError("account_claim_refused", `fork claim ${claim!.id} does not preserve the source account`);
    }
    if (source.account && this.accounts && !claim && this.accounts.allocationMode() === "active") {
      this.ownerClaimRequired(source.agent, "fork");
    }
    const admission = source.account && this.accounts && !claim
      ? this.accounts.admitNewWork(source.agent, {
          operation: "fork",
          requestKey: key ?? `fork:${id}`,
          model: this.modelParamOf({ args: source.args ?? [] }, source.agent),
          context: this.allocationContextParam(params),
          onlyAccountIds: new Set([source.account]),
          reconcileAfterGeneration: 0,
        })
      : null;
    if (admission && !admission.ok) {
      throw new RpcError(admission.code, admission.message, { allocation: admission.receipt as unknown as Record<string, unknown> });
    }
    const { bee } = store.createBee({
      id,
      name,
      agent: source.agent,
      substrate: source.substrate,
      cwd: source.cwd,
      title: source.title ?? undefined,
      tags: withoutRoleTags(source.tags),
      sessionLogPath: driver ? driver.sessionLogPath(id) : undefined,
      env: { ...source.env },
      args: source.args,
      parentId: source.id,
      parentExternal: false,
      forkedFrom: source.id,
      forkSeed,
      // v7: a fork runs on the source's account (same identity, same home).
      account: claimedAccount?.id ?? source.account,
    });
    if (claim) this.consumeAccountClaim(claim, bee.id);
    else if (admission?.ok && admission.reservation) store.bindAccountAdmission(admission.reservation.id, bee.id);
    store.recordFork(id, source.id, forkSeed);
    const cmd = store.enqueueCommand("spawn", id, {}, key == null ? {} : { idempotencyKey: key });
    this.log(`bee.fork source=${source.id} fork=${id} seed=${forkSeed ?? "-"} cmd=${cmd.id}`);
    return { beeId: id, commandId: cmd.id, forkedFrom: source.id, forkSeed, messageId: null, bee: toPublicBee(bee),
      ...(claim ? { allocation: claim.allocation, allocationClaimId: claim.id } : {}),
      ...(admission?.ok ? { allocation: admission.receipt } : {}) };
  }

  private rpcChildren(params: Record<string, unknown>): ChildrenResult {
    const store = this.mustStore();
    const beeId = this.requireBee(params);
    return { beeId, children: store.listChildren(beeId).map((b) => this.viewOf(store, b.id)) };
  }

  private rpcHumanOutput(verb: "bee.tell", params: Record<string, unknown>, conn: RpcConn): BeeTellResult;
  private rpcHumanOutput(verb: "bee.react", params: Record<string, unknown>, conn: RpcConn): BeeReactResult;
  private rpcHumanOutput(verb: "bee.setHumanOutputMode", params: Record<string, unknown>, conn: RpcConn): SetHumanOutputModeResult;
  private rpcHumanOutput(verb: "bee.tell" | "bee.react" | "bee.setHumanOutputMode", params: Record<string, unknown>, conn: RpcConn) {
    const allowed = verb === "bee.tell" ? ["beeId", "text", "replyTo", "idempotencyKey"] : verb === "bee.react" ? ["beeId", "messageId", "emoji", "idempotencyKey"] : ["beeId", "mode", "idempotencyKey"];
    for (const key of Object.keys(params)) if (!allowed.includes(key)) throw new RpcError("invalid_request", `${verb} does not accept ${key}`);
    const beeId = this.requireBee(params);
    if (verb !== "bee.setHumanOutputMode" && conn.authenticatedBeeId !== beeId) throw new RpcError("caller_not_trusted", "Human output requires the matching authenticated bee principal.");
    if (verb === "bee.setHumanOutputMode" && !conn.humanOutputManagement) throw new RpcError("caller_not_trusted", "Mode changes require trusted local-service management.");
    const idempotencyKey = this.param(params, "idempotencyKey");
    const store = this.mustStore();
    if (verb === "bee.setHumanOutputMode") return store.setHumanOutputMode(beeId, params.mode as HumanOutputMode, idempotencyKey);
    if (verb === "bee.tell") return store.tellHuman({ beeId, text: params.text, ...(params.replyTo !== undefined ? { replyTo: params.replyTo } : {}), idempotencyKey } as BeeTellParams);
    return store.reactHuman({ beeId, messageId: params.messageId, emoji: params.emoji, idempotencyKey } as BeeReactParams);
  }

  private rpcQuestionAsk(params: Record<string, unknown>): QuestionAskResult {
    const beeId = this.requireBee(params);
    const text = this.param(params, "text");
    const options = this.stringListParam(params, "options", "question.ask");
    const question = this.mustStore().askQuestion(beeId, {
      ...(typeof params.id === "string" && params.id.length > 0 ? { id: params.id } : {}),
      text,
      options: options ?? null,
    });
    this.log(`question.ask bee=${beeId} question=${question.id}`);
    return { question };
  }

  private rpcQuestionAnswer(params: Record<string, unknown>): QuestionAnswerResult {
    const store = this.mustStore();
    const questionId = this.param(params, "questionId");
    const answer = this.param(params, "answer");
    if (!store.getQuestion(questionId)) throw new RpcError("question_not_found", `question not found: ${questionId}`);
    const res = store.answerQuestion(questionId, answer, { answeredBy: "rpc" });
    store.afterCommit(() => this.requestTick());
    this.log(`question.answer question=${questionId} bee=${res.question.beeId} msg=${res.send.message.id}${res.send.wakeCommand ? ` wake=${res.send.wakeCommand.id}` : ""}`);
    return {
      question: res.question,
      messageId: res.send.message.id,
      commandId: res.send.wakeCommand?.id ?? null,
      unarchived: res.send.unarchived,
    };
  }

  private rpcQuestionDismiss(params: Record<string, unknown>): QuestionDismissResult {
    for (const key of Object.keys(params)) if (!["questionId", "idempotencyKey"].includes(key)) throw new RpcError("invalid_request", `question.dismiss does not accept ${key}`);
    const questionId = this.param(params, "questionId");
    const key = this.idempotencyKeyOf(params);
    if (!key) throw new RpcError("invalid_request", "question.dismiss requires idempotencyKey");
    const store = this.mustStore();
    const before = store.lastAuditSeq();
    const result = store.dismissQuestionWithKey(questionId, key);
    if (store.lastAuditSeq() !== before) store.afterCommit(() => this.requestTick());
    return result;
  }

  private rpcQuestionWithdraw(params: Record<string, unknown>, conn: RpcConn): QuestionWithdrawResult {
    const caller = conn.authenticatedBeeId;
    if (!caller) throw new RpcError("caller_not_trusted", "Withdrawal requires an authenticated session principal.");
    for (const key of Object.keys(params)) if (!["questionId", "reason", "idempotencyKey"].includes(key)) throw new RpcError("invalid_request", `question.withdraw does not accept ${key}`);
    const questionId = this.param(params, "questionId");
    const reason = this.param(params, "reason");
    const callerKey = this.idempotencyKeyOf(params);
    if (!callerKey) throw new RpcError("invalid_request", "question.withdraw requires idempotencyKey");
    return this.mustStore().withdrawQuestionWithKey(questionId, caller, reason, callerKey);
  }

  private rpcQuestionList(params: Record<string, unknown>): QuestionListResult {
    const store = this.mustStore();
    const beeId = params.beeId === undefined || params.beeId === null ? undefined : this.requireBee(params);
    if (params.open !== undefined && params.open !== null && typeof params.open !== "boolean") {
      throw new RpcError("invalid_request", "question.list: open must be a boolean when given");
    }
    const open = typeof params.open === "boolean" ? params.open : undefined;
    return { questions: store.listQuestions({ ...(beeId ? { beeId } : {}), ...(open !== undefined ? { open } : {}) }) };
  }

  private rpcSealCreate(params: Record<string, unknown>): SealCreateResult {
    const beeId = this.requireBee(params);
    const title = this.param(params, "title");
    const body = params.body === undefined || params.body === null ? "" : params.body;
    if (typeof body !== "string") throw new RpcError("invalid_request", "seal.create: body must be a string");
    const refs = this.stringListParam(params, "refs", "seal.create");
    const seal = this.mustStore().createSeal(beeId, {
      ...(typeof params.id === "string" && params.id.length > 0 ? { id: params.id } : {}),
      title,
      body,
      refs,
    });
    this.log(`seal.create bee=${beeId} seal=${seal.id}`);
    return { seal };
  }

  private rpcSealList(params: Record<string, unknown>): SealListResult {
    const store = this.mustStore();
    const beeId = params.beeId === undefined || params.beeId === null ? undefined : this.requireBee(params);
    return { seals: store.listSeals(beeId ? { beeId } : {}) };
  }

  private rpcTaskAdd(params: Record<string, unknown>): TaskAddResult {
    const store = this.mustStore();
    const title = this.param(params, "title");
    let list: string;
    if (typeof params.list === "string" && params.list.length > 0) {
      list = params.list;
    } else {
      const beeId = this.requireBee(params);
      list = beeTaskList(beeId);
    }
    const originKind =
      params.originKind === "user" || params.originKind === "self" || params.originKind === "bee"
        ? params.originKind
        : "user";
    const originSender =
      typeof params.originSender === "string" && params.originSender.length > 0 ? params.originSender : "operator";
    const body = params.body === undefined || params.body === null ? undefined : params.body;
    if (body !== undefined && typeof body !== "string") throw new RpcError("invalid_request", "task.add: body must be a string");
    const autoRequested = typeof params.auto === "boolean" ? params.auto : undefined;
    const questId = typeof params.questId === "string" && params.questId.length > 0 ? params.questId : undefined;
    let context: Record<string, unknown> | undefined;
    if (params.context !== undefined && params.context !== null) {
      if (typeof params.context !== "object" || Array.isArray(params.context)) {
        throw new RpcError("invalid_request", "task.add: context must be a JSON object");
      }
      context = params.context as Record<string, unknown>;
    }
    try {
      const res = store.addTask({
        list,
        title,
        originKind,
        originSender,
        ...(body !== undefined ? { body } : {}),
        ...(autoRequested !== undefined ? { autoRequested } : {}),
        ...(questId !== undefined ? { questId } : {}),
        ...(context !== undefined ? { context } : {}),
      });
      this.log(`task.add list=${res.task.list} task=${res.task.id}`);
      return { task: res.task, ...(res.warning ? { warning: res.warning } : {}) };
    } catch (err) {
      if (err instanceof RpcError) throw err;
      throw new RpcError("invalid_request", err instanceof Error ? err.message : String(err));
    }
  }

  private rpcTaskList(params: Record<string, unknown>): TaskListResult {
    const store = this.mustStore();
    let list: string | undefined;
    let beeId: string | undefined;
    if (typeof params.list === "string" && params.list.length > 0) list = params.list;
    else if (params.beeId !== undefined && params.beeId !== null) {
      beeId = this.requireBee(params);
      list = beeTaskList(beeId);
    }
    let statuses: Array<"pending" | "queued" | "in-progress" | "done" | "blocked" | "cancelled"> | undefined;
    if (params.statuses !== undefined && params.statuses !== null) {
      if (!Array.isArray(params.statuses) || params.statuses.some((s) => !isTaskStatus(s))) {
        throw new RpcError("invalid_request", "task.list: statuses must be an array of known statuses");
      }
      statuses = params.statuses as NonNullable<typeof statuses>;
    }
    const tasks = store.listTasks({
      ...(list ? { list } : {}),
      ...(beeId && !list ? { beeId } : {}),
      ...(statuses ? { statuses } : {}),
    });
    return { list: list ?? null, tasks };
  }

  private rpcTaskGet(params: Record<string, unknown>): TaskGetResult {
    const taskId = this.param(params, "taskId");
    const task = this.mustStore().getTask(taskId);
    if (!task) throw new RpcError("task_not_found", `task not found: ${taskId}`);
    return { task };
  }

  private rpcTaskTransition(params: Record<string, unknown>): TaskTransitionResult {
    const taskId = this.param(params, "taskId");
    const action = this.param(params, "action");
    if (!isTaskTransitionAction(action)) {
      throw new RpcError("invalid_request", `task.transition: action must be one of ${TASK_TRANSITION_ACTIONS.join("|")}`);
    }
    if (!this.mustStore().getTask(taskId)) throw new RpcError("task_not_found", `task not found: ${taskId}`);
    const reason = typeof params.reason === "string" && params.reason.length > 0 ? params.reason : undefined;
    const task = this.mustStore().transitionTask(taskId, action, reason !== undefined ? { reason } : {});
    this.log(`task.${action} task=${taskId} status=${task.status}`);
    return { task };
  }

  private rpcTaskClaim(params: Record<string, unknown>): TaskClaimResult {
    const list = this.param(params, "list");
    const claimant = this.param(params, "claimant");
    const task = this.mustStore().claimTask(list, claimant);
    return { task };
  }

  private rpcTaskMove(params: Record<string, unknown>): TaskMoveResult {
    const taskId = this.param(params, "taskId");
    if (!this.mustStore().getTask(taskId)) throw new RpcError("task_not_found", `task not found: ${taskId}`);
    const before = typeof params.before === "string" && params.before.length > 0 ? params.before : undefined;
    const after = typeof params.after === "string" && params.after.length > 0 ? params.after : undefined;
    const task = this.mustStore().moveTask(taskId, { ...(before ? { before } : {}), ...(after ? { after } : {}) });
    return { task };
  }

  private rpcTaskEdit(params: Record<string, unknown>): TaskEditResult {
    const taskId = this.param(params, "taskId");
    if (!this.mustStore().getTask(taskId)) throw new RpcError("task_not_found", `task not found: ${taskId}`);
    const title = typeof params.title === "string" ? params.title : undefined;
    const body = params.body === undefined ? undefined : params.body === null ? null : params.body;
    if (body !== undefined && body !== null && typeof body !== "string") {
      throw new RpcError("invalid_request", "task.edit: body must be a string or null");
    }
    const auto = typeof params.auto === "boolean" ? params.auto : undefined;
    const task = this.mustStore().editTask(taskId, {
      ...(title !== undefined ? { title } : {}),
      ...(body !== undefined ? { body } : {}),
      ...(auto !== undefined ? { auto } : {}),
    });
    return { task };
  }

  private rpcTaskSupplyGet(params: Record<string, unknown>): TaskSupplyGetResult {
    const beeId = this.requireBee(params);
    return { supply: this.mustStore().getTaskSupply(beeId) };
  }

  private rpcTaskSupplySet(params: Record<string, unknown>): TaskSupplySetResult {
    const beeId = this.requireBee(params);
    if (params.on !== undefined && params.on !== null && typeof params.on !== "boolean") {
      throw new RpcError("invalid_request", "task.supply.set: on must be a boolean");
    }
    if (params.limit !== undefined && params.limit !== null && typeof params.limit !== "number") {
      throw new RpcError("invalid_request", "task.supply.set: limit must be a number");
    }
    const supply = this.mustStore().setTaskSupply(beeId, {
      ...(typeof params.on === "boolean" ? { on: params.on } : {}),
      ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
    });
    this.log(`task.supply bee=${beeId} on=${supply.on} limit=${supply.limit} paused=${supply.paused}`);
    return { supply };
  }

  private rpcSend(params: Record<string, unknown>, humanChat?: HumanChatAdmission): SendRpcResult {
    const store = this.mustStore();
    const beeId = this.param(params, "beeId");
    const body = this.param(params, "body");
    if (/^\s*\/login(?:\s|$)/i.test(body)) {
      const accountId = store.getBee(beeId)?.account;
      const account = accountId ? store.getAccount(accountId) : null;
      if (account) this.mustAccounts().assertLocalAccount(account);
    }
    let sender = "operator";
    if (params.sender !== undefined && params.sender !== null) {
      if (typeof params.sender !== "string" || params.sender.length === 0) {
        throw new RpcError("invalid_request", "send: sender must be a non-empty string when given");
      }
      sender = params.sender;
      if (sender !== "operator" && !sender.startsWith("human:") && !REMOTE_SENDER_RE.test(sender)
        && store.getBee(sender) == null) {
        throw new RpcError("invalid_request", `send: sender bee not found: ${sender}`);
      }
      if (sender.startsWith("human:") && sender.slice("human:".length).trim().length === 0) {
        throw new RpcError("invalid_request", "send: human sender name must not be empty");
      }
    }
    if (humanChat && (params.senderKind === "automation" || sender !== "operator" && !sender.startsWith("human:"))) throw new RpcError("human_chat_invalid", "Authenticated human chat requires an operator or human sender");
    // v8: optional delivery urgency (spec 01 Q2 amendment); omitted = 'next'.
    let urgency: Urgency = "next";
    if (params.urgency !== undefined && params.urgency !== null) {
      if (typeof params.urgency !== "string" || !(MESSAGE_URGENCIES as readonly string[]).includes(params.urgency)) {
        throw new RpcError("invalid_request", `send: urgency must be one of ${MESSAGE_URGENCIES.join("|")}`);
      }
      urgency = params.urgency as Urgency;
    }
    let senderKind: SenderKind | undefined;
    if (params.senderKind !== undefined && params.senderKind !== null) {
      if (typeof params.senderKind !== "string" || !(SENDER_KINDS as readonly string[]).includes(params.senderKind)) {
        throw new RpcError("invalid_request", `send: senderKind must be one of ${SENDER_KINDS.join("|")}`);
      }
      senderKind = params.senderKind as SenderKind;
      if (isPeerSender(sender, (id) => store.getBee(id) != null)) {
        throw new RpcError("invalid_request", "send: senderKind is only for operator and human senders; an agent's mail is always mail");
      }
    }
    if (this.phoneOriginOf(params)) { sender = `remote:${this.phoneOriginOf(params)!.issuerNodeId}/phone`; senderKind = undefined; }
    const res = store.send(beeId, body, { sender, urgency, ...(params.automationKind !== undefined ? { automationKind: params.automationKind as AutomationKind, ...(typeof params.automationRef === "string" ? { automationRef: params.automationRef } : {}) } : {}), ...((params as Record<PropertyKey,unknown>)[AUTOMATION_REFERENCE] ? {automationReference:(params as Record<PropertyKey,unknown>)[AUTOMATION_REFERENCE] as import("../../core/src/types.ts").AutomationReference} : {}), ...(humanChat ? { humanChat } : {}), ...(senderKind ? { senderKind } : {}), ...this.phoneSendOptions(params) });
    this.forwardIfMailboxOnly(beeId, res.message);
    store.afterCommit(() => this.requestTick());
    const held = this.authResume?.waitingForMaterial(beeId);
    return { messageId: res.message.id, commandId: res.wakeCommand?.id ?? null, unarchived: res.unarchived,
      ...(held ? { runtimeStartHold: { code: "account_auth_needed" as const, message: "Waiting for refreshed account material" as const } } : {}) };

  }

  private forwardIfMailboxOnly(beeId: string, message: MessageRow): void {
    const forward = this.deps.forwardMailboxOnlyMail;
    if (!forward) return;
    const bee = this.mustStore().getBee(beeId);
    if (!bee || !isInboxAgent(bee.agent)) return;
    this.mustStore().afterCommit(() => {
      Promise.resolve()
        .then(() => forward({ bee, message }))
        .catch((err: unknown) => this.log(`mailbox_only.forward_failed bee=${beeId} message=${message.id} error=${activationFailureName(err)}`));
    });
  }

  private rpcMailbox(params: Record<string, unknown>): { messages: MessageRow[] } {
    const beeId = this.requireBee(params);
    const sinceId = params.sinceId === undefined || params.sinceId === null ? undefined : this.numberParam(params, "sinceId");
    if (params.unread !== undefined && typeof params.unread !== "boolean") {
      throw new RpcError("invalid_request", "mailbox: unread must be a boolean");
    }
    return { messages: filterMailbox(this.mustStore().listMessages(beeId), { sinceId, unread: params.unread === true }) };
  }

  private rpcMailAck(params: Record<string, unknown>): { acked: number[] } {
    const beeId = this.requireBee(params);
    const throughId = params.all === true ? Number.MAX_SAFE_INTEGER : this.numberParam(params, "throughId");
    return this.mustStore().ackMail(beeId, throughId);
  }

  private rpcEnqueue(
    verb: string,
    beeId: string,
    args: Record<string, unknown>,
    params: Record<string, unknown>,
  ): MutationResult {
    const store = this.mustStore();
    const rt = store.currentRuntime(beeId);
    if (rt && rt.state !== "stopped" && rt.pid !== null && (verb === "stop" || verb === "archive")) {
      const binding = store.runtimeProcessIdentity(beeId, rt.generation), value = inspectProcess(rt.pid);
      if (binding.kind !== "bound" || value.kind === "unavailable" || value.kind === "present" && !sameProcess(binding.identity, value)) this.retainProcessIdentity(beeId, rt.generation);
    }
    const unresolved = !!rt && this.identityRecovery.has(beeId, rt.generation) && (verb === "stop" || verb === "archive");
    const key = this.idempotencyKeyOf(params) ?? (unresolved ? `identity-pending:${verb}:${beeId}:${rt!.generation}` : null);
    const cmd = store.enqueueCommand(verb, beeId, args, key == null ? {} : { idempotencyKey: key });
    if (unresolved) return {commandId: cmd.id, status: cmd.status, ...(cmd.deduped ? {deduped: true} : {}), pending: {code: "process_identity_unresolved", message: "stop pending process identity proof"}};
    // Core-level dedup (the UNIQUE key column) can answer even before the
    // rpc_idempotency record exists — surface it the same way.
    if (cmd.deduped) return { commandId: cmd.id, status: cmd.status, deduped: true };
    return { commandId: cmd.id };
  }

  private identityDiagnostic(beeId: string, generation: number | null) {
    const diagnostic = this.identityRecovery.diagnostic(beeId, generation, Date.now());
    return diagnostic ? {identityDiagnostic: diagnostic} : {};
  }

  private viewOf(store: CoreStore, beeId: string): ViewResult {
    const bee = store.getBee(beeId);
    return {
      ...this.identityDiagnostic(beeId, store.currentRuntime(beeId)?.generation ?? null),
      view: store.view(beeId),
      bee: mirrorBeeRow(bee),
      runtime: bee ? store.currentRuntime(beeId) : null,
      move: bee ? (() => { const m = store.latestMoveOf(bee.id); return m ? toBeeMoveView(m) : null; })() : null,
      cell: bee?.cellId ? store.getCell(bee.cellId) : null,
      handoff: bee ? (() => { const h = store.latestHandoffOf(bee.id); return h ? toBeeHandoffView(h) : null; })() : null,
    };
  }

  private rpcList(params: Record<string, unknown>): ListResult {
    const store = this.mustStore();
    const lifecycle = typeof params.lifecycle === "string" ? params.lifecycle : null;
    const views = store.listBeeViewRows(lifecycle);
    return {views: views.map(row => ({...row, bee: mirrorBeeRow(row.bee), ...this.identityDiagnostic(row.view.beeId, row.view.generation)}))};
  }

  /**
   * `audit.tail` — bounded audit-log read for `hive v2 events`. `afterSeq`
   * is a follow cursor (rows with seq > afterSeq only); `limit` keeps the
   * LAST n rows after the bee filter (default 100, capped at 1000).
   */
  private rpcAuditTail(params: Record<string, unknown>): AuditTailResult {
    const store = this.mustStore();
    const afterSeq = typeof params.afterSeq === "number" && Number.isFinite(params.afterSeq) ? params.afterSeq : 0;
    const rawLimit = typeof params.limit === "number" && Number.isFinite(params.limit) ? Math.floor(params.limit) : 100;
    const limit = Math.max(1, Math.min(1000, rawLimit));
    const beeId = typeof params.beeId === "string" && params.beeId.length > 0 ? params.beeId : null;
    return { rows: store.auditTail(afterSeq, limit, beeId).map(row => this.publicConfirmationAudit(row)) };
  }

  private rpcMailHistory(params: Record<string, unknown>): MailHistoryResult {
    const limit = params.limit;
    if (limit !== undefined && (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0)) {
      throw new RpcError("invalid_request", "mail.history: limit must be a positive integer");
    }
    const beforeSeq = params.beforeSeq;
    if (
      beforeSeq !== undefined &&
      (typeof beforeSeq !== "number" || !Number.isSafeInteger(beforeSeq) || beforeSeq < 0)
    ) {
      throw new RpcError("invalid_request", "mail.history: beforeSeq must be a non-negative integer");
    }
    const snapshotSeq = params.snapshotSeq;
    if (
      snapshotSeq !== undefined &&
      (typeof snapshotSeq !== "number" || !Number.isSafeInteger(snapshotSeq) || snapshotSeq < 0)
    ) {
      throw new RpcError("invalid_request", "mail.history: snapshotSeq must be a non-negative integer");
    }
    const query = {
      ...(typeof limit === "number" ? { limit: Math.min(limit, MAIL_HISTORY_MAX_LIMIT) } : {}),
      ...(typeof beforeSeq === "number" ? { beforeSeq } : {}),
      ...(typeof snapshotSeq === "number" ? { snapshotSeq } : {}),
    } satisfies MailHistoryParams;
    return this.mustStore().mailHistory(query);
  }

  private rpcMailPending(params: Record<string, unknown>): MailPendingResult {
    const limit = params.limit;
    if (limit !== undefined && (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0)) {
      throw new RpcError("invalid_request", "mail.pending: limit must be a positive integer");
    }
    return this.mustStore().pendingMail(
      this.requireBee(params),
      typeof limit === "number" ? { limit: Math.min(limit, MAIL_HISTORY_MAX_LIMIT) } : {},
    );
  }

  private rpcDeployInfo(): DeployInfoResult {
    return {
      protocol: PROTOCOL,
      capabilities: this.rpc?.capabilities ?? DAEMON_CAPABILITIES.filter(c => !(["question.withdraw.v1", "bee.tell.v1", "bee.react.v1", "bee.human_output_mode.v1"] as string[]).includes(c)),
      daemonVersion: DAEMON_VERSION,
      identity: BUILD_IDENTITY,
      nodeVersion: process.version,
      pid: process.pid,
      startedAt: this.startedAt,
      instanceId: this.instanceId,
      dataDir: this.cfg.dataDir,
      socketPath: this.cfg.socketPath,
      storePath: this.cfg.storePath,
      localSecurity: this.rpc?.localSecurity,
      cellDisk: this.retention?.diskStatus() ?? null,
      capacity: this.retention?.capacity(true) ?? null,
    };
  }

  /**
   * F8 — honest per-harness capability facts. Present/path/source come from
   * the SAME core resolver the spawn path uses, against the same env
   * baseline (process.env + the agent spec's env), so what this verb reports
   * as runnable is exactly what a spawn would exec. The version probe is a
   * bounded `--version` of the resolved binary under that same env (so a
   * spec's no-auto-update switch holds), cached by (path, mtime, the spec's
   * version stamps) — a failure or timeout is a null version, never an
   * error. `unavailable` is the recipe's reason this platform cannot run the
   * harness at all. A harness whose accounts are unisolated here is never
   * executed, not even for its version: that is read from its first version
   * stamp instead, and it stays available when it runs under the native
   * account (the machine's own login).
   */
  private async rpcNodeHarnesses(): Promise<NodeHarnessesResult> {
    const harnesses: HarnessFact[] = [];
    for (const [harness, spec] of Object.entries(this.cfg.agents)) {
      const env = { ...(process.env as Record<string, string>), ...(spec.env ?? {}) };
      const resolved = resolveExecutable(spec.command, { env });
      const kinds = [harness, spec.adapter ?? harness];
      const unisolated = kinds.map((kind) => this.accounts?.isolationRefusal(kind) ?? null).find((reason) => reason !== null) ?? null;
      const native = kinds.some((kind) => this.accounts?.nativeRecipe(kind));
      harnesses.push({
        harness,
        command: spec.command,
        present: resolved !== null,
        path: resolved?.path ?? null,
        source: resolved?.source ?? null,
        version: !resolved ? null : unisolated ? readVersionStamp(resolved.path, spec.versionStamps ?? []) : await this.probeHarnessVersion(resolved.path, env, spec.versionStamps ?? []),
        unavailable: native ? null : unisolated,
      });
    }
    return { harnesses };
  }

  /** `--version` first lines, cached per (path, mtime, stamps) so repeat calls are free. */
  private readonly harnessVersionCache = new Map<string, string | null>();

  private probeHarnessVersion(path: string, env: Record<string, string>, stamps: string[]): Promise<string | null> {
    let key: string;
    try {
      key = `${path}\0${statSync(path).mtimeMs}`;
      if (stamps.length > 0) {
        const dir = dirname(realpathSync(path));
        for (const stamp of stamps) {
          const st = statSync(join(dir, stamp), { throwIfNoEntry: false });
          key += `\0${stamp}\0${st ? `${st.mtimeMs}:${st.size}` : "-"}`;
        }
      }
    } catch {
      return Promise.resolve(null);
    }
    const hit = this.harnessVersionCache.get(key);
    if (hit !== undefined) return Promise.resolve(hit);
    return new Promise((resolvePromise) => {
      execFile(path, ["--version"], { env, timeout: 2000, maxBuffer: 64 * 1024 }, (error, stdout) => {
        const line = error
          ? null
          : String(stdout).split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? null;
        const version = line ? line.slice(0, 120) : null;
        this.harnessVersionCache.set(key, version);
        resolvePromise(version);
      });
    });
  }

  private rpcHealth(params: Record<string, unknown> = {}): HealthResult {
    const store = this.mustStore();
    const cleanup = store.tmuxCleanupCounts();
    return {
      ...(this.identityRecovery.counts(Date.now()).overdue ? {identityDiagnostic: {warning: "process_identity_unresolved" as const, count: this.identityRecovery.counts(Date.now()).overdue}} : {}),
      ...(cleanup.retained ? {tmuxCleanupRetained: cleanup.retained} : {}),
      ...(cleanup.informational ? {tmuxCleanupInformational: cleanup.informational} : {}),
      protocol: PROTOCOL,
      pid: process.pid,
      startedAt: this.startedAt,
      uptimeMs: Date.now() - this.startedAt,
      ticks: this.ticks,
      lastTickAt: this.lastTickAt,
      tickErrors: this.tickErrors,
      stopping: this.stopping,
      localSecurity: this.rpc?.localSecurity,
      confinement: {strict: this.confinementReasons.size > 0, reasons: [...this.confinementReasons], bwrap: this.confinementBwrap},
      lastBoot: this.lastBoot,
      i1Violations: this.telemetry?.i1Count() ?? 0,
      deliveryHoldUnknown: store.countUnknownMultilineHolds(),
      ...(params.includeDeliveryPrepareAuditUnknown === true ? {deliveryFileHelper: this.deliveryFiles.status()} : {}),
      ...(params.includeDeliveryPrepareAuditUnknown === true ? {deliveryPrepareAuditUnknown: store.countUnknownMultilinePrepareAudits()} : {}),
      paneInputUnknown: store.multilinePaneQuarantines().length,
      bees: store.countBeesByLifecycle(),
      naming: this.naming.disabledReason
        ? { state: "disabled", reason: this.naming.disabledReason }
        : { state: this.naming.auto ? "ok" : "off" },
      cellDisk: this.retention?.diskStatus() ?? null,
      capacity: this.retention?.capacity(true) ?? null,
    };
  }

  private snapshot(includeOperatorLocalHomes = false): SnapshotResult {
    const store = this.mustStore();
    // Single-threaded: reading the seq and the rows is atomic w.r.t. writes.
    const seq = store.lastAuditSeq();
    this.publishedSeq = seq;
    return {
      seq,
      humanFirstPolicies: store.listHumanFirstPolicies(),
      mailBatchingPolicies: store.listMailBatchingPolicies(),
      mailBatches: store.listMailBatches(),
      views: store.listBeeViewRows().map((row) => ({ ...row, bee: includeOperatorLocalHomes ? operatorLocalBee(row.bee) : mirrorBeeRow(row.bee), ...this.identityDiagnostic(row.view.beeId, row.view.generation) })),
      capacity: this.retention?.capacity() ?? null,
      templates: store.listTemplates(),
      tells: store.listTells(),
      reactions: store.listReactions(),
      questions: store.listQuestions(),
      seals: store.listSeals(),
      accounts: store.listAccounts().map((account) => this.mirrorAccount(account)),
      accountLimits: store.listAccountLimits(),
      accountAdmissions: store.listAccountAdmissions(),
      quotaRecoveries: store.listQuotaRecoveries(),
      tasks: store.listTasks(),
      taskSupply: store.listTaskSupply(),
      loginFlows: store.listLoginFlows(),
      cells: store.listCells(),
      beeMoves: store.listBeeMoves().map(toBeeMoveView),
      beeHandoffs: store.listBeeHandoffs().map(toBeeHandoffView),
      transcriptSegments: store.listTranscriptSegments(),
      threadOperations: store.listThreadOperations().map(threadOperationView),
      actions: store.listActionViews(),
      actionQueues: store.listActionQueueViews(),
    };
  }

  // -------------------------------------------------------------------------
  // v7 (spec 08) — accounts + auth
  // -------------------------------------------------------------------------

  private mustAccounts(): AccountsService {
    if (!this.accounts || this.stopping) throw new RpcError("node_stopped", "daemon is shutting down");
    return this.accounts;
  }

  private accountIdParam(params: Record<string, unknown>, key = "id"): string {
    if (!isAccountId(params[key])) throw new RpcError("invalid_request", "Account id must be a bounded safe account identity.");
    return params[key];
  }

  private requireAccount(params: Record<string, unknown>, key = "id"): AccountRow {
    const account = this.resolveAccountSelector(this.accountIdParam(params, key));
    knownAccountLease(account);
    return account;
  }

  /** One daemon-owned resolver for every operator-facing account selector. */
  private resolveAccountSelector(selector: string, preferredHarness?: string): AccountRow {
    const all = this.mustStore().listAccounts();
    let matched = matchAccount(all, selector);
    if (!matched.ok && preferredHarness) {
      const scoped = matchAccount(all.filter((account) => account.harness === preferredHarness), selector);
      if (scoped.ok) matched = scoped;
    }
    if (matched.ok) return matched.account;
    if (matched.reason === "ambiguous") {
      throw new RpcError("invalid_request", `ambiguous account '${selector}': ${matched.matches.map((account) => account.id).join(", ")}`);
    }
    throw new RpcError("account_not_found", `account not found: ${selector}`);
  }

  private rpcAccountList(params: Record<string, unknown>): AccountListResult {
    const store = this.mustStore();
    const accounts = this.mustAccounts();
    const harness = typeof params.harness === "string" && params.harness.length > 0 ? params.harness : undefined;
    const rows = store.listAccounts(harness ? { harness } : {});
    const ids = new Set(rows.map((a) => a.id));
    return {
      accounts: rows.map((a) => accounts.mirrorRow(a)),
      limits: store.listAccountLimits().filter((l) => ids.has(l.account)),
      credentialHealth: Object.fromEntries(rows.map((a) => [a.id, accounts.credentialHealthOf(a)])),
    };
  }

  private rpcAccountGet(params: Record<string, unknown>): AccountGetResult {
    const store = this.mustStore();
    const account = this.resolveAccountSelector(this.accountIdParam(params));
    return {
      account: this.mirrorAccount(account),
      limits: store.getAccountLimits(account.id),
      bees: store.beesOnAccount(account.id).map((b) => b.id),
      credentialed: this.mustAccounts().credentialed(account),
      credentialHealth: this.mustAccounts().credentialHealthOf(account),
      loginFlow: store.latestLoginFlow(account.id),
    };
  }

  private rpcAccountConfigPreview(params: Record<string, unknown>): AccountConfigPreviewResult {
    const account = this.requireAccount(params);
    const foreign = this.mustAccounts().foreignHomeRefusal(account, "imports configuration into");
    if (foreign) throw new RpcError("config_import_refused", foreign);
    try {
      return this.accountConfigImport.preview(account);
    } catch (error) {
      return this.refuseAccountConfigImport(error);
    }
  }

  private rpcAccountConfigImport(params: Record<string, unknown>): AccountConfigImportResult {
    const key = this.idempotencyKeyOf(params);
    if (key === null) throw new RpcError("invalid_request", "account.config.import requires idempotencyKey");
    const store = this.mustStore();
    return store.transact(() => {
      const hit = store.lookupRpcResult(key);
      if (hit) {
        if (hit.verb !== "account.config.import" || !isAccountConfigImportResult(hit.result)) {
          throw new RpcError("invalid_request", "idempotencyKey was already used for a different or invalid result");
        }
        this.log(`rpc.dedup verb=account.config.import key=${key}`);
        return hit.result;
      }
      const account = this.requireAccount(params);
      const foreign = this.mustAccounts().foreignHomeRefusal(account, "imports configuration into");
      if (foreign) throw new RpcError("config_import_refused", foreign);
      let result: AccountConfigImportResult;
      try {
        result = this.accountConfigImport.import(account);
      } catch (error) {
        return this.refuseAccountConfigImport(error);
      }
      store.recordRpcResult(key, "account.config.import", null, result);
      this.log(`account.config.import id=${account.id} imported=${result.imported.length} skipped=${result.skipped.length}`);
      return result;
    });
  }

  private refuseAccountConfigImport(error: unknown): never {
    if (error instanceof AccountConfigImportRefusal) {
      const code = error.reason === "unsupported_harness" ? "config_import_unsupported" : "config_import_refused";
      throw new RpcError(code, error.message);
    }
    throw error;
  }

  private async rpcAccountRemove(params: Record<string, unknown>, conn: RpcConn): Promise<AccountRemoveResult> {
    const account = this.requireAccount(params);
    const assertRemovalIngress = () => {
      const origin = knownAccountLease(this.mustStore().getAccount(account.id));
      if (origin?.fencesForwarded && conn.ingress !== "local_unix") throw new RpcError("account_lease_conflict", "Removing an account with lease fences requires a direct local Unix-socket call.", { account: account.id, reason: "local_required" });
    };
    assertRemovalIngress();
    this.mustAccounts().assertLeaseWriteIdle(account.id);
    if (account.source === "leased" && knownAccountLease(account)?.revokedAt == null) this.mustAccounts().assertLocalAccount(account);
    try { this.mustAccounts().authorityFor(account)?.assertDisabled(account); }
    catch (error) { throw new RpcError("account_unavailable", error instanceof Error ? error.message : "Credential cleanup failed"); }
    // v16: a login worker never outlives its account (the store cascades the rows).
    await this.mustLoginFlows().abandonAccount(account.id);
    return this.withIdempotency("account.remove", params, () => {
      assertRemovalIngress();
      this.mustAccounts().assertLeaseWriteIdle(account.id);
      const store = this.mustStore();
      // A referenced-account refusal must not remove its credential backup.
      try {
        this.mustAccounts().authorityFor(account)?.assertDisabled(account);
        if (store.beesOnAccount(account.id).length === 0) this.mustAccounts().authorityFor(account)?.forgetDisabled(account);
      } catch (error) { throw new RpcError("account_unavailable", error instanceof Error ? error.message : "Credential cleanup failed"); }
      return { account: this.mirrorAccount(store.removeAccount(account.id)) } satisfies AccountRemoveResult;
    });
  }

  private rpcAccountAdd(params: Record<string, unknown>): Promise<AccountAddResult> {
    const store = this.mustStore();
    const accounts = this.mustAccounts();
    const harness = this.param(params, "harness");
    if (params.native !== undefined && typeof params.native !== "boolean") throw new RpcError("invalid_request", "account.add: native must be a boolean");
    if (params.native === true) return this.withAsyncIdempotency("account.add", params, async () => this.addNativeAccount(harness, params));
    const label = this.param(params, "label");
    const id = typeof params.id === "string" && params.id.length > 0 ? params.id : accountIdFor(harness, label);
    if (!isAccountId(id)) throw new RpcError("invalid_request", "Account id must be a bounded safe account identity.");
    const homePath = typeof params.homePath === "string" && params.homePath.length > 0 ? resolve(params.homePath) : accounts.defaultHomeOf(id);
    if (homePath === accounts.nativeHomeOf(harness)) {
      throw new RpcError("invalid_request", `account.add: ${homePath} is this computer's own ${harness} sign-in; add it with native: true`);
    }
    const penalty = params.penalty === undefined ? 0 : params.penalty;
    if (typeof penalty !== "number") throw new RpcError("invalid_request", "account.add: penalty must be a number");
    const importExisting = params.importExisting === undefined ? false : params.importExisting;
    if (typeof importExisting !== "boolean") throw new RpcError("invalid_request", "account.add: importExisting must be a boolean");
    return this.withAsyncIdempotency("account.add", params, async () => {
      knownAccountLease(store.getAccount(id));
      if (store.getAccount(id)) throw new RpcError("invalid_request", `account already exists: ${id}`);
      // F2: a fresh account starts LOGGED OUT. Pre-existing credentials at the
      // home (a machine's live harness home handed in as homePath) or in a
      // leftover vault entry for this id would be silently adopted by the
      // credentialed()/activation machinery — that adoption must be an explicit
      // choice, and even then it is `unverified` until something validates it.
      const recipe = recipeFor(harness);
      if (recipe && !importExisting) {
        const found: string[] = [];
        if (dirHasCredentials(homePath, recipe)) found.push(`home ${homePath}`);
        const vaultDir = accounts.vaultDirOf({ harness, id });
        if (dirHasCredentials(vaultDir, recipe)) found.push(`vault ${vaultDir}`);
        if (found.length > 0) {
          throw new RpcError(
            "account_home_populated",
            `account.add: existing ${harness} credentials found (${found.join("; ")}); a new account starts logged out — ` +
              `log in fresh with account.login, or pass importExisting:true to adopt them ` +
              `(may sign the machine's regular ${harness} CLI out: refresh tokens rotate on use)`,
          );
        }
      }
      // v18: "import the existing sign-in" — the machine's real vendor home
      // counts, and nothing importable is a typed refusal, never a logged-out
      // row wearing `importExisting`.
      let imported: AccountAddResult["imported"] = null;
      if (importExisting) {
        const outcome = await accounts.importExistingCredentials({ harness, id, homePath });
        knownAccountLease(store.getAccount(id));
      if (store.getAccount(id)) throw new RpcError("invalid_request", `account already exists: ${id}`);
        if (!outcome.ok) {
          const checked = outcome.checked.length > 0 ? outcome.checked.map((c) => `${c.path} (${c.state})`).join(", ") : `${harness} has no identity recipe`;
          throw new RpcError(
            "no_credentials_to_import",
            `account.add: no ${harness} credentials to import — checked ${checked}; log in fresh with account.login`,
          );
        }
        imported = { source: outcome.source, from: outcome.from, files: outcome.files };
      }
      // v18: never `ok` without a credential.
      const status = accounts.honestStatus({ harness, id, homePath }, "ok");
      const account = store.createAccount({ id, harness, label, homePath, penalty, status });
      const credentialHealth = accounts.credentialHealthOf(account);
      const verification: AccountAddResult["verification"] = credentialHealth === "absent"
        ? "none"
        : accounts.scheduleVerification([id]).length > 0
          ? accounts.credentialProbeOf(harness)
          : "unsupported";
      this.log(
        `account.add id=${id} harness=${harness} home=${homePath} importExisting=${importExisting} status=${account.status} credentialHealth=${credentialHealth}` +
          `${imported ? ` imported=${imported.source}:${imported.from} files=${imported.files.join(",")}` : ""} verification=${verification}`,
      );
      return { account: accounts.mirrorRow(account), credentialHealth, imported, verification } satisfies AccountAddResult;
    });
  }

  /**
   * `account.add {native:true}`: the node's one native account, the
   * machine's own login (recipe `nativeOn`). Its home is the machine's vendor
   * home. Nothing is signed in, imported, copied or written: the user signs
   * in outside Honeybee, and the account says so.
   */
  private addNativeAccount(harness: string, params: Record<string, unknown>): AccountAddResult {
    const store = this.mustStore();
    const accounts = this.mustAccounts();
    const native = accounts.nativeRecipe(harness);
    if (!native) throw new RpcError("account_unavailable", `account.add: ${harness} has no native account on this computer`);
    if (params.homePath !== undefined || params.importExisting !== undefined) {
      throw new RpcError("invalid_request", `account.add: a native account takes no homePath or importExisting; it is this computer's own ${harness} sign-in`);
    }
    const existing = accounts.nativeAccount(harness);
    if (existing) throw new RpcError("invalid_request", `account.add: this computer already has its native ${harness} account: ${existing.id}`);
    const penalty = params.penalty === undefined ? 0 : params.penalty;
    if (typeof penalty !== "number") throw new RpcError("invalid_request", "account.add: penalty must be a number");
    const label = typeof params.label === "string" && params.label.trim().length > 0 ? params.label : native.label;
    const id = typeof params.id === "string" && params.id.length > 0 ? params.id : accountIdFor(harness, label);
    knownAccountLease(store.getAccount(id));
      if (store.getAccount(id)) throw new RpcError("invalid_request", `account already exists: ${id}`);
    const homePath = accounts.nativeHomeOf(harness)!;
    const account = store.createAccount({ id, harness, label, homePath, penalty, native: true, status: accounts.honestStatus({ harness, id, homePath }, "ok") });
    const credentialHealth = accounts.credentialHealthOf(account);
    this.log(`account.add id=${id} harness=${harness} native=true home=${homePath} status=${account.status} credentialHealth=${credentialHealth}`);
    return { account: accounts.mirrorRow(account), credentialHealth, imported: null, verification: "none" };
  }

  /** v18: `account.verify {id}` — the harness's real probe, awaited; the mirror row follows through the audit stream. */
  private rpcAccountVerify(params: Record<string, unknown>): Promise<AccountVerifyResult> {
    const account = this.requireAccount(params);
    return this.withAsyncIdempotency("account.verify", params, async () => {
      const accounts = this.mustAccounts();
      const res = await accounts.verifyCredentials(account);
      return { account: accounts.mirrorRow(res.account), outcome: res.outcome, probe: res.probe, limits: res.limits } satisfies AccountVerifyResult;
    });
  }

  /** `owner` ("operator" | "quota" | "lease") + `ownerId` (required unless operator) name the pause holder; `force` overrides a foreign holder. */
  private pauseParams(params: Record<string, unknown>, verb: string): { pause: AccountPause; force: boolean } {
    const by = params.owner === undefined || params.owner === null ? "operator" : this.param(params, "owner");
    if (by !== "operator" && by !== "quota" && by !== "lease") {
      throw new RpcError("invalid_request", `${verb}: owner must be operator, quota, or lease`);
    }
    const owner = params.ownerId === undefined || params.ownerId === null ? null : this.param(params, "ownerId");
    if (by === "operator" && owner !== null) throw new RpcError("invalid_request", `${verb}: an operator pause takes no ownerId`);
    if (by !== "operator" && owner === null) throw new RpcError("invalid_request", `${verb}: a ${by} pause requires ownerId`);
    if (params.force !== undefined && typeof params.force !== "boolean") throw new RpcError("invalid_request", `${verb}: force must be a boolean`);
    return { pause: { by, owner }, force: params.force === true };
  }

  private rpcAccountPause(params: Record<string, unknown>): AccountUpdateResult {
    const account = this.requireAccount(params);
    const accounts = this.mustAccounts();
    const { pause, force } = this.pauseParams(params, "account.pause");
    const res = this.mustStore().pauseAccount(account.id, pause, { force });
    if (!res.applied && res.heldBy) {
      throw new RpcError("account_pause_owned", `account ${account.id} is already paused by ${pauseLabel(res.heldBy)}; pass force to take the pause over`, { heldBy: res.heldBy as unknown as Record<string, unknown> });
    }
    this.log(`account.pause id=${account.id} by=${pauseLabel(pause)} force=${force} applied=${res.applied}`);
    return { account: accounts.mirrorRow(res.account), applied: res.applied };
  }

  private rpcAccountUnpause(params: Record<string, unknown>): AccountUpdateResult {
    const account = this.requireAccount(params);
    const accounts = this.mustAccounts();
    const { pause, force } = this.pauseParams(params, "account.unpause");
    // v18: unpausing a logged-out account lands on auth_needed, not ok.
    const honest = accounts.honestStatus(account, "ok") === "auth_needed" ? "auth_needed" : "ok";
    // An account the credential authority does not vouch for keeps that reason on the row.
    const inDoubt = honest === "auth_needed" ? accounts.authNeededReason(account) : null;
    const res = this.mustStore().unpauseAccount(account.id, pause, honest, { force, ...(inDoubt ? { reason: inDoubt } : {}) });
    if (!res.applied && res.heldBy) {
      throw new RpcError("account_pause_owned", `account ${account.id} is paused by ${pauseLabel(res.heldBy)}, not ${pauseLabel(pause)}; pass force to lift it anyway`, { heldBy: res.heldBy as unknown as Record<string, unknown> });
    }
    this.log(`account.unpause id=${account.id} by=${pauseLabel(pause)} force=${force} status=${res.account.status} applied=${res.applied}`);
    return { account: accounts.mirrorRow(res.account), applied: res.applied };
  }

  private rpcAccountSetPenalty(params: Record<string, unknown>): AccountUpdateResult {
    const account = this.requireAccount(params);
    const penalty = params.penalty;
    if (typeof penalty !== "number" || !Number.isFinite(penalty) || penalty < 0 || penalty > 100) {
      throw new RpcError("invalid_request", "account.setPenalty: penalty must be a number from 0 to 100");
    }
    const res = this.mustStore().setAccountPenalty(account.id, penalty);
    this.log(`account.setPenalty id=${account.id} penalty=${penalty} applied=${res.applied}`);
    return { account: this.mirrorAccount(res.account), applied: res.applied };
  }

  private rpcAccountSetWeeklyCeiling(params: Record<string, unknown>): AccountUpdateResult {
    const account = this.requireAccount(params);
    const ceiling = params.ceiling;
    if (ceiling !== null && (typeof ceiling !== "number" || !Number.isInteger(ceiling) || ceiling < 1 || ceiling > 100)) {
      throw new RpcError("invalid_request", "account.setWeeklyCeiling: ceiling must be an integer from 1 to 100, or null to clear");
    }
    const res = this.mustStore().setAccountWeeklyCeiling(account.id, ceiling);
    this.log(`account.setWeeklyCeiling id=${account.id} ceiling=${ceiling ?? "off"} applied=${res.applied}`);
    if (res.applied) this.lastWeeklyCeilingSweepAt = 0;
    return { account: this.mirrorAccount(res.account), applied: res.applied };
  }

  private mustLoginFlows(): LoginFlowService {
    if (!this.loginFlows || this.stopping) throw new RpcError("node_stopped", "daemon is shutting down");
    return this.loginFlows;
  }

  /**
   * One-key idempotency for the ASYNC login verbs (they await provider
   * transports / worker start, so the sync transactional wrapper does not
   * apply): a seen key answers with the recorded SAFE result (the flow row)
   * and never re-executes; a failed execution records nothing.
   */
  private async withAsyncIdempotency<T extends object>(verb: RpcVerb, params: Record<string, unknown>, fn: () => Promise<T>): Promise<T | (T & { deduped: true })> {
    const key = this.idempotencyKeyOf(params);
    const store = this.mustStore();
    if (key != null) {
      const hit = store.lookupRpcResult(key);
      if (hit) {
        if (hit.verb !== verb) throw new RpcError("idempotency_conflict", `Key belongs to ${hit.verb}, not ${verb}`);
        this.log(`rpc.dedup verb=${verb} key=${key}`);
        return { ...(hit.result as T), deduped: true as const };
      }
      const inFlight = this.asyncInFlight.get(key);
      if (inFlight) {
        this.log(`rpc.dedup verb=${verb} key=${key} joined=in_flight`);
        return { ...((await inFlight) as T), deduped: true as const };
      }
    }
    const pending = fn();
    if (key != null) this.asyncInFlight.set(key, pending);
    try {
      const result = await pending;
      if (key != null) store.recordRpcResult(key, verb, null, publicBeeResult(result));
      return result;
    } finally {
      if (key != null && this.asyncInFlight.get(key) === pending) this.asyncInFlight.delete(key);
    }
  }

  private flowIdParam(params: Record<string, unknown>): string {
    return this.param(params, "flowId");
  }

  /** `account.login.start {id, methodId?, remote?}` (alias: `account.login {id}`). */
  private rpcAccountLoginStart(params: Record<string, unknown>): Promise<AccountLoginStartResult> {
    const account = this.requireAccount(params);
    const methodId = params.methodId === undefined || params.methodId === null ? null : this.param(params, "methodId");
    if (params.remote !== undefined && typeof params.remote !== "boolean") throw new RpcError("invalid_request", "account.login.start: remote must be a boolean");
    const remote = params.remote === true;
    const replaceAccount = this.replaceAccountParam(params, "account.login.start");
    return this.withAsyncIdempotency("account.login.start", params, async () => {
      const started = await this.mustLoginFlows().start(account, { methodId, remote, replaceAccount });
      return { accountId: account.id, flow: started.flow, rejoined: started.rejoined } satisfies AccountLoginStartResult;
    });
  }

  /** `account.login.get {flowId}` | `{id}` (account selector → latest flow). */
  private rpcAccountLoginGet(params: Record<string, unknown>): AccountLoginGetResult {
    const store = this.mustStore();
    if (typeof params.flowId === "string" && params.flowId.length > 0) {
      const flow = store.getLoginFlow(params.flowId);
      if (!flow) throw new RpcError("login_flow_not_found", `login flow not found: ${params.flowId}`);
      return { flow };
    }
    const account = this.requireAccount(params);
    const flow = store.latestLoginFlow(account.id);
    if (!flow) throw new RpcError("login_flow_not_found", `account ${account.id} has no login flow`);
    return { flow };
  }

  private rpcAccountLoginSelectMethod(params: Record<string, unknown>): Promise<AccountLoginSelectMethodResult> {
    const flowId = this.flowIdParam(params);
    const methodId = this.param(params, "methodId");
    return this.withAsyncIdempotency("account.login.selectMethod", params, async () => ({ flow: await this.mustLoginFlows().selectMethod(flowId, methodId) }));
  }

  /**
   * `account.login.submit {flowId, values}` — SENSITIVE. `values` is read
   * once, handed to the flow service, and never logged, audited, or recorded
   * (the idempotency record is the safe flow row only).
   */
  private rpcAccountLoginSubmit(params: Record<string, unknown>): Promise<AccountLoginSubmitResult> {
    const flowId = this.flowIdParam(params);
    const raw = params.values;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new RpcError("invalid_request", "account.login.submit: values must be an object of strings");
    const values: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v !== "string") throw new RpcError("invalid_request", `account.login.submit: field '${k}' must be a string`);
      if (v.length > 8192) throw new RpcError("invalid_request", `account.login.submit: field '${k}' is too long`);
      values[k] = v;
    }
    return this.withAsyncIdempotency("account.login.submit", params, async () => ({ flow: await this.mustLoginFlows().submit(flowId, values) }));
  }

  private rpcAccountLoginRetry(params: Record<string, unknown>): Promise<AccountLoginRetryResult> {
    const flowId = this.flowIdParam(params);
    const replaceAccount = this.replaceAccountParam(params, "account.login.retry");
    return this.withAsyncIdempotency("account.login.retry", params, async () => ({ flow: await this.mustLoginFlows().retry(flowId, { replaceAccount }) }));
  }

  /** `replaceAccount: true` lets a centrally managed account's in-place login switch to another Anthropic account. */
  private replaceAccountParam(params: Record<string, unknown>, verb: string): boolean {
    if (params.replaceAccount !== undefined && typeof params.replaceAccount !== "boolean") throw new RpcError("invalid_request", `${verb}: replaceAccount must be a boolean`);
    return params.replaceAccount === true;
  }

  private rpcAccountLoginCancel(params: Record<string, unknown>): AccountLoginCancelResult {
    const flowId = this.flowIdParam(params);
    const res = this.mustLoginFlows().cancel(flowId);
    return { flow: res.flow, applied: res.applied };
  }

  /**
   * The one entry for "this account's credential works again on this node":
   * clears the bees' `auth_needed` flags and resumes the turns it cut off.
   */
  private credentialValidated(accountId: string, by: AuthRestoreSource): CredentialValidatedReceipt | null {
    if (by !== "limits_probe") this.runtimeStartProbeAt.delete(accountId);
    const store = this.mustStore();
    const account = store.getAccount(accountId);
    if (!account || !this.authResume) return null;
    // A login or capture while central credentials are disabled leaves the
    // native refresh chain in the home, so a following enable must find the
    // account quiescent: its validating rotation restores the account then.
    if ((by === "login" || by === "capture") && store.getAccountCredentialAuthority(account.id)?.phase === "disabled") {
      this.log(`auth.resume.deferred account=${account.id} by=${by} until=central_enable`);
      return null;
    }
    return this.authResume.credentialValidated(account, by);
  }

  /** For callers whose own work (a login, a capture, a limits sweep) already succeeded and must stay so. */
  private credentialValidatedQuietly(accountId: string, by: AuthRestoreSource): void {
    try {
      this.credentialValidated(accountId, by);
    } catch (err) {
      this.log(`auth.resume.error account=${accountId} by=${by} err=${err instanceof Error ? err.message : String(err)}`);
    }
    this.requestTick();
  }

  /**
   * `account.credentialsRestored {id}` — the caller installed a working
   * credential in the account home outside the daemon (Apiary writing a
   * leased credential on a satellite). The daemon checks the copy runtimes
   * read, then treats it like any other validated credential.
   */
  private rpcAccountCredentialsRestored(params: Record<string, unknown>): AccountCredentialsRestoredResult {
    const account = this.requireAccount(params);
    return this.withIdempotency("account.credentialsRestored", params, () => {
      const accounts = this.mustAccounts();
      const store = this.mustStore();
      const unisolated = accounts.isolationRefusal(account.harness);
      if (unisolated && !accounts.isNative(account)) throw new RpcError("account_unavailable", unisolated);
      const moved = accounts.nativeHomeRefusal(account);
      if (moved) throw new RpcError("account_unavailable", moved);
      const credential = accounts.homeCredentialState(account);
      if (credential !== "usable") {
        throw new RpcError("account_unavailable", `account ${account.id} has ${credential === "absent" ? "no" : "an expired"} credential in its home`);
      }
      if (account.status === "auth_needed" && store.setAccountStatus(account.id, "ok", "credentials restored").applied) {
        this.log(`account.auth_ok account=${account.id} by=credentials_restored`);
      }
      const receipt = this.credentialValidated(account.id, "credentials_restored")!;
      return {
        account: this.mirrorAccount(store.getAccount(account.id)!),
        revision: receipt.revision,
        clearedBeeIds: receipt.clearedBeeIds,
        resumingBeeIds: receipt.resumingBeeIds,
        blockedBeeIds: receipt.blockedBeeIds,
      } satisfies AccountCredentialsRestoredResult;
    });
  }

  /** `account.interruptions {id?, beeId?}` — the auth-interrupted turns and what became of them. */
  private rpcAccountInterruptions(params: Record<string, unknown>): AccountInterruptionsResult {
    const account = params.id === undefined || params.id === null ? undefined : this.requireAccount(params).id;
    const beeId = typeof params.beeId === "string" ? params.beeId : undefined;
    return { interruptions: this.mustStore().listAuthInterruptions({ ...(account ? { account } : {}), ...(beeId ? { beeId } : {}) }) };
  }

  private async rpcAccountCapture(params: Record<string, unknown>): Promise<AccountCaptureResult> {
    const account = this.requireAccount(params);
    this.mustAccounts().assertLocalAccount(account);
    const key = this.idempotencyKeyOf(params);
    const store = this.mustStore();
    if (key != null) {
      const hit = store.lookupRpcResult(key);
      if (hit) return { ...(hit.result as AccountCaptureResult), deduped: true };
    }
    let captured: CaptureOutcome;
    try {
      captured = await this.mustAccounts().captureAccount(account);
    } catch (err) {
      throw new RpcError("invalid_request", err instanceof Error ? err.message : String(err));
    }
    this.credentialValidatedQuietly(account.id, "capture");
    const result: AccountCaptureResult = { ...captured, account: this.mirrorAccount(captured.account) };
    if (key != null) store.recordRpcResult(key, "account.capture", null, result);
    return result;
  }

  private async rpcAccountLimits(params: Record<string, unknown>): Promise<AccountLimitsResult> {
    const accounts = this.mustAccounts();
    const ids = params.id === undefined || params.id === null ? undefined : [this.requireAccount(params).id];
    const limits = await accounts.refreshLimits(ids);
    return { limits };
  }

  private async rpcAccountResetLimits(params: Record<string, unknown>): Promise<AccountResetLimitsResult> {
    const account = this.requireAccount(params);
    this.mustAccounts().assertLocalAccount(account);
    const key = this.idempotencyKeyOf(params);
    if (!key) throw new RpcError("invalid_request", "account.resetLimits requires a non-empty idempotencyKey");
    const creditId = params.creditId;
    if (creditId !== undefined && (typeof creditId !== "string" || creditId.length === 0)) {
      throw new RpcError("invalid_request", "creditId must be a non-empty string when given");
    }
    const store = this.mustStore();
    const hit = store.lookupRpcResult(key);
    if (hit) return { ...(hit.result as AccountResetLimitsResult), deduped: true };
    let result: AccountResetLimitsResult;
    try {
      result = await this.mustAccounts().resetLimits(account, key, creditId as string | undefined);
      store.recordRpcResult(key, "account.resetLimits", null, result);
    } catch (error) {
      if (error instanceof ResetLimitsRefusal) throw new RpcError(error.code, error.message);
      throw new RpcError("provider_outcome_uncertain", error instanceof Error ? error.message : String(error));
    }
    return result;
  }

  private rpcAccountImportRegistry(params: Record<string, unknown>): AccountImportRegistryResult {
    const root = typeof params.root === "string" && params.root.length > 0 ? params.root : join(homedir(), ".hive");
    const dryRun = params.dryRun === true;
    const report = this.mustAccounts().importRegistry(root, { dryRun });
    this.log(`account.importRegistry root=${root} dryRun=${dryRun} applied=${report.applied} import=${report.counts.import} skip=${report.counts.skip}${report.refusal ? ` refusal=${JSON.stringify(report.refusal)}` : ""}`);
    const backfill = report.applied ? this.mustAccounts().backfillBeeAccounts() : undefined;
    return { ...report, ...(backfill ? { backfill } : {}) };
  }

  private rpcAccountBackfill(params: Record<string, unknown>): AccountBackfillResult {
    return this.mustAccounts().backfillBeeAccounts({ dryRun: params.dryRun === true });
  }

  /**
   * v19: `account.lease {account, harness?}` — the credential-lease mint
   * (RN7a). SENSITIVE: the result carries secret bytes and is the ONLY place
   * they appear — no idempotency record, no audit row, no log line with
   * material; AccountsService.mintLease logs a secret-free summary only.
   */
  private async rpcAccountLeaseInstall(params: Record<string, unknown>, conn: RpcConn): Promise<AccountLeaseInstallResult> {
    const invalid = () => new RpcError("invalid_request", "Lease install requires safe ids, a supported harness, epoch, access expiry, and access-only credential files.");
    const safeId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(value);
    if (!isAccountId(params.id) || !safeId(params.shareId) || params.shareId.length < 8 || !safeId(params.authorityNodeId) || !safeId(params.harness) || !isAccountId(params.label)) throw invalid();
    if (params.adopt !== undefined && typeof params.adopt !== "boolean" && params.adopt !== "explicit") throw invalid();
    if (params.enrol !== undefined && typeof params.enrol !== "boolean" || params.enrol && params.adopt !== undefined || params.enrol && !safeId(params.viaNodeId) || params.viaNodeId !== undefined && !safeId(params.viaNodeId)) throw invalid();
    if (params.authorityInstanceId !== undefined && !safeId(params.authorityInstanceId)) throw invalid();
    if (params.generation !== undefined && (typeof params.generation !== "number" || !Number.isSafeInteger(params.generation) || params.generation < 0)) throw invalid();
    if (typeof params.epoch !== "number" || !Number.isSafeInteger(params.epoch) || params.epoch < 0) throw invalid();
    if (params.expiresAt !== null && (typeof params.expiresAt !== "number" || !Number.isSafeInteger(params.expiresAt) || params.expiresAt * 1000 <= Date.now())) throw invalid();
    const unisolated = this.mustAccounts().isolationRefusal(params.harness);
    if (unisolated) throw new RpcError("lease_unsupported", unisolated);
    const codec = this.mustAccounts().leaseMaterialCodecs.get(params.harness);
    if (!codec) throw new RpcError("lease_unsupported", "This harness does not support peer leases.");
    if (!Array.isArray(params.files) || params.files.length === 0 || params.files.length > codec.files.length) throw invalid();
    const seen = new Set<string>();
    const hasRefresh = (value: unknown): boolean => {
      if (value === null || typeof value !== "object") return false;
      return Object.entries(value).some(([key, child]) => ["refreshToken", "refresh_token", "refresh"].includes(key) && child !== "" && child !== null || hasRefresh(child));
    };
    for (const value of params.files) {
      if (!value || typeof value !== "object") throw invalid();
      const file = value as Record<string, unknown>;
      if (typeof file.homeRelPath !== "string" || !codec.files.includes(file.homeRelPath) || seen.has(file.homeRelPath) || file.mode !== 0o600 || typeof file.contentB64 !== "string" || file.contentB64.length > 1_000_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.contentB64)) throw invalid();
      seen.add(file.homeRelPath);
      let document: unknown;
      try { document = JSON.parse(Buffer.from(file.contentB64, "base64").toString("utf8")); } catch { throw invalid(); }
      if (!document || typeof document !== "object" || Array.isArray(document) || hasRefresh(document)) throw invalid();
      if (file.homeRelPath === codec.primaryFile && !this.mustAccounts().validPrimaryCredential(params.harness, file.homeRelPath, JSON.stringify(document))) throw invalid();
    }
    if (!seen.has(codec.primaryFile)) throw invalid();
    let restored: AccountCredentialsRestoredResult | undefined;
    const installed = await this.mustAccounts().installLease(params as unknown as AccountLeaseInstallParams, account => { restored = this.rpcAccountCredentialsRestored({ id: account.id }); }, conn.ingress === "local_unix");
    return { ...installed, account: restored!.account, restored: restored! };
  }

  private async rpcAccountLease(params: Record<string, unknown>): Promise<AccountLeaseResult> {
    const account = this.requireAccount(params, "account");
    if (params.harness !== undefined && params.harness !== null) {
      const harness = this.param(params, "harness");
      if (harness !== account.harness) {
        throw new RpcError("harness_mismatch", `account ${account.id} is a ${account.harness} account, not ${harness}`);
      }
    }
    // A paused account is the operator saying "place no new work on this";
    // leasing it to a satellite is exactly that.
    if (account.status === "paused") {
      throw new RpcError("account_paused", `account ${account.id} is paused; unpause it before leasing`);
    }
    let minTtlMs: number | undefined;
    if (params.minTtlMs !== undefined && params.minTtlMs !== null) {
      if (typeof params.minTtlMs !== "number" || !Number.isSafeInteger(params.minTtlMs) || params.minTtlMs < 0 || params.minTtlMs > MAX_LEASE_MIN_TTL_MS) {
        throw new RpcError("invalid_request", `account.lease: minTtlMs must be an integer from 0 to ${MAX_LEASE_MIN_TTL_MS}`);
      }
      minTtlMs = params.minTtlMs;
    }
    const lease = await this.mustAccounts().mintLease(account, { minTtlMs });
    return { account: account.id, harness: account.harness, ...lease };
  }

  /**
   * `bee.swapAccount {beeId, account}` (spec 08): same-harness only. Rebind
   * (account + home env; claude cross-account: rekey the session so the
   * conversation resumes under a NEW id via --resume <seed> --fork-session),
   * then stop the live runtime with `thenRevive` so the next generation
   * boots in the new account's home and resumes. A stopped bee is only
   * rebound (its next wake runs on the new account).
   */
  private async rpcSwapAccountWithAdmission(params: Record<string, unknown>): Promise<SwapAccountResult> {
    const store = this.mustStore();
    const key = this.idempotencyKeyOf(params);
    if (key != null && store.lookupRpcResult(key)) {
      return this.withIdempotency("bee.swapAccount", params, () => this.rpcSwapAccount(params));
    }
    const beeId = this.requireBee(params);
    const bee = store.getBee(beeId) as BeeRow;
    const selector = this.param(params, "account");
    const claim = this.allocationClaimParam(params);
    if (claim && selector !== "auto") throw new RpcError("invalid_request", "allocationClaim requires account:auto");
    if (selector === "auto" && !claim && this.mustAccounts().allocationMode() === "shadow") {
      await this.mustAccounts().ensureFreshAdmissionLimits(bee.agent, {
        excludeAccountIds: !params.quotaRecoveryId && bee.account ? new Set([bee.account]) : undefined,
        onlyAccountIds: this.admissionAccountIdsParam(params, "onlyAccountIds"),
        model: this.modelParamOf({ args: bee.args ?? [] }, bee.agent),
      });
    }
    if (key != null && store.lookupRpcResult(key)) return this.withIdempotency("bee.swapAccount", params, () => this.rpcSwapAccount(params));
    return this.rpcSwapAccount(params, effect => this.withIdempotency("bee.swapAccount", params, effect));
  }

  private rpcSwapAccount(params: Record<string, unknown>, commit?: (effect: () => SwapAccountResult) => SwapAccountResult): SwapAccountResult {
    const store = this.mustStore();
    const beeId = this.requireBee(params);
    const bee = store.getBee(beeId) as BeeRow;
    const selector = this.param(params, "account");
    const onlyAccountIds = this.admissionAccountIdsParam(params, "onlyAccountIds");
    const recoveryId = typeof params.quotaRecoveryId === "string" ? params.quotaRecoveryId : undefined;
    if (recoveryId) {
      const recovery = store.getQuotaRecovery(recoveryId);
      if (!recovery || recovery.beeId !== bee.id || recovery.state !== "waiting" || !store.quotaRecoveryValid(recovery)) throw new RpcError("invalid_request", "quota recovery is no longer claimable");
      const current = store.currentRuntime(bee.id);
      if (recovery.trigger === "proactive" && current?.state === "running" && current.bootEvidence === "real") throw new RpcError("account_wait", "The accepted provider turn still owns its completion reserve", { retryAt: null });
      if (autoswapDisabled(bee)) throw new RpcError("account_unavailable", "Automatic quota recovery is disabled");
    }
    if (selector !== "auto") {
      const target = this.resolveAccountSelector(selector, bee.agent);
      if (onlyAccountIds && !onlyAccountIds.has(target.id)) {
        throw new RpcError("account_unavailable", `account ${target.id} is outside the allowed account ids for this swap`, { account: target.id });
      }
      return this.performSwap(bee, target, "operator", undefined, undefined, undefined, undefined, commit);
    }
    const runtime = store.currentRuntime(bee.id);
    const claim = this.allocationClaimParam(params);
    if (claim) {
      if (onlyAccountIds && !onlyAccountIds.has(claim.account)) {
        throw new RpcError("invalid_request", `bee.swapAccount: allocationClaim ${claim.id} names ${claim.account}, outside onlyAccountIds`);
      }
      if (recoveryId && store.getQuotaRecovery(recoveryId)?.trigger === "proactive" && claim.account === bee.account) throw new RpcError("account_wait", "Proactive recovery must release the source in place", { retryAt: null });
      const target = this.accountFromClaim(
        claim, "swap", bee.agent, bee.id, runtime?.generation ?? 0, bee.account,
        this.modelParamOf({ args: bee.args ?? [] }, bee.agent),
        recoveryId !== undefined && (() => {
          const recovery = store.getQuotaRecovery(recoveryId);
          if (!recovery) return false;
          return recovery.quota !== null && (!("trigger" in recovery) || recovery.trigger === "provider_limit")
            && recovery.sourceAccount === bee.account && recovery.sourceGeneration === (runtime?.generation ?? 0)
            && claim.sourceQuotaRecovery?.observedAt === recovery.createdAt
            && claim.sourceQuotaRecovery.window === recovery.quota.window
            && claim.sourceQuotaRecovery.resetsAt === recovery.quota.resetsAt;
        })(),
      );
      if (recoveryId && store.getQuotaRecovery(recoveryId)?.trigger === "proactive" && bee.account) {
        const comparison = this.mustAccounts().proactiveTargets(bee.agent, bee.account, this.modelOfBee(bee), bee.id, claim.id);
        if (comparison.uncertain || !comparison.accountIds.has(target.id)) {
          this.refusedClaims.set(claim.id, claim);
          throw new RpcError("account_claim_refused", "Proactive claim no longer has materially better remaining allowance", { claimId: claim.id, account: target.id });
        }
      }
      return this.performSwap(bee, target, "operator", claim.allocation, undefined, claim, recoveryId, commit);
    }
    if (this.mustAccounts().allocationMode() === "active") this.ownerClaimRequired(bee.agent, "swap");
    const admission = store.transact(() => {
      let relativeTargets = onlyAccountIds;
      if (recoveryId && store.getQuotaRecovery(recoveryId)?.trigger === "proactive" && bee.account) {
        relativeTargets = this.mustAccounts().proactiveTargets(bee.agent, bee.account, this.modelOfBee(bee), bee.id).accountIds;
        if (onlyAccountIds) relativeTargets = new Set([...relativeTargets].filter(account => onlyAccountIds.has(account)));
        if (relativeTargets.size === 0) throw new RpcError("account_wait", "No account has materially better remaining allowance", { retryAt: null });
      }
      const admission = this.mustAccounts().admitNewWork(bee.agent, {
        operation: "swap",
        requestKey: this.idempotencyKeyOf(params) ?? `implicit:${bee.id}:${runtime?.generation ?? 0}:${bee.account ?? "unbound"}`,
        excludeAccountIds: (!recoveryId || store.getQuotaRecovery(recoveryId)?.trigger === "proactive") && bee.account ? new Set([bee.account]) : undefined,
        allowSourceAccount: !!recoveryId && store.getQuotaRecovery(recoveryId)?.trigger !== "proactive",
        sourceQuotaRecovery: recoveryId ? (() => {
          const recovery = store.getQuotaRecovery(recoveryId)!;
          return { observedAt: recovery.createdAt, window: recovery.quota?.window ?? "other", resetsAt: recovery.quota?.resetsAt ?? recovery.resetHints.other ?? null, usedPercentAtObservation: recovery.sourceWindowUsedPercent, usedPercentObservedAt: recovery.sourceWindowObservedAt };
        })() : undefined,
        excludeRecentlyExhausted: !!recoveryId,
        onlyAccountIds: relativeTargets,
        model: this.modelParamOf({ args: bee.args ?? [] }, bee.agent),
        context: this.allocationContextParam(params),
        beeId: bee.id,
        sourceAccount: bee.account,
        reconcileAfterGeneration: runtime?.generation ?? 0,
      });
      if (!admission.ok) throw new RpcError(admission.code, admission.message, { allocation: admission.receipt as unknown as Record<string, unknown> });
      return admission;
    });
    try {
      return this.performSwap(bee, admission.account, "operator", admission.receipt, admission.reservation?.id, undefined, recoveryId, commit);
    } catch (error) {
      if (admission.reservation) store.releaseAccountAdmission(admission.reservation.id);
      throw error;
    }
  }

  private performSwap(
    bee: BeeRow,
    target: AccountRow,
    by: "operator" | "rotation" | "ceiling",
    allocation?: AccountAllocationReceipt,
    reservationId?: string,
    claim?: AccountAdmissionClaim,
    quotaRecoveryId?: string,
    commit?: (effect: () => SwapAccountResult) => SwapAccountResult,
  ): SwapAccountResult {
    const store = this.mustStore();
    const accounts = this.mustAccounts();
    if (target.harness !== bee.agent) {
      throw new RpcError("harness_mismatch", `account ${target.id} is a ${target.harness} account; bee ${bee.name} runs ${bee.agent}`);
    }
    const from = bee.account;
    if (from === target.id && !quotaRecoveryId) {
      const noop: SwapAccountResult = { beeId: bee.id, from, to: target.id, action: "noop", commandId: null, rekeyed: false, transcript: "none" };
      return commit ? commit(() => noop) : noop;
    }
    // The destination is validated in full before the running source is touched.
    const readiness = accounts.readiness(target);
    if (!readiness.ready) throw new RpcError(readiness.code, readiness.message, { account: target.id });
    const breach = accounts.weeklyCeilingBreach(target, this.modelOfBee(bee));
    if (breach) throw new RpcError("account_unavailable", describeWeeklyCeilingBreach(target.id, breach));
    // Before any state moves: the destination home must hold the conversation
    // the next generation resumes, or the swap is refused (typed) up front.
    const transcript = bee.agent === "claude" ? this.carryClaudeTranscript(bee, from, target)
      : bee.agent === "codex" ? this.carryCodexTranscript(bee, target) : "none";
    const rt = store.currentRuntime(bee.id);
    const live = rt != null && rt.state !== "stopped";
    let rekeyed = false;
    let commandId: number | null = null;
    const apply = () => {
      store.transact(() => {
        if (quotaRecoveryId) {
          if (!store.claimQuotaRecovery(quotaRecoveryId, { targetAccount: target.id, claimId: claim?.id, reservationId })) throw new RpcError("invalid_request", "quota recovery is no longer claimable");
        } else store.cancelQuotaRecoveries(bee.id, "manual_swap");
        store.setBeeAccount(bee.id, target.id);
        const key = homeEnvFor(bee.agent);
        const env = { ...bee.env };
        if (key) delete env[key];
        store.setBeeEnv(bee.id, { ...env, ...accounts.homeEnvOf(target) });
        if (target.status === "ok" && store.activeFlags(bee.id).some((f) => f.flag === "auth_needed")) {
          store.clearFlag(bee.id, "auth_needed", `account swapped to ${target.id}`);
        }
        this.authResume?.beeSwapped(bee.id, target);
        // Claude cross-account moves mint a fresh session id (the old
        // copyThread rule): the resume runs as `--resume <seed> --fork-session`.
        if (bee.agent === "claude" && from !== target.id) rekeyed = store.rekeyBeeSession(bee.id).applied;
        if (live && rt) {
          commandId = store.enqueueCommand("stop", bee.id, { cause: "stopped_by_system", reason: `swap_account:${by}`, thenRevive: true }).id;
        }
        if (quotaRecoveryId) {
          if (!live) commandId = store.enqueueCommand("revive", bee.id, { reason: "quota_recovery" }).id;
          store.bindQuotaRecovery(quotaRecoveryId, commandId);
        }
        if (claim) {
          this.consumeAccountClaim(claim, bee.id);
        } else if (reservationId) store.bindAccountAdmission(reservationId, bee.id);
      });
      const action: SwapAccountResult["action"] = live ? "stop_then_revive" : "rebind_only";
      this.log(`bee.swapAccount bee=${bee.id} from=${from ?? "-"} to=${target.id} by=${by} action=${action} rekeyed=${rekeyed} transcript=${transcript}${commandId != null ? ` stop=${commandId}` : ""}`);
      return { beeId: bee.id, from, to: target.id, action, commandId, rekeyed, transcript,
        ...(allocation ? { allocation } : {}), ...(claim ? { allocationClaimId: claim.id } : {}) };
    };
    return commit ? commit(apply) : apply();
  }

  private carryCodexTranscript(bee: BeeRow, target: AccountRow): SwapAccountResult["transcript"] {
    const sessionId = bee.providerSessionId ?? bee.forkSeed;
    if (!sessionId) return "none";
    if (!bee.providerSessionId) throw new RpcError("transcript_unavailable", `bee ${bee.name}: Codex fork must start before its account can be swapped`);
    try {
      const spec = this.resolveSpawnSpec(bee.id);
      const home = spec.env?.CODEX_HOME ?? join(homedir(), ".codex");
      const carried = codexSwapHistoryPath(home, bee.id, sessionId);
      const operation = this.mustStore().threadOperationForSuccessor(bee.id);
      const path = existsSync(carried) ? carried
        : operation?.successorProviderSessionId === sessionId ? operation.sessionPath
        : codexHistoryPath(home, sessionId);
      const source = pinThreadHistory(path, sessionId);
      const destination = codexSwapHistoryPath(target.homePath, bee.id, sessionId);
      const result = carryCodexHistory(source, target.homePath, destination, sessionId);
      this.log(`bee.swapAccount.transcript bee=${bee.id} seed=${sessionId} from=${source.path} to=${destination} bytes=${source.bytes} method=hardlink`);
      return result;
    } catch (error) {
      throw new RpcError("transcript_unavailable", `bee ${bee.name}: Codex conversation ${sessionId} cannot be carried to ${target.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Claude resolves `--resume <id>` inside its config dir ONLY: a swap that
   * rekeys the session (`--resume <seed> --fork-session` in the destination
   * home) fails on its first turn — `result error_during_execution`,
   * "No conversation found with session ID" — when the transcript lives in
   * the source home, and every later wake repeats the same crash (field
   * finding 2026-09-02: three of three cross-account swaps). So the
   * transcript is carried over first: `projects/<cwd-key>/<seed>.jsonl` plus
   * its sibling `<seed>/` dir (sub-agent transcripts, tool results), copied
   * into the same project key under the destination home. Idempotent — an
   * already-present destination is left alone (never overwritten). The seed
   * is the bee's current session id, or its pending fork seed when a prior
   * rekey has not been consumed yet (a stopped bee swapped twice).
   */
  private carryClaudeTranscript(bee: BeeRow, from: string | null, target: AccountRow): SwapAccountResult["transcript"] {
    const seed = bee.providerSessionId ?? bee.forkSeed;
    if (!seed) return "none";
    const key = homeEnvFor("claude");
    const boundHome = key ? bee.env[key] : undefined;
    const sourceHome = boundHome ?? (from ? this.mustStore().getAccount(from)?.homePath : undefined) ?? join(homedir(), ".claude");
    const projectKey = claudeProjectKey(bee.cwd);
    const destDir = join(target.homePath, "projects", projectKey);
    const destFile = join(destDir, `${seed}.jsonl`);
    if (existsSync(destFile)) return "present";
    const source = findClaudeTranscript(sourceHome, projectKey, seed);
    if (!source) {
      throw new RpcError(
        "transcript_unavailable",
        `bee ${bee.name}: conversation ${seed} was not found under ${sourceHome} (projects/${projectKey}); swapping to ${target.id} would resume nothing`,
      );
    }
    mkdirSync(destDir, { recursive: true });
    copyFileSync(source.file, destFile);
    if (source.dir && !existsSync(join(destDir, seed))) cpSync(source.dir, join(destDir, seed), { recursive: true });
    this.log(`bee.swapAccount.transcript bee=${bee.id} seed=${seed} from=${source.file} to=${destFile}${source.dir ? " +dir" : ""}`);
    return "copied";
  }

  /** Observed subscription usage lands on the account the generation ran with. */
  private applyUsageObservation(ev: UsageEvidenceLike): void {
    const bee = this.mustStore().getBee(ev.beeId);
    if (!bee?.account || !this.accounts) return;
    const account = this.accounts.accountForGeneration(bee, ev.generation);
    if (account) this.accounts.observeLimits(account, ev);
  }

  /**
   * Account policy over adapter flag evidence (spec 08 "auth_needed ↔ Log in"
   * + "Automatic rotation on exhaustion"):
   *  - auth_needed set → accounts.status = auth_needed (bee flag already set
   *    by the loop); auth_needed clear (authenticated turn) → status ok.
   *  - resource_blocked set with a rate-limit cause → exhaustion evidence on
   *    the account, then ONE rotation attempt for this (bee, generation):
   *    selection for the harness excluding the current account (and recently
   *    exhausted ones); a candidate → swapAccount; none → the bee stays
   *    flagged and visible. Per-bee opt-out: tag/arg `autoswap=false`.
   *  - resource_blocked clear (turn served / allowed again) → exhaustion cleared.
   */
  private applyAccountPolicy(ev: FlagEvidenceLike): void {
    const store = this.mustStore();
    const accounts = this.accounts;
    if (!accounts) return;
    const bee = store.getBee(ev.beeId);
    if (!bee || !bee.account) return;
    const account = accounts.accountForGeneration(bee, ev.generation);
    if (!account) return;
    if (ev.flag === "auth_needed") {
      // One bee's turn cannot overrule the credential authority: a session can
      // still authenticate on an old access token after the login itself died.
      // The authority keeps the account's status; the cut-off turn is still
      // recorded so the authority's recovery resumes it.
      const authorityInDoubt = accounts.centralCredentialInDoubt(account);
      if (ev.action === "set") {
        // Delayed-error preservation (HIVE-2): a still-valid on-disk Claude
        // credential means a newer session (or the daemon) already recovered
        // this account, so THIS auth_needed is likely a delayed 401 from an
        // older session. Don't clobber the fresh credential to auth_needed;
        // let the coordinated recovery probe be the arbiter — if the token is
        // truly dead server-side, that probe's 401 sets auth_needed.
        const preserve = account.harness === "claude"
          && account.status !== "auth_needed"
          && accounts.claudeCredentialFresh(account);
        if (authorityInDoubt) {
          this.log(`account.auth_needed_owned account=${account.id} bee=${bee.id} gen=${ev.generation} by=central_authority`);
        } else if (preserve) {
          this.log(`account.auth_needed_deferred account=${account.id} bee=${bee.id} gen=${ev.generation} reason=fresh_credential`);
        } else if (account.status !== "paused" && store.setAccountStatus(account.id, "auth_needed", `bee ${bee.id}: ${ev.detail.slice(0, 200)}`).applied) {
          this.log(`account.auth_needed account=${account.id} bee=${bee.id} gen=${ev.generation}`);
        }
        // Coordinated per-account recovery: re-check newer credentials,
        // refresh through the daemon's own refresher (no longer deferred to a
        // session that has itself failed auth), and request login only when
        // that refresh is rejected or absent.
        this.authResume?.interrupted(ev);
        if (account.harness === "claude" && !authorityInDoubt) accounts.scheduleClaudeRecovery(account.id);
      } else {
        store.quotaTurnSucceeded(bee.id, ev.generation);
        this.authResume?.turnSucceeded(bee.id);
        if (account.status === "auth_needed" && !authorityInDoubt) {
          store.setAccountStatus(account.id, "ok", `bee ${bee.id}: ${ev.detail.slice(0, 200)}`);
          this.log(`account.auth_ok account=${account.id} bee=${bee.id} gen=${ev.generation}`);
        }
      }
      return;
    }
    if (ev.flag !== "resource_blocked") return;
    if (ev.action === "clear") {
      if (account.exhaustedAt != null) store.recordAccountExhaustion(account.id, null);
      return;
    }
    if (ev.quota === undefined && !isRateLimitCause(ev.detail)) return;
    // Exhaustion evidence on the account (rotation cool-off). Debounced: a
    // provider re-reports the wall on every call; one stamp a minute is plenty.
    const now = Date.now();
    if (account.exhaustedAt == null || now - account.exhaustedAt > 60_000) store.recordAccountExhaustion(account.id, now);
    if (ev.quota) {
      this.quotaRecovery?.reconcile();
      return;
    }
    if (autoswapDisabled(bee)) {
      this.log(`account.rotate bee=${bee.id} account=${account.id} skipped=autoswap_disabled`);
      return;
    }
    // Bounded: one attempt per exhaustion event (= per generation; a swap mints the next).
    const rt = store.currentRuntime(bee.id);
    const generation = rt?.generation ?? ev.generation;
    if (this.rotatedGenerations.get(bee.id) === generation) return;
    this.rotatedGenerations.set(bee.id, generation);
    if (accounts.allocationMode() === "active") {
      // The resource-blocked flag remains the durable waiting signal. A
      // fleet observation must arrive on an owner-routed explicit auto-swap;
      // a local tick cannot infer that unknown remote activity is empty.
      this.log(`account.rotate bee=${bee.id} account=${account.id} waiting=allocation_owner_required`);
      return;
    }
    const pick = accounts.admitNewWork(bee.agent, {
      operation: "swap", requestKey: `quota:${bee.id}:${generation}`, beeId: bee.id,
      sourceAccount: account.id, reconcileAfterGeneration: generation,
      excludeAccountIds: new Set([account.id]), excludeRecentlyExhausted: true, model: this.modelOfBee(bee),
    });
    if (!pick.ok) {
      this.log(`account.rotate bee=${bee.id} account=${account.id} skipped=no_candidate (${pick.message})`);
      return;
    }
    try {
      const recovery = store.listQuotaRecoveries(bee.id).find(row => row.sourceGeneration === generation && row.state === "waiting"
        && row.messageIds.length === (ev.turn?.messageIds.length ?? 0) && row.messageIds.every(id => ev.turn?.messageIds.includes(id)));
      const res = this.performSwap(bee, pick.account, "rotation", pick.receipt, pick.reservation?.id, undefined, recovery?.id);
      this.log(`account.rotate bee=${bee.id} from=${account.id} to=${pick.account.id} action=${res.action} reason=${JSON.stringify(pick.reason)}`);
    } catch (err) {
      if (pick.reservation) store.releaseAccountAdmission(pick.reservation.id);
      this.log(`account.rotate bee=${bee.id} from=${account.id} to=${pick.account.id} failed=${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private sourceQuotaRecoveryParam(params: Record<string, unknown>): { observedAt: number; window: "five_hour" | "weekly" | "other"; resetsAt: number | null; usedPercentAtObservation: number | null; usedPercentObservedAt: number | null } | undefined {
    const value = params.sourceQuotaRecovery;
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object") throw new RpcError("invalid_request", "invalid sourceQuotaRecovery");
    const source = value as Record<string, unknown>;
    if (typeof source.observedAt !== "number" || !Number.isFinite(source.observedAt) || source.observedAt <= 0 || source.observedAt > Date.now()
      || source.window !== "five_hour" && source.window !== "weekly" && source.window !== "other"
      || source.resetsAt !== null && (typeof source.resetsAt !== "number" || !Number.isFinite(source.resetsAt))) throw new RpcError("invalid_request", "invalid sourceQuotaRecovery");
    const used = source.usedPercentAtObservation;
    if (used !== undefined && used !== null && (typeof used !== "number" || !Number.isFinite(used) || used < 0)) throw new RpcError("invalid_request", "invalid source quota usage");
    const observed = source.usedPercentObservedAt;
    if (observed !== undefined && observed !== null && (typeof observed !== "number" || !Number.isFinite(observed) || observed <= 0 || observed > Date.now())) throw new RpcError("invalid_request", "invalid source quota observation time");
    return { observedAt: source.observedAt, window: source.window, resetsAt: source.resetsAt, usedPercentAtObservation: typeof used === "number" ? used : null, usedPercentObservedAt: typeof observed === "number" ? observed : null };
  }

  private quotaRetryAt(beeId: string, hint: number | null = null): number | null {
    const store = this.mustStore();
    const bee = store.getBee(beeId);
    if (!bee) return null;
    const now = Date.now();
    const times: number[] = hint !== null && hint > now ? [hint] : [];
    for (const account of store.listAccounts({ harness: bee.agent })) {
      if (account.status !== "ok" || !this.mustAccounts().readiness(account).ready) continue;
      if (this.mustAccounts().allocationMode() === "active" && account.id !== bee.account) continue;
      const limits = store.getAccountLimits(account.id);
      if (limits?.readable) {
        for (const [pct, reset] of [[limits.fiveHourPct, limits.fiveHourResetsAt], [limits.weeklyPct, limits.weeklyResetsAt], ...(isFableModel(this.modelOfBee(bee)) ? [[limits.fableWeeklyPct, limits.fableResetsAt]] : [])]) {
          if (pct !== null && pct !== undefined && pct >= 90 && reset !== null && reset !== undefined && reset > now) times.push(reset);
        }
      }
      if (account.exhaustedAt !== null) {
        for (const recovery of store.listQuotaRecoveries()) {
          if (recovery.sourceAccount !== account.id) continue;
          for (const reset of Object.values(recovery.resetHints)) if (reset !== undefined && reset > now) times.push(reset);
        }
      }
    }
    return times.length ? Math.min(...times) : null;
  }

  private admitProviderTurn(beeId: string, generation: number): boolean {
    const store = this.mustStore();
    const bee = store.getBee(beeId);
    if (!bee?.account || bee.activeMoveId || bee.activeHandoffId || !this.accounts || autoswapDisabled(bee) || bee.agent !== "claude" && bee.agent !== "codex") return true;
    const recoveries = store.listQuotaRecoveries(beeId);
    const pending = recoveries.find(row => (row.state === "waiting" || row.state === "rotating") && store.quotaRecoveryValid(row));
    if (pending) {
      if (pending.trigger !== "proactive") return pending.state === "waiting" || pending.continuationKind !== null;
      if (pending.state !== "waiting") return false;
      if (this.accounts.proactiveOwnerWaitExpired(pending.createdAt)) {
        store.cancelQuotaRecovery(pending.id, "owner_unavailable");
        return true;
      }
      if (!this.accounts.proactiveAdmissionEnabled()) {
        store.cancelQuotaRecovery(pending.id, "proactive_admission_disabled");
        return true;
      }
      const limits = store.getAccountLimits(bee.account);
      if (!limits || limits.fetchedAt <= pending.admission!.fetchedAt) return false;
      const comparison = this.accounts.proactiveTargets(bee.agent, bee.account, this.modelOfBee(bee), beeId);
      if (comparison.uncertain) return false;
      const restored = this.accounts.turnHeadroom(bee.account, this.modelOfBee(bee), beeId, 2).status === "eligible";
      if (!restored && comparison.accountIds.size > 0) return false;
      store.cancelQuotaRecovery(pending.id, restored ? "completion_headroom_restored" : "relative_headroom_unavailable");
      return true;
    }
    if (!this.accounts.proactiveAdmissionEnabled()) return true;
    const accepted = recoveries.some(row => row.state === "resumed" && row.successorGeneration === generation);
    if (accepted && !store.hasDeliveredMail(beeId, generation)) return true;
    const headroom = this.accounts.turnHeadroom(bee.account, this.modelOfBee(bee), beeId);
    if (headroom.status !== "protected") return true;
    const comparison = this.accounts.proactiveTargets(bee.agent, bee.account, this.modelOfBee(bee), beeId);
    if (!comparison.uncertain && comparison.accountIds.size === 0) return true;
    const fetchedAt = store.getAccountLimits(bee.account)!.fetchedAt;
    const recovery = store.requireCompletionHeadroom(beeId, generation, { fetchedAt, maxProjectedPercent: headroom.maxProjectedPercent!, candidateAccountIds: comparison.uncertain ? null : [...comparison.accountIds].sort() }, headroom.retryAt);
    if (!recovery) return true;
    if (this.accounts.allocationMode() === "active") store.waitQuotaRecovery(recovery.id, headroom.retryAt, "allocation_owner_required");
    this.quotaRecovery?.reconcile();
    return false;
  }

  private async recoverQuota(id: string): Promise<void> {
    const store = this.mustStore();
    const accounts = this.mustAccounts();
    let row = store.getQuotaRecovery(id);
    if (!row || row.state !== "waiting" || !store.quotaRecoveryValid(row)) return;
    let bee = store.getBee(row.beeId)!;
    if (row.trigger === "proactive" && accounts.proactiveOwnerWaitExpired(row.createdAt)) {
      store.cancelQuotaRecovery(id, "owner_unavailable");
      this.requestTick();
      return;
    }
    if (row.trigger === "proactive" && !accounts.proactiveAdmissionEnabled()) {
      store.cancelQuotaRecovery(id, "proactive_admission_disabled");
      this.requestTick();
      return;
    }
    if (autoswapDisabled(bee)) {
      if (row.reason !== "autoswap_disabled") this.log(`account.rotate bee=${bee.id} account=${bee.account} skipped=autoswap_disabled`);
      store.waitQuotaRecovery(id, null, "autoswap_disabled");
      return;
    }
    if (accounts.allocationMode() === "active") {
      store.waitQuotaRecovery(id, row.retryAt !== null && row.retryAt > Date.now() ? row.retryAt : null, row.reason === "account_wait" && row.reasonDetail !== undefined || row.reason === "account_unavailable" ? row.reason : "allocation_owner_required", row.reasonDetail ?? null);
      try {
        const refreshed = await accounts.ensureFreshAdmissionLimits(bee.agent, { proactiveRefresh: row.trigger === "proactive", onlyAccountIds: row.trigger === "proactive" ? undefined : bee.account ? new Set([bee.account]) : undefined, model: this.modelOfBee(bee), minimumObservedAt: row.createdAt, quotaResetAt: row.quota?.resetsAt ?? row.resetHints.other ?? undefined }, true);
        if (!this.stopping) {
          store.observeQuotaRecoveryLimits(id, isFableModel(this.modelOfBee(bee)));
          if (row.trigger === "proactive" && bee.account) {
            const comparison = accounts.proactiveTargets(bee.agent, bee.account, this.modelOfBee(bee), bee.id);
            store.setProactiveCandidates(id, comparison.uncertain ? null : [...comparison.accountIds]);
            if (comparison.uncertain && !refreshed) return;
            if (comparison.uncertain || comparison.accountIds.size === 0) store.cancelQuotaRecovery(id, comparison.uncertain ? "relative_refresh_unavailable" : "relative_headroom_unavailable");
            this.requestTick();
          }
        }
      } catch (error) {
        this.log(`quota.probe recovery=${id} failed=${error instanceof Error ? error.message : String(error)}`);
        if (row.trigger === "proactive") { store.cancelQuotaRecovery(id, "relative_refresh_unavailable"); this.requestTick(); }
      }
      return;
    }
    try {
      const refreshed = await accounts.ensureFreshAdmissionLimits(bee.agent, { proactiveRefresh: row.trigger === "proactive", model: this.modelOfBee(bee), minimumObservedAt: row.createdAt, quotaResetAt: row.quota?.resetsAt ?? row.resetHints.other ?? undefined }, true);
      if (this.stopping) return;
      store.observeQuotaRecoveryLimits(id, isFableModel(this.modelOfBee(bee)));
      row = store.getQuotaRecovery(id);
      if (!row || row.state !== "waiting" || !store.quotaRecoveryValid(row)) return;
      bee = store.getBee(row.beeId)!;
      if (autoswapDisabled(bee) || accounts.allocationMode() === "active") return;
      if (row.trigger === "proactive" && bee.account && (store.getAccountLimits(bee.account)?.fetchedAt ?? 0) > row.admission!.fetchedAt
        && accounts.turnHeadroom(bee.account, this.modelOfBee(bee), bee.id, 2).status === "eligible") {
        store.cancelQuotaRecovery(id, "completion_headroom_restored");
        this.requestTick();
        return;
      }
      const comparison = row.admission ? accounts.proactiveTargets(bee.agent, row.sourceAccount!, this.modelOfBee(bee), bee.id) : undefined;
      if (comparison) store.setProactiveCandidates(id, comparison.uncertain ? null : [...comparison.accountIds]);
      if (comparison?.uncertain) {
        if (!refreshed) return;
        store.cancelQuotaRecovery(id, "relative_refresh_unavailable");
        this.requestTick();
        return;
      }
      const targets = comparison?.accountIds;
      if (targets?.size === 0 && row.trigger === "proactive") {
        store.cancelQuotaRecovery(id, "relative_headroom_unavailable");
        this.requestTick();
        return;
      }
      if (targets?.size === 0) {
        const detail = accounts.recoveryWaitDetail(bee.agent);
        store.waitQuotaRecovery(id, this.quotaRetryAt(bee.id, row.retryAt), detail === null ? "account_wait" : "account_unavailable", detail);
        return;
      }
      const result = this.rpcSwapAccount({ beeId: bee.id, account: "auto", quotaRecoveryId: id, ...(targets ? { onlyAccountIds: [...targets] } : {}), idempotencyKey: `quota:${id}:${row.attempt}` });
      this.log(`quota.rotate recovery=${id} to=${result.to}`);
      this.requestTick();
    } catch (error) {
      row = store.getQuotaRecovery(id);
      if (!row || row.state !== "waiting") return;
      if (row.trigger === "proactive") {
        store.cancelQuotaRecovery(id, error instanceof RpcError ? "relative_swap_refused" : "relative_refresh_unavailable");
        this.requestTick();
        return;
      }
      const data = error instanceof RpcError ? error.details : undefined;
      const allocation = data?.allocation as { retryAt?: number | null } | undefined;
      const retry = typeof data?.retryAt === "number" ? data.retryAt : allocation?.retryAt ?? null;
      const code = error instanceof RpcError || error instanceof LeaseRefusal ? error.code : null;
      const detail = code === "credential_login_required" || code === "account_auth_needed" || code === "account_credential_missing" || code === "account_credential_invalid" || code === "account_credential_expired" || code === "credential_file_damaged"
        ? "credential_login_required" : code === "account_paused" ? "paused" : code === "account_lease_revoked" || code === "lease_unavailable" || code === "lease_unsupported"
          ? "lease_needs_operator" : code === "account_wait" ? null : code === "account_unavailable" ? accounts.recoveryWaitDetail(bee.agent) : "unavailable";
      store.waitQuotaRecovery(id, this.quotaRetryAt(row.beeId, retry), detail === null ? "account_wait" : "account_unavailable", detail);
      this.log(`account.rotate bee=${row.beeId} account=${row.sourceAccount} skipped=${error instanceof RpcError && ["account_wait", "account_unavailable", "account_auth_needed"].includes(error.code) ? "no_candidate" : "swap_refused"} recovery=${id} (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  private enforceWeeklyCeilings(): void {
    const store = this.store;
    if (!store || !this.accounts) return;
    this.sendWeeklyCeilingNotes();
    const now = Date.now();
    if (now - this.lastWeeklyCeilingSweepAt < WEEKLY_CEILING_SWEEP_MS) return;
    this.lastWeeklyCeilingSweepAt = now;
    for (const account of store.listAccounts()) {
      if (this.accounts.weeklyCeilingBreaches(account).length === 0) continue;
      for (const bee of store.beesOnAccount(account.id)) {
        if (bee.lifecycle !== "active" || bee.activeMoveId != null || bee.activeHandoffId != null) continue;
        if (store.currentRuntime(bee.id)?.state !== "idle") continue;
        this.moveOffWeeklyCeiling(bee, account);
      }
    }
  }

  private moveOffWeeklyCeiling(bee: BeeRow, account: AccountRow): boolean {
    const accounts = this.accounts;
    if (!accounts || account.weeklyCeiling == null) return false;
    const model = this.modelOfBee(bee);
    const breach = accounts.weeklyCeilingBreach(account, model);
    if (!breach) return false;
    const now = Date.now();
    const previous = this.weeklyCeilingMoves.get(bee.id);
    if (previous?.account === account.id && now - previous.at < WEEKLY_CEILING_RETRY_MS) return false;
    this.weeklyCeilingMoves.set(bee.id, { account: account.id, at: now });
    const why = describeWeeklyCeilingBreach(account.id, breach);
    if (autoswapDisabled(bee)) {
      this.log(`account.ceiling bee=${bee.id} account=${account.id} skipped=autoswap_disabled — ${why}`);
      return false;
    }
    const pick = accounts.pick(bee.agent, { excludeAccountIds: new Set([account.id]), model });
    if (!pick.ok) {
      this.log(`account.ceiling bee=${bee.id} account=${account.id} skipped=no_candidate (${pick.message}) — ${why}`);
      return false;
    }
    const generation = this.mustStore().currentRuntime(bee.id)?.generation ?? 0;
    try {
      const res = this.performSwap(bee, pick.account, "ceiling");
      this.log(`account.ceiling bee=${bee.id} from=${account.id} to=${pick.account.id} action=${res.action} — ${why}`);
      if (res.action === "stop_then_revive") {
        this.weeklyCeilingNotes.set(bee.id, { afterGeneration: generation, body: weeklyCeilingMoveNote(account.id, pick.account.id, why) });
      }
      return true;
    } catch (err) {
      this.log(`account.ceiling bee=${bee.id} from=${account.id} to=${pick.account.id} failed=${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private sendWeeklyCeilingNotes(): void {
    const store = this.mustStore();
    for (const [beeId, note] of this.weeklyCeilingNotes) {
      const runtime = store.currentRuntime(beeId);
      if (!store.getBee(beeId)) {
        this.weeklyCeilingNotes.delete(beeId);
        continue;
      }
      if (!runtime || runtime.generation <= note.afterGeneration || runtime.state === "stopped") continue;
      this.weeklyCeilingNotes.delete(beeId);
      store.send(beeId, note.body, { sender: "hive", senderKind: "automation" });
    }
  }

  /** The bee's effective model (its args over the agent defaults), for the Fable tier. */
  private modelOfBee(bee: BeeRow): string | undefined {
    const spec = this.cfg.agents[bee.agent];
    const all = [...(spec?.defaultArgs ?? []), ...(bee.args ?? [])];
    let model: string | undefined;
    for (let i = 0; i < all.length; i += 1) {
      const a = all[i] as string;
      if (a === "--model" || a === "-m") model = all[i + 1];
      else if (a.startsWith("--model=")) model = a.slice("--model=".length);
    }
    return model;
  }

  // -------------------------------------------------------------------------
  // WP6a — templates, packages (spec 06 §1.4.1)
  // -------------------------------------------------------------------------

  private scopeParam(params: Record<string, unknown>): Scope | undefined {
    const scope = params.scope;
    if (scope === undefined || scope === null) return undefined;
    if (scope !== "personal" && scope !== "team" && scope !== "repo") {
      throw new RpcError("invalid_request", "scope must be personal|team|repo");
    }
    return scope;
  }

  private importOptions(params: Record<string, unknown>): { source: RowSource; scope?: Scope; label?: string } {
    const source = params.source;
    if (source !== undefined && typeof source !== "string") {
      throw new RpcError("invalid_request", "source must be a string when given");
    }
    return {
      source: source !== undefined && source.length > 0 ? (`package:${source.replace(/^package:/, "")}` as RowSource) : "package:rpc",
      scope: this.scopeParam(params),
      label: typeof params.label === "string" ? params.label : undefined,
    };
  }

  private requireTemplate(params: Record<string, unknown>) {
    const store = this.mustStore();
    const id = this.param(params, "id");
    const template = store.getTemplate(id);
    if (!template) throw new RpcError("template_not_found", `template not found: ${id}`);
    return template;
  }

  private rpcTemplateList(params: Record<string, unknown>): TemplateListResult {
    const scope = this.scopeParam(params);
    return { templates: this.mustStore().listTemplates(scope ? { scope } : {}) };
  }

  private rpcTemplatePut(params: Record<string, unknown>): TemplatePutResult {
    const store = this.mustStore();
    const res = store.putTemplate({
      id: typeof params.id === "string" && params.id.length > 0 ? params.id : undefined,
      fields: params.fields,
      defaultSource: "api",
    });
    return { template: res.template, outcome: res.outcome };
  }

  /**
   * WP7 (spec 07 B4): import active old-world bees from the frozen store.
   * The daemon is the sole writer (contract §3.5), so the import runs here;
   * the preflight probes real pids/tmux (A2). Refusals come back as a report
   * (`applied:false`, `refusal`), not as RPC errors — the CLI prints them.
   */
  private rpcImportFromFrozen(params: Record<string, unknown>): ImportFromFrozenResult {
    const store = this.mustStore();
    const root = typeof params.root === "string" && params.root.length > 0 ? params.root : join(homedir(), ".hive");
    const dryRun = params.dryRun === true;
    const force = params.force === true;
    const report = importFromFrozen(store, root, {
      dryRun,
      force,
      knownAgents: Object.keys(this.cfg.agents),
      probes: realPreflightProbes(),
    });
    this.log(
      `import.fromFrozen root=${root} dryRun=${dryRun} force=${force} applied=${report.applied} ` +
        `import=${report.plan.counts.import} skip=${report.plan.counts.skip} live=${report.preflight.live.length}` +
        (report.refusal ? ` refusal=${JSON.stringify(report.refusal.split("\n")[0])}` : ""),
    );
    return report;
  }

  private rpcImportLocalConfig(params: Record<string, unknown>): ImportLocalConfigResult {
    const store = this.mustStore();
    // The local package source dir: ~/.hive by default (spec 06 §1.4.1 — the
    // OLD store layout is the human-editable form). Tests always pass `dir`.
    const dir = typeof params.dir === "string" && params.dir.length > 0 ? params.dir : join(homedir(), ".hive");
    return importLocalConfig(store, dir, { scope: this.scopeParam(params) });
  }
}

export function readVersionStamp(path: string, stamps: string[]): string | null {
  if (stamps.length === 0) return null;
  try {
    const line = readFileSync(join(dirname(realpathSync(path)), stamps[0]!), "utf8").split("\n").map((l) => l.trim()).find((l) => l.length > 0);
    return line?.match(/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}/u)?.[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Locate a claude transcript in a config dir: the exact project key first,
 * then any project dir (the key derivation drifted across CLI versions —
 * realpath vs raw path — and a conversation is only ever one file).
 */
function findClaudeTranscript(home: string, projectKey: string, seed: string): { file: string; dir: string | null } | null {
  const projects = join(home, "projects");
  const candidates = [join(projects, projectKey)];
  if (existsSync(projects)) {
    try {
      for (const name of readdirSync(projects)) {
        const dir = join(projects, name);
        if (dir !== candidates[0]) candidates.push(dir);
      }
    } catch {
      // unreadable projects dir — the exact candidate still gets its chance
    }
  }
  for (const dir of candidates) {
    const file = join(dir, `${seed}.jsonl`);
    if (!existsSync(file)) continue;
    const sibling = join(dir, seed);
    return { file, dir: existsSync(sibling) ? sibling : null };
  }
  return null;
}
