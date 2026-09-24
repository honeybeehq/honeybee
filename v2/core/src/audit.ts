import type { ThreadOperationRow } from "./threadOperation.ts";
/**
 * Audit replay — the audit table is a complete, ordered record of every write.
 * `replayAudit` folds the audit rows into a StateDump that must deep-equal the
 * store's `dumpState()` (spec test 13). Any divergence means a write path forgot
 * or mis-recorded its audit row.
 */
import type {
  AccountLimitsRow,
  AccountAdmissionReservationRow,
  AccountRow,
  ActionQueueView,
  ActionView,
  AuditRow,
  BeeHandoffRow,
  BeeMoveRow,
  BeeRow,
  CellOpRow,
  CellRow,
  CommandRow,
  FlagRow,
  MessageRow,
  QuestionRow,
  RuntimeRow,
  SealRow,
  SelectionCursorRow,
  StateDump,
  TaskRow,
  TaskSupplyRow,
  TemplateRow,
  TrackRow,
  TranscriptSegmentRow,
} from "./types.ts";
import type { LoginFlowRow } from "./loginFlow.ts";

export function replayAudit(rows: AuditRow[]): StateDump {
  const threadOperations = new Map<string, ThreadOperationRow>();
  const bees = new Map<string, BeeRow>();
  const runtimes = new Map<string, RuntimeRow>(); // key beeId#generation
  const flags = new Map<number, FlagRow>();
  const mailbox = new Map<number, MessageRow>();
  const commands = new Map<number, CommandRow>();
  const templates = new Map<string, TemplateRow>();
  const tracks = new Map<string, TrackRow>();
  const questions = new Map<string, QuestionRow>();
  const seals = new Map<string, SealRow>();
  const accounts = new Map<string, AccountRow>();
  const accountLimits = new Map<string, AccountLimitsRow>();
  const selectionCursors = new Map<string, SelectionCursorRow>();
  const accountAdmissions = new Map<string, AccountAdmissionReservationRow>();
  const tasks = new Map<string, TaskRow>();
  const taskSupply = new Map<string, TaskSupplyRow>();
  const loginFlows = new Map<string, LoginFlowRow>();
  const cells = new Map<string, CellRow>();
  const beeMoves = new Map<string, BeeMoveRow>();
  const cellOps = new Map<string, CellOpRow>();
  const beeHandoffs = new Map<string, BeeHandoffRow>();
  const transcriptSegments = new Map<string, TranscriptSegmentRow>();
  const actions = new Map<string, ActionView>();
  const actionQueues = new Map<string, ActionQueueView>();
  const cloneHandoff = (h: BeeHandoffRow): BeeHandoffRow => ({
    ...h,
    from: { ...h.from, args: h.from.args === null ? null : [...h.from.args] },
    to: { ...h.to, args: h.to.args === null ? null : [...h.to.args] },
    targetEnv: { ...h.targetEnv },
    context: h.context === null ? null : structuredClone(h.context),
    failure: h.failure === null ? null : { ...h.failure },
  });

  const rtKey = (beeId: string, generation: number) => `${beeId}#${generation}`;
  const mustBee = (id: string): BeeRow => {
    const bee = bees.get(id);
    if (!bee) throw new Error(`audit replay: unknown bee ${id}`);
    return bee;
  };
  const mustCommand = (id: number): CommandRow => {
    const command = commands.get(id);
    if (!command) throw new Error(`audit replay: unknown command ${id}`);
    return command;
  };

  for (const row of rows) {
    const p = row.payload;
    switch (row.kind) {
      case "thread_operation.put": {
        const operation = structuredClone(p.row as ThreadOperationRow);
        threadOperations.set(operation.id, operation);
        break;
      }
      case "bee.created": {
        const bee = p.bee as BeeRow;
        bees.set(bee.id, {
          ...bee,
          human_ref: bee.human_ref ?? null,
          issuing_namespace: bee.issuing_namespace ?? null,
          parentExternal: bee.parentExternal ?? false,
          placementVersion: bee.placementVersion ?? 0,
          activeMoveId: bee.activeMoveId ?? null,
          cellId: bee.cellId ?? null,
          activeHandoffId: bee.activeHandoffId ?? null,
        });
        break;
      }
      case "bee.archived": {
        const bee = mustBee(p.beeId as string);
        bee.lifecycle = "archived";
        bee.archivedAt = p.archivedAt as number;
        break;
      }
      case "bee.unarchived": {
        const bee = mustBee(p.beeId as string);
        bee.lifecycle = "active";
        bee.archivedAt = null;
        break;
      }
      case "bee.provider_session": {
        const bee = mustBee(p.beeId as string);
        bee.providerSessionId = p.providerSessionId as string;
        // v6: learning the fork's own id consumed the one-shot fork seed.
        bee.forkSeed = null;
        break;
      }
      case "bee.spawn_failures": {
        mustBee(p.beeId as string).spawnFailures = p.spawnFailures as number;
        break;
      }
      case "bee.args_set": {
        const args = p.args as string[] | null;
        mustBee(p.beeId as string).args = args === null ? null : [...args];
        break;
      }
      case "bee.human_ref": {
        const bee = mustBee(p.beeId as string);
        bee.human_ref = p.human_ref as string;
        bee.issuing_namespace = p.issuing_namespace as string;
        break;
      }
      case "bee.renamed": {
        mustBee(p.beeId as string).name = p.name as string;
        break;
      }
      case "bee.titled": {
        mustBee(p.beeId as string).title = p.title as string;
        break;
      }
      case "bee.tagged": {
        mustBee(p.beeId as string).tags = [...(p.tags as string[])];
        break;
      }
      case "bee.orphaned": {
        mustBee(p.beeId as string).parentId = null;
        break;
      }
      case "bee.account_set": {
        mustBee(p.beeId as string).account = (p.account as string | null) ?? null;
        break;
      }
      case "bee.env_set": {
        mustBee(p.beeId as string).env = { ...(p.env as Record<string, string>) };
        break;
      }
      case "bee.session_rekeyed": {
        const bee = mustBee(p.beeId as string);
        bee.forkSeed = p.forkSeed as string;
        bee.providerSessionId = null;
        break;
      }
      case "login_flow.put": {
        const flow = p.flow as LoginFlowRow;
        loginFlows.set(flow.id, { ...flow });
        break;
      }
      case "login_flow.removed": {
        const id = p.flowId as string;
        if (!loginFlows.delete(id)) throw new Error(`audit replay: unknown login flow ${id}`);
        break;
      }
      case "account.put": {
        const account = p.account as AccountRow;
        accounts.set(account.id, { ...account });
        break;
      }
      case "account.removed": {
        const id = p.accountId as string;
        if (!accounts.delete(id)) throw new Error(`audit replay: unknown account ${id}`);
        accountLimits.delete(id);
        for (const [key, reservation] of accountAdmissions) {
          if (reservation.account === id) accountAdmissions.delete(key);
        }
        if (p.cursorCleared === true) selectionCursors.delete(p.harness as string);
        break;
      }
      case "account_limits.put": {
        const limits = p.limits as AccountLimitsRow;
        accountLimits.set(limits.account, { ...limits });
        break;
      }
      case "selection_cursor.set": {
        const cursor = p.cursor as SelectionCursorRow;
        selectionCursors.set(cursor.harness, { ...cursor });
        break;
      }
      case "account_admission.reserved": {
        const raw = structuredClone(p.reservation as AccountAdmissionReservationRow);
        const reservation = { ...raw, confirmedAt: raw.confirmedAt ?? null };
        accountAdmissions.set(reservation.id, reservation);
        break;
      }
      case "account_admission.bound": {
        const reservation = accountAdmissions.get(p.reservationId as string);
        if (!reservation) throw new Error(`audit replay: unknown account admission ${String(p.reservationId)}`);
        reservation.beeId = p.beeId as string;
        break;
      }
      case "account_admission.confirmed": {
        const reservation = accountAdmissions.get(p.reservationId as string);
        if (!reservation) throw new Error(`audit replay: unknown account admission ${String(p.reservationId)}`);
        reservation.confirmedAt = p.confirmedAt as number;
        break;
      }
      case "account_admission.released": {
        const reservation = accountAdmissions.get(p.reservationId as string);
        if (!reservation) throw new Error(`audit replay: unknown account admission ${String(p.reservationId)}`);
        reservation.releasedAt = p.releasedAt as number;
        break;
      }
      case "bee.deleted": {
        const beeId = p.beeId as string;
        bees.delete(beeId);
        for (const [k, rt] of runtimes) if (rt.beeId === beeId) runtimes.delete(k);
        for (const [k, f] of flags) if (f.beeId === beeId) flags.delete(k);
        for (const [k, m] of mailbox) if (m.beeId === beeId) mailbox.delete(k);
        for (const [k, q] of questions) if (q.beeId === beeId) questions.delete(k);
        for (const [k, sl] of seals) if (sl.beeId === beeId) seals.delete(k);
        for (const [k, t] of tasks) if (t.beeId === beeId) tasks.delete(k);
        for (const [k, sg] of transcriptSegments) if (sg.beeId === beeId) transcriptSegments.delete(k);
        for (const [k, a] of actions) if (a.beeId === beeId) actions.delete(k);
        actionQueues.delete(beeId);
        taskSupply.delete(beeId);
        for (const id of p.settledCommandIds as number[]) {
          const command = mustCommand(id);
          command.status = "done";
          command.finishedAt = p.deletedAt as number;
        }
        break;
      }
      case "runtime.created":
      case "runtime.updated": {
        const rt = p.runtime as RuntimeRow;
        // v9 back-compat: pre-boot_evidence audit rows replay as the migrated
        // store reads them — the column default, NULL.
        runtimes.set(rtKey(rt.beeId, rt.generation), { ...rt, bootEvidence: rt.bootEvidence ?? null });
        break;
      }
      case "flag.set": {
        const flag = p.flag as FlagRow;
        flags.set(flag.id, { ...flag });
        break;
      }
      case "flag.cleared": {
        const flag = flags.get(p.flagId as number);
        if (!flag) throw new Error(`audit replay: unknown flag ${String(p.flagId)}`);
        flag.clearedAt = p.clearedAt as number;
        break;
      }
      case "mail.enqueued": {
        const message = p.message as MessageRow;
        // v8 back-compat: pre-urgency audit rows replay as the migrated
        // store reads them — the column default, `next`.
        mailbox.set(message.id, { ...message, urgency: message.urgency ?? "next" });
        break;
      }
      case "mail.delivered": {
        const message = mailbox.get(p.messageId as number);
        if (!message) throw new Error(`audit replay: unknown message ${String(p.messageId)}`);
        message.deliveredAt = p.deliveredAt as number;
        message.deliveredGeneration = p.deliveredGeneration as number;
        break;
      }
      case "mail.canceled": {
        const messageId = p.messageId as number;
        if (!mailbox.delete(messageId)) throw new Error(`audit replay: unknown message ${String(messageId)}`);
        break;
      }
      case "mail.expedited": {
        const message = mailbox.get(p.messageId as number);
        if (!message) throw new Error(`audit replay: unknown message ${String(p.messageId)}`);
        message.urgency = p.to as MessageRow["urgency"];
        break;
      }
      case "command.enqueued": {
        const command = p.command as CommandRow;
        commands.set(command.id, { ...command });
        break;
      }
      case "command.reconnect_result": {
        mustCommand(p.commandId as number).args = p.args as Record<string, unknown>;
        break;
      }
      case "command.claimed": {
        mustCommand(p.commandId as number).status = "running";
        break;
      }
      case "command.completed":
      case "command.moot": {
        const command = mustCommand(p.commandId as number);
        command.status = "done";
        command.finishedAt = p.finishedAt as number;
        // A mooted model change drops its restart intent with the settle.
        if (row.kind === "command.moot" && p.args !== undefined) command.args = p.args as Record<string, unknown>;
        break;
      }
      case "command.requeued": {
        const command = mustCommand(p.commandId as number);
        command.status = "queued";
        command.attempts = p.attempts as number;
        command.nextAttemptAt = p.nextAttemptAt as number;
        break;
      }
      case "command.failed": {
        const command = mustCommand(p.commandId as number);
        command.status = "failed";
        command.attempts = p.attempts as number;
        command.finishedAt = p.finishedAt as number;
        command.failureCause = p.failureCause as CommandRow["failureCause"];
        break;
      }
      case "command.boot_requeued": {
        for (const id of p.commandIds as number[]) {
          const command = mustCommand(id);
          command.status = "queued";
          command.nextAttemptAt = p.nextAttemptAt as number;
        }
        break;
      }
      case "output.recorded": {
        mustBee(p.beeId as string).lastOutputAt = p.at as number;
        break;
      }
      case "template.put": {
        const template = p.template as TemplateRow;
        templates.set(template.id, { ...template });
        break;
      }
      case "template.deleted": {
        if (!templates.delete(p.templateId as string)) throw new Error(`audit replay: unknown template ${String(p.templateId)}`);
        break;
      }
      case "track.put": {
        const track = p.track as TrackRow;
        tracks.set(track.id, { ...track });
        break;
      }
      case "track.deleted": {
        if (!tracks.delete(p.trackId as string)) throw new Error(`audit replay: unknown track ${String(p.trackId)}`);
        break;
      }
      case "question.asked": {
        const question = p.question as QuestionRow;
        questions.set(question.id, { ...question, options: question.options === null ? null : [...question.options] });
        break;
      }
      case "question.answered": {
        const question = questions.get(p.questionId as string);
        if (!question) throw new Error(`audit replay: unknown question ${String(p.questionId)}`);
        question.status = "answered";
        question.answer = p.answer as string;
        question.answeredAt = p.answeredAt as number;
        question.answeredBy = p.answeredBy as string;
        question.deliveryMessageId = p.deliveryMessageId as number;
        break;
      }
      case "seal.created": {
        const seal = p.seal as SealRow;
        seals.set(seal.id, { ...seal, refs: [...seal.refs] });
        break;
      }
      case "cell.put": {
        const cell = p.cell as CellRow;
        cells.set(cell.id, { ...cell, repository: { ...cell.repository } });
        const owner = bees.get(cell.sourceBeeId);
        if (owner) owner.cellId = cell.id;
        break;
      }
      case "cell.removed": {
        const cellId = p.cellId as string;
        const existing = cells.get(cellId);
        if (!existing) throw new Error(`audit replay: unknown cell ${cellId}`);
        existing.state = "removed";
        existing.removedAt = p.removedAt as number;
        const owner = bees.get(existing.sourceBeeId);
        if (owner?.cellId === cellId) owner.cellId = null;
        break;
      }
      case "bee.move_admitted": {
        const move = p.move as BeeMoveRow;
        beeMoves.set(move.id, { ...move, from: { ...move.from }, to: { ...move.to }, observedHead: move.observedHead ?? "" });
        const bee = mustBee(move.beeId);
        bee.activeMoveId = move.id;
        break;
      }
      case "bee.move_phase": {
        const move = p.move as BeeMoveRow;
        beeMoves.set(move.id, { ...move, from: { ...move.from }, to: { ...move.to }, observedHead: move.observedHead ?? "" });
        const bee = mustBee(move.beeId);
        if (move.phase === "complete" || move.phase === "failed") bee.activeMoveId = null;
        else bee.activeMoveId = move.id;
        break;
      }
      case "bee.placement": {
        const bee = mustBee(p.beeId as string);
        bee.placementVersion = p.placementVersion as number;
        bee.cwd = p.cwd as string;
        bee.substrate = p.substrate as string;
        bee.cellId = (p.cellId as string | null) ?? bee.cellId;
        break;
      }
      case "bee.move_failed": {
        const move = p.move as BeeMoveRow;
        beeMoves.set(move.id, { ...move, from: { ...move.from }, to: { ...move.to }, observedHead: move.observedHead ?? "" });
        mustBee(move.beeId).activeMoveId = null;
        break;
      }
      case "bee.move_instructions": {
        const move = p.move as BeeMoveRow;
        beeMoves.set(move.id, { ...move, from: { ...move.from }, to: { ...move.to }, observedHead: move.observedHead ?? "" });
        break;
      }
      case "cell_op.put": {
        const op = p.op as CellOpRow;
        cellOps.set(op.id, { ...op, argv: op.argv === null ? null : [...op.argv] });
        break;
      }
      case "transcript_segment.put": {
        const segment = p.segment as TranscriptSegmentRow;
        transcriptSegments.set(segment.id, { ...segment });
        break;
      }
      case "bee.handoff_admitted": {
        const handoff = p.handoff as BeeHandoffRow;
        beeHandoffs.set(handoff.id, cloneHandoff(handoff));
        mustBee(handoff.beeId).activeHandoffId = handoff.id;
        break;
      }
      case "bee.handoff_phase": {
        const handoff = p.handoff as BeeHandoffRow;
        beeHandoffs.set(handoff.id, cloneHandoff(handoff));
        const bee = mustBee(handoff.beeId);
        if (handoff.phase === "complete" || handoff.phase === "failed") bee.activeHandoffId = null;
        else bee.activeHandoffId = handoff.id;
        break;
      }
      case "bee.handoff_failed": {
        const handoff = p.handoff as BeeHandoffRow;
        beeHandoffs.set(handoff.id, cloneHandoff(handoff));
        mustBee(handoff.beeId).activeHandoffId = null;
        break;
      }
      case "bee.handoff_context": {
        const handoff = beeHandoffs.get(p.handoffId as string);
        if (!handoff) throw new Error(`audit replay: unknown handoff ${String(p.handoffId)}`);
        handoff.context = structuredClone(p.context as BeeHandoffRow["context"]);
        handoff.seedMessageId = p.seedMessageId as number;
        handoff.to = { ...handoff.to, segmentId: p.targetSegmentId as string };
        handoff.targetGeneration = p.targetGeneration as number;
        break;
      }
      case "bee.handoff_switched": {
        const bee = mustBee(p.beeId as string);
        bee.agent = p.agent as string;
        const args = p.args as string[] | null;
        bee.args = args === null ? null : [...args];
        bee.account = (p.account as string | null) ?? null;
        bee.env = { ...(p.env as Record<string, string>) };
        bee.providerSessionId = null;
        bee.forkSeed = null;
        bee.sessionLogPath = (p.sessionLogPath as string | null) ?? null;
        bee.spawnFailures = 0;
        break;
      }
      case "task.put": {
        const task = p.task as TaskRow;
        tasks.set(task.id, {
          ...task,
          context: task.context === null ? null : { ...task.context },
        });
        break;
      }
      case "task_supply.put": {
        const supply = p.supply as TaskSupplyRow;
        taskSupply.set(supply.beeId, { ...supply });
        break;
      }
      // Recorded no-ops and informational rows: state unchanged by definition.
      // v31: `cell.evicted` is history beside the `cell.put` state change.
      case "cell.evicted":
      case "bee.imported":
      case "bee.interrupted":
      case "bee.forked":
      case "runtime.stale_update":
      case "flag.clear_noop":
      case "mail.deliver_noop":
      case "command.complete_noop":
      case "command.dedup":
      case "wake.suppressed":
      case "wake.fenced":
      case "boot.reconciled":
      case "bee.provider_session_fenced":
        break;
      // v24: action queue — the payload carries the full view (hold/controls
      // included, token never), so the mirror needs no derivation.
      case "action.put": {
        const action = structuredClone(p.action as ActionView);
        actions.set(action.id, action);
        break;
      }
      case "action_queue.put": {
        const queue = structuredClone(p.queue as ActionQueueView);
        actionQueues.set(queue.beeId, queue);
        break;
      }
      case "action.report_rejected":
        break;
      default:
        throw new Error(`audit replay: unknown audit kind ${row.kind}`);
    }
  }

  return {
    threadOperations: [...threadOperations.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    bees: [...bees.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    runtimes: [...runtimes.values()].sort((a, b) =>
      a.beeId !== b.beeId ? (a.beeId < b.beeId ? -1 : 1) : a.generation - b.generation,
    ),
    flags: [...flags.values()].sort((a, b) => a.id - b.id),
    mailbox: [...mailbox.values()].sort((a, b) => a.id - b.id),
    commands: [...commands.values()].sort((a, b) => a.id - b.id),
    templates: [...templates.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    tracks: [...tracks.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    questions: [...questions.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    seals: [...seals.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    accounts: [...accounts.values()].sort((a, b) => a.addedAt - b.addedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    accountLimits: [...accountLimits.values()].sort((a, b) => (a.account < b.account ? -1 : a.account > b.account ? 1 : 0)),
    selectionCursors: [...selectionCursors.values()].sort((a, b) => (a.harness < b.harness ? -1 : a.harness > b.harness ? 1 : 0)),
    accountAdmissions: [...accountAdmissions.values()].sort((a, b) =>
      a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    tasks: [...tasks.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    taskSupply: [...taskSupply.values()].sort((a, b) => (a.beeId < b.beeId ? -1 : a.beeId > b.beeId ? 1 : 0)),
    loginFlows: [...loginFlows.values()].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    cells: [...cells.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    beeMoves: [...beeMoves.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    cellOps: [...cellOps.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    beeHandoffs: [...beeHandoffs.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    transcriptSegments: [...transcriptSegments.values()].sort((a, b) =>
      a.beeId !== b.beeId ? (a.beeId < b.beeId ? -1 : 1) : a.ordinal - b.ordinal,
    ),
    actions: [...actions.values()].sort((a, b) => (a.beeId !== b.beeId ? (a.beeId < b.beeId ? -1 : 1) : a.position - b.position)),
    actionQueues: [...actionQueues.values()].sort((a, b) => (a.beeId < b.beeId ? -1 : a.beeId > b.beeId ? 1 : 0)),
  };
}
