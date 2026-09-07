// Design-only TypeScript sketch. These signatures are intentionally not compiled.
// Existing public factories and dependencies keep their current signatures.

import type { BeeRow, CoreStore, MessageRow } from "@honeybee/core-v2";
import type {
  AutoTitleBookkeeping,
  AutoTitleDeps,
  AutoTitleOutcome,
} from "<existing v2/daemon/src/autoTitle.ts>";
import type { ResolvedNamingConfig } from "<existing v2/daemon/src/config.ts>";
import type { TitleContext } from "<existing v2/daemon/src/naming.ts>";

// Core-owned, process-local evidence. `revision` is opaque identity and is
// comparable only inside the CoreStore instance that returned it.
export type CommittedMailboxContentsVersion = Readonly<{
  kind: "committed";
  revision: symbol;
}>;

export type MailboxContentsVersion =
  | CommittedMailboxContentsVersion
  | Readonly<{ kind: "transaction_open" }>;

// Added to CoreStore. It never queries or exposes bodies.
export interface MailboxContentsVersionRead {
  mailboxContentsVersion(beeId: string): MailboxContentsVersion;
}

type PendingMailboxVersionEffect = "present_changed" | "deleted";

// Private store.ts state, not a new public service or generic commit hook.
type MailboxVersionState = {
  readonly byBee: Map<string, CommittedMailboxContentsVersion>;
  readonly initial: CommittedMailboxContentsVersion;
  staged: Map<string, PendingMailboxVersionEffect> | null;
};

function stageMailboxVersionEffect(
  state: MailboxVersionState,
  beeId: string,
  effect: PendingMailboxVersionEffect,
): void {
  // TODO: require an open outer transaction and lazily create `staged`.
  // Later operations for the same id replace earlier ones, so delete then
  // recreate publishes a present token and create then delete removes it.
  throw new Error("not implemented");
}

function publishMailboxVersionEffectsAfterCommit(state: MailboxVersionState): void {
  // TODO: create one new committed revision identity for this transaction.
  // Assign it to every present_changed id, delete every deleted id, then clear
  // staged. This runs only after SQLite COMMIT succeeds and before tx returns.
  throw new Error("not implemented");
}

function discardMailboxVersionEffectsAfterRollback(state: MailboxVersionState): void {
  // TODO: clear staged without changing any committed token.
  throw new Error("not implemented");
}

// The retained suffix is structurally capped at three values.
export type RecentClampedUserMessages =
  | readonly []
  | readonly [string]
  | readonly [string, string]
  | readonly [string, string, string];

export type AutoTitleMailboxSummary = Readonly<{
  userTurns: number;
  firstUserMessage: string | null;
  recentUserMessages: RecentClampedUserMessages;
  initialTaskMessageId: number | null;
}>;

// `initialTask` can be large, so only a fresh scan or in-flight generation
// holds it. The cross-tick cache never does.
export type FreshAutoTitleMailboxAnalysis = Readonly<{
  summary: AutoTitleMailboxSummary;
  initialTask: string;
}>;

export type CachedAutoTitleMailboxSummary = Readonly<{
  version: CommittedMailboxContentsVersion;
  summary: AutoTitleMailboxSummary;
}>;

export function analyzeAutoTitleMailbox(
  messages: readonly MessageRow[],
): FreshAutoTitleMailboxAnalysis {
  // TODO: one ordered pass using the existing strip, clamp, and thin-opener
  // functions. Sender, delivery, urgency, and priority remain ignored.
  throw new Error("not implemented");
}

export function contextSignatureFromSummary(
  bee: BeeRow,
  summary: Pick<AutoTitleMailboxSummary, "userTurns" | "firstUserMessage">,
): string {
  // TODO: preserve [lifecycle, count, firstText].join("\0") byte for byte.
  throw new Error("not implemented");
}

export type AutoTitleDecision =
  | Readonly<{ action: "skip"; reason: string }>
  | Readonly<{ action: "defer"; reason: string }>
  | Readonly<{ action: "generate" }>;

export function autoTitleDecisionFromSummary(
  bee: BeeRow,
  summary: Pick<AutoTitleMailboxSummary, "userTurns" | "firstUserMessage">,
  bookkeeping: AutoTitleBookkeeping | undefined,
  now: number,
): AutoTitleDecision {
  // TODO: use the existing retry helper. Zero turns defers. Exactly one thin
  // first message defers. All other eligible summaries generate.
  throw new Error("not implemented");
}

// Existing exported APIs remain. Their implementations delegate to the same
// summary policy, so there is one title-decision definition.
export function contextSignature(bee: BeeRow, userMessages: readonly string[]): string {
  throw new Error("not implemented");
}

export function autoTitleDecision(
  bee: BeeRow,
  userMessages: readonly string[],
  bookkeeping: AutoTitleBookkeeping | undefined,
  now: number,
): AutoTitleDecision {
  throw new Error("not implemented");
}

// Private capability passed only by createStoreAutoTitleDispatcher. The
// general factory receives null, so custom dependencies retain full reads.
type StoreMailboxReuse = Readonly<{
  version(beeId: string): MailboxContentsVersion;
  getMessage(messageId: number): MessageRow | null;
}>;

type MailboxInspection =
  | Readonly<{
      kind: "cached";
      entry: CachedAutoTitleMailboxSummary;
    }>
  | Readonly<{
      kind: "fresh_committed";
      version: CommittedMailboxContentsVersion;
      analysis: FreshAutoTitleMailboxAnalysis;
    }>
  | Readonly<{
      kind: "fresh_uncacheable";
      analysis: FreshAutoTitleMailboxAnalysis;
    }>;

function inspectMailbox(
  beeId: string,
  deps: Pick<AutoTitleDeps, "listMessages">,
  reuse: StoreMailboxReuse | null,
  cache: ReadonlyMap<string, CachedAutoTitleMailboxSummary>,
  allowReuse: boolean,
): MailboxInspection {
  // TODO: never consult cache when allowReuse is false or version reports an
  // open transaction. A committed miss performs listMessages and analysis.
  throw new Error("not implemented");
}

export type LaunchContextResolution =
  | Readonly<{ kind: "ready"; context: TitleContext }>
  | Readonly<{ kind: "refresh_full" }>;

function launchContextFromCachedSummary(
  beeId: string,
  entry: CachedAutoTitleMailboxSummary,
  reuse: StoreMailboxReuse,
): LaunchContextResolution {
  // TODO: verify the same committed token, fetch only initialTaskMessageId when
  // non-null, verify bee ownership and token again, strip its body, and copy
  // recentUserMessages into a new mutable array for TitleContext. Any mismatch
  // returns refresh_full; the caller reruns signature and decision from a full
  // ordered read before it may launch.
  throw new Error("not implemented");
}

export type AutoTitleDispatcher = (bees?: BeeRow[]) => Promise<AutoTitleOutcome[]>;

function createAutoTitleDispatcherImpl(
  deps: AutoTitleDeps,
  reuse: StoreMailboxReuse | null,
): AutoTitleDispatcher {
  // TODO: keep the existing phase order, roster order, eight-probe placement,
  // one-launch break, global slot, retry bookkeeping, and watchdog. Enable
  // reuse only when `bees === undefined` and reuse is non-null. Prune cache
  // against that invocation's complete fresh roster.
  throw new Error("not implemented");
}

export function createAutoTitleDispatcher(deps: AutoTitleDeps): AutoTitleDispatcher {
  // TODO: return createAutoTitleDispatcherImpl(deps, null).
  throw new Error("not implemented");
}

export function createStoreAutoTitleDispatcher(
  store: CoreStore,
  options: {
    naming: () => ResolvedNamingConfig;
    statePath: string;
    now?: () => number;
    log?: (op: string) => void;
    generate?: (context: TitleContext) => Promise<string>;
  },
): AutoTitleDispatcher {
  // TODO: keep the existing deps and sidecar format. Pass only store.version
  // and store.getMessage as the private reuse capability.
  throw new Error("not implemented");
}
