import assert from "node:assert/strict";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { probeCow } from "../src/cow.ts";
import { readCurrentGitImage, refreshGitImage, tryMaterializeGitImage } from "../src/gitImage.ts";
import { cellPaths } from "../src/layout.ts";
import { newLedger, readLedger, writeLedger, type LedgerOperation } from "../src/ledger.ts";
import { provisionCell, type ProvisionRequest } from "../src/provision.ts";
import { makeRig } from "./helpers.ts";

const WORKER_URL = new URL("../src/provisionWorker.ts", import.meta.url);

interface ProvisionWorkerData {
  cellsRoot: string;
  request: ProvisionRequest;
  opId: string;
  disableCow: boolean;
  useGitImages: boolean;
  gitImagesRoot: string;
}

type ProvisionWorkerResult =
  | { ok: true }
  | { ok: false; error: string };

interface WorkerRun {
  worker: Worker;
  result: Promise<ProvisionWorkerResult>;
  exit: Promise<number>;
}

function request(
  rig: ReturnType<typeof makeRig>,
  beeId: string,
  cellId: string,
  originRepo = rig.origin.repo,
): ProvisionRequest {
  return {
    beeId,
    originRepo,
    sha: rig.origin.sha,
    wrapper: beeId,
    repoName: "fixture",
    cellId,
  };
}

function parseWorkerResult(value: unknown): ProvisionWorkerResult {
  if (value == null || typeof value !== "object" || !("ok" in value) || typeof value.ok !== "boolean") {
    throw new Error(`unexpected provision worker result: ${JSON.stringify(value)}`);
  }
  if (value.ok) return { ok: true };
  if (!("error" in value) || typeof value.error !== "string") {
    throw new Error(`provision worker failure lacks an error: ${JSON.stringify(value)}`);
  }
  return { ok: false, error: value.error };
}

function runWorker(data: ProvisionWorkerData, tracePath?: string): WorkerRun {
  const worker = new Worker(WORKER_URL, {
    execArgv: [],
    workerData: data,
    ...(tracePath == null
      ? {}
      : { env: { ...process.env, GIT_TRACE2_EVENT: tracePath } }),
  });
  const result = new Promise<ProvisionWorkerResult>((resolve, reject) => {
    worker.once("message", (value: unknown) => {
      try {
        resolve(parseWorkerResult(value));
      } catch (error) {
        reject(error);
      }
    });
    worker.once("error", reject);
  });
  const exit = new Promise<number>((resolve) => worker.once("exit", resolve));
  return { worker, result, exit };
}

async function within<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}

async function exitsWithin(exit: Promise<number>, timeoutMs: number): Promise<boolean> {
  return await Promise.race([
    exit.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

function gitCommands(tracePath: string): string[][] {
  if (!existsSync(tracePath)) return [];
  const commands: string[][] = [];
  for (const line of readFileSync(tracePath, "utf8").split("\n")) {
    if (line.length === 0) continue;
    const event: unknown = JSON.parse(line);
    if (event == null || typeof event !== "object" || !("event" in event) || event.event !== "start") continue;
    if (!("argv" in event)) continue;
    const argv = event.argv;
    if (!Array.isArray(argv) || !argv.every((arg: unknown): arg is string => typeof arg === "string")) continue;
    commands.push(argv);
  }
  return commands;
}

test("provision-worker: a fresh image hit exits after ready without maintenance Git children", async (t) => {
  const rig = makeRig();
  let run: WorkerRun | null = null;
  try {
    if (!probeCow(join(rig.origin.repo, ".git"), rig.cellsRoot)) {
      t.skip("filesystem has no local CoW support");
      return;
    }
    const imagesRoot = join(rig.root, "images");
    const tracePath = join(rig.root, "fresh-image-hit.trace.jsonl");
    assert.equal(refreshGitImage(imagesRoot, rig.origin.repo, rig.origin.sha).status, "refreshed");

    run = runWorker({
      cellsRoot: rig.cellsRoot,
      request: request(rig, "bee-fresh", "fresh"),
      opId: "start-bee-fresh-g1",
      disableCow: false,
      useGitImages: true,
      gitImagesRoot: imagesRoot,
    }, tracePath);

    assert.deepEqual(await within(run.result, 15_000, "fresh image result"), { ok: true });
    const commandsAtReady = gitCommands(tracePath);
    assert.equal(commandsAtReady.length, 8, "fresh image placement must not run the four-command refresh");
    assert.equal(await within(run.exit, 2_000, "fresh image worker exit"), 0);
    assert.deepEqual(gitCommands(tracePath), commandsAtReady, "ready must be the final Git boundary");

    const ledger = readLedger(cellPaths(rig.cellsRoot, "bee-fresh", "fixture", "fresh").ledgerPath);
    assert.equal(ledger?.copy_mode, "image-cow");
  } finally {
    if (run != null) await run.worker.terminate();
    rig.cleanup();
  }
});

test("provision-worker: a replayed ledger rebuilds a missing image after maintenance starts", async (t) => {
  const rig = makeRig();
  let run: WorkerRun | null = null;
  try {
    if (!probeCow(join(rig.origin.repo, ".git"), rig.cellsRoot)) {
      t.skip("filesystem has no local CoW support");
      return;
    }
    const imagesRoot = join(rig.root, "images");
    const expiredImagesRoot = join(rig.root, "expired-images");
    const replayRequest = request(rig, "bee-replay", "replay");
    assert.equal(refreshGitImage(imagesRoot, rig.origin.repo, rig.origin.sha).status, "refreshed");
    const first = provisionCell(rig.cellsRoot, replayRequest, "start-bee-replay-g1", {
      disableCow: false,
      useGitImages: true,
      gitImagesRoot: imagesRoot,
    });
    assert.equal(first.replayed, false);
    assert.equal(first.copyMode, "image-cow");
    renameSync(imagesRoot, expiredImagesRoot);
    assert.equal(readCurrentGitImage(imagesRoot, rig.origin.repo), null);

    run = runWorker({
      cellsRoot: rig.cellsRoot,
      request: replayRequest,
      opId: "start-bee-replay-g1",
      disableCow: false,
      useGitImages: true,
      gitImagesRoot: imagesRoot,
    });

    assert.deepEqual(await within(run.result, 5_000, "replayed result"), { ok: true });
    assert.equal(readCurrentGitImage(imagesRoot, rig.origin.repo), null);
    assert.equal(await exitsWithin(run.exit, 100), false, "replayed work must wait for maintenance");
    run.worker.postMessage({ kind: "refresh_git_image" });
    assert.equal(await within(run.exit, 15_000, "replayed maintenance"), 0);
    assert.equal(readCurrentGitImage(imagesRoot, rig.origin.repo)?.anchorSha, rig.origin.sha);
  } finally {
    if (run != null) await run.worker.terminate();
    rig.cleanup();
  }
});

test("provision-worker: an incomplete image operation keeps maintenance after replay resumes", async (t) => {
  const rig = makeRig();
  let run: WorkerRun | null = null;
  try {
    if (!probeCow(join(rig.origin.repo, ".git"), rig.cellsRoot)) {
      t.skip("filesystem has no local CoW support");
      return;
    }
    const imagesRoot = join(rig.root, "images");
    const expiredImagesRoot = join(rig.root, "expired-resume-images");
    const resumedRequest = request(rig, "bee-resumed", "resumed");
    const opId = "start-bee-resumed-g1";
    const paths = cellPaths(rig.cellsRoot, resumedRequest.wrapper, resumedRequest.repoName, resumedRequest.cellId);
    assert.equal(refreshGitImage(imagesRoot, rig.origin.repo, rig.origin.sha).status, "refreshed");

    const ledger = newLedger({
      beeId: resumedRequest.beeId,
      origin: resumedRequest.originRepo,
      sha: resumedRequest.sha,
      wrapper: resumedRequest.wrapper,
      spaceName: paths.spaceName,
      now: 1,
    });
    const operation: LedgerOperation = { startedAt: 2, steps: {} };
    ledger.operations[opId] = operation;
    writeLedger(paths.ledgerPath, ledger);
    const placement = tryMaterializeGitImage(
      imagesRoot,
      resumedRequest.originRepo,
      resumedRequest.sha,
      paths.spaceDir,
      paths.boxDir,
      paths.emptyHooksDir,
    );
    assert.ok(placement);
    ledger.copy_mode = "image-cow";
    operation.steps.git_placed = { mode: "image-cow", at: 3, image: placement };
    writeLedger(paths.ledgerPath, ledger);

    run = runWorker({
      cellsRoot: rig.cellsRoot,
      request: resumedRequest,
      opId,
      disableCow: false,
      useGitImages: true,
      gitImagesRoot: imagesRoot,
    });

    assert.deepEqual(await within(run.result, 5_000, "incomplete replay result"), { ok: true });
    const completed = readLedger(paths.ledgerPath)?.operations[opId];
    assert.ok(completed?.completedAt, "the incomplete operation must finish");
    renameSync(imagesRoot, expiredImagesRoot);
    assert.equal(readCurrentGitImage(imagesRoot, rig.origin.repo), null);
    assert.equal(await exitsWithin(run.exit, 100), false, "a resumed operation must wait for maintenance");
    run.worker.postMessage({ kind: "refresh_git_image" });
    assert.equal(await within(run.exit, 15_000, "incomplete replay maintenance"), 0);
    assert.equal(readCurrentGitImage(imagesRoot, rig.origin.repo)?.anchorSha, rig.origin.sha);
  } finally {
    if (run != null) await run.worker.terminate();
    rig.cleanup();
  }
});

test("provision-worker: image failure fallback keeps the deferred retry", async () => {
  const rig = makeRig();
  let run: WorkerRun | null = null;
  try {
    const imagesRoot = join(rig.root, "blocked-images");
    const movedBlocker = join(rig.root, "blocked-images.file");
    writeFileSync(imagesRoot, "not a directory\n");
    const fallbackRequest = request(rig, "bee-fallback", "fallback");

    run = runWorker({
      cellsRoot: rig.cellsRoot,
      request: fallbackRequest,
      opId: "start-bee-fallback-g1",
      disableCow: false,
      useGitImages: true,
      gitImagesRoot: imagesRoot,
    });

    assert.deepEqual(await within(run.result, 15_000, "fallback result"), { ok: true });
    const ledger = readLedger(cellPaths(rig.cellsRoot, "bee-fallback", "fixture", "fallback").ledgerPath);
    assert.notEqual(ledger?.copy_mode, "image-cow");
    assert.equal(await exitsWithin(run.exit, 100), false, "fallback must wait for maintenance");

    renameSync(imagesRoot, movedBlocker);
    run.worker.postMessage({ kind: "refresh_git_image" });
    assert.equal(await within(run.exit, 15_000, "fallback maintenance"), 0);
    assert.equal(readCurrentGitImage(imagesRoot, rig.origin.repo)?.anchorSha, rig.origin.sha);
  } finally {
    if (run != null) await run.worker.terminate();
    rig.cleanup();
  }
});

test("provision-worker: provisioning errors stay failed and do not enter maintenance", async () => {
  const rig = makeRig();
  let run: WorkerRun | null = null;
  try {
    run = runWorker({
      cellsRoot: rig.cellsRoot,
      request: request(rig, "bee-error", "error", join(rig.root, "missing-origin")),
      opId: "start-bee-error-g1",
      disableCow: false,
      useGitImages: true,
      gitImagesRoot: join(rig.root, "images"),
    });

    const result = await within(run.result, 5_000, "failed result");
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /has no \.git/);
    assert.equal(await within(run.exit, 2_000, "failed worker exit"), 1);
  } finally {
    if (run != null) await run.worker.terminate();
    rig.cleanup();
  }
});
