import type {RuntimeIdentityRead} from "../../core/src/runtimeProcessIdentity.ts";
/**
 * tmux-driver test helpers. Every rig runs its OWN tmux server on a private
 * socket inside a fresh mkdtemp dir — the ambient tmux server (live bees!)
 * is never touched; teardown kills only the pinned private server.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scaledMs } from "../../core/tests/timeScale.ts";
import type { DriverObservation } from "../../harness/src/driver.ts";
import { TmuxDriver, type ObservationSpec, type TmuxSpawnSpec } from "../src/driver.ts";
import { TmuxServer } from "../src/tmux.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const AGENT_PATH = join(here, "..", "test-agent", "agent.mjs");

export type StubStyle = "hooks" | "notify" | "transcript" | "silent";

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The per-style observation spec — mirrors the harness each style models. */
export function observationFor(style: StubStyle, transcriptDir: string): ObservationSpec {
  const quiesceMs = 80;
  const deliveryGraceMs = 800;
  switch (style) {
    case "hooks": // claude-shaped: hook events + claude transcript baseline
      return {
        transcript: { locator: { dir: transcriptDir, match: /\.jsonl$/ }, parser: "claude" },
        quiesceMs,
        deliveryGraceMs,
      };
    case "notify": // codex-shaped: notify events + codex rollout baseline
      return {
        transcript: { locator: { dir: transcriptDir, match: /^rollout-.*\.jsonl$/ }, parser: "codex" },
        quiesceMs,
        deliveryGraceMs,
      };
    case "transcript": // grok/opencode-shaped: transcript file ONLY
      return {
        transcript: { locator: { dir: transcriptDir, match: /chat_history\.jsonl$/, depth: 2 }, parser: "grok" },
        quiesceMs,
        deliveryGraceMs,
      };
    case "silent": // no files at all: pane-content fallback
      return { paneFallback: true, quiesceMs, deliveryGraceMs };
  }
}

export interface TmuxRig {
  dir: string;
  socketPath: string;
  driver: TmuxDriver;
  /** Per-bee style + extra env + delivery mode (set before start()). */
  configure: (
    beeId: string,
    style: StubStyle,
    env?: Record<string, string>,
    deliveryMode?: "paste" | "type",
  ) => void;
  transcriptDirOf: (beeId: string) => string;
  makeSiblingDriver: () => TmuxDriver;
  cleanup: () => void;
}

export function makeRig(options: {runtimeIdentity?: import("../../core/src/runtimeProcessIdentity.ts").RuntimeIdentityHooks} = {}): TmuxRig {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "hbtmx-")));
  const socketPath = join(dir, "tmux.sock");
  const styles = new Map<
    string,
    { style: StubStyle; env: Record<string, string>; deliveryMode?: "paste" | "type" }
  >();
  const transcriptDirOf = (beeId: string): string => join(dir, "tx", beeId);
  const resolve = (beeId: string): TmuxSpawnSpec => {
    const cfg = styles.get(beeId) ?? { style: "transcript" as StubStyle, env: {} };
    return {
      command: process.execPath,
      args: [AGENT_PATH],
      cwd: dir,
      env: {
        TMUX_STUB_STYLE: cfg.style,
        TMUX_STUB_TRANSCRIPT_DIR: transcriptDirOf(beeId),
        TMUX_STUB_TURN_MS: "20",
        ...cfg.env,
      },
      ...(cfg.deliveryMode ? { deliveryMode: cfg.deliveryMode } : {}),
      observation: observationFor(cfg.style, transcriptDirOf(beeId)),
    };
  };
  const bindings = new Map<string, RuntimeIdentityRead>();
  const makeDriver = (): TmuxDriver =>
    new TmuxDriver({
      runtimeIdentity: options.runtimeIdentity ?? {read: (beeId, generation) => bindings.get(`${beeId}:${generation}`) ?? {kind: "legacy"}, bindLegacy: () => false},
      socketPath,
      eventsDir: join(dir, "events"),
      resolve,
      stopKillGraceMs: 400,
      allowKillServer: true,
    });
  const driver = makeDriver();
  return {
    dir,
    socketPath,
    driver,
    configure: (beeId, style, env = {}, deliveryMode) =>
      styles.set(beeId, { style, env, ...(deliveryMode ? { deliveryMode } : {}) }),
    transcriptDirOf,
    makeSiblingDriver: () => {
      for (const row of driver.snapshotLive()) {
        const proc = driver.procOf(row.beeId, row.generation);
        if (proc?.processIdentity) bindings.set(`${row.beeId}:${row.generation}`, {kind: "bound", identity: proc.processIdentity, pidStartedAt: proc.pidStartedAt});
      }
      return makeDriver();
    },
    cleanup: () => {
      driver.disposeAll();
      try {
        new TmuxServer({ socketPath, allowKillServer: true }).killServer();
      } catch {
        // Server already gone.
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function drainUntil(
  driver: TmuxDriver,
  pred: (events: DriverObservation[]) => boolean,
  timeoutMs = scaledMs(6000),
): Promise<DriverObservation[]> {
  const acc: DriverObservation[] = [];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    acc.push(...driver.observe());
    if (pred(acc)) return acc;
    if (Date.now() > deadline) {
      throw new Error(`drainUntil timeout; saw: ${JSON.stringify(acc)}; snapshot: ${driver.debugSnapshot()}`);
    }
    await sleep(8);
  }
}

export function kinds(events: DriverObservation[]): string[] {
  return events.map((e) => e.kind);
}

/**
 * Pump observe() for `ms`, collecting whatever drains. Models the daemon
 * ticking through a runtime's boot settling (transcript binding, boot
 * output) before the first delivery — the shape real delivery loops have.
 */
export async function settle(driver: TmuxDriver, ms: number): Promise<DriverObservation[]> {
  const acc: DriverObservation[] = [];
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    acc.push(...driver.observe());
    await sleep(10);
  }
  return acc;
}
