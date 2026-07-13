import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  EXECUTION_CONTROL_CAPABILITIES,
  MAX_COMMAND_RECEIPTS,
  MAX_LIFECYCLE_HISTORY,
  RUN_LIFECYCLE_VERSION,
  type ExecutionControlAction,
  type ExecutionControlTarget,
  type LifecycleCommandReceipt,
  type PlanStep,
  type RunLifecycleV2,
  type RunState,
  type StepState,
  type StepResult,
  type WorktreeContext,
} from '../types.js';
import { logger } from '../logger.js';
import { Database } from '../db/database.js';

const MAX_RETRIES = 3;
const MAX_MANUAL_ATTEMPTS = 3;
const EXECUTION_CONTROL_ACTIONS = new Set<ExecutionControlAction>([
  'pause_run',
  'acknowledge_pause',
  'resume_run',
  'cancel_run',
  'cancel_step',
  'acknowledge_cancel',
  'retry_step',
]);

export interface ExecutionControlCommand {
  action: ExecutionControlAction;
  target: ExecutionControlTarget;
  commandId: string;
  expectedRevision: number;
  summary?: string;
}

export class StateMachine extends EventEmitter {
  private db: Database;

  constructor(db: Database) {
    super();
    this.db = db;
  }

  createRun(steps: PlanStep[], task?: string): RunState {
    this.validatePlan(steps);
    const run: RunState = {
      id: randomUUID(),
      task,
      status: 'ready',
      steps: steps.map((step) => ({
        step,
        status: 'pending',
        retryCount: 0,
        assignedAgent: null,
        result: null,
        claimedFiles: [],
        consecutiveSameError: 0,
      })),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lifecycle: this.newLifecycle(),
    };
    this.db.insertRun(run);
    logger.info('StateMachine', `Run created with ${steps.length} steps`, { runId: run.id, stepIds: steps.map((s) => s.id) });
    this.emit('state_update', structuredClone(run));
    return structuredClone(run);
  }

  // Reject malformed plans at creation so they cannot become permanently stuck
  // runs: duplicate step IDs make step lookup ambiguous, unknown dependencies
  // can never complete, and dependency cycles can never be scheduled.
  private validatePlan(steps: PlanStep[]): void {
    const ids = new Set<number>();
    for (const step of steps) {
      if (ids.has(step.id)) {
        throw new Error(`Plan invalid: duplicate step id ${step.id}`);
      }
      ids.add(step.id);
    }
    for (const step of steps) {
      for (const depId of step.dependsOn) {
        if (depId === step.id) {
          throw new Error(`Plan invalid: step ${step.id} depends on itself`);
        }
        if (!ids.has(depId)) {
          throw new Error(`Plan invalid: step ${step.id} depends on step ${depId}, which does not exist`);
        }
      }
    }
    // Cycle detection via iterative DFS coloring.
    const byId = new Map(steps.map((s) => [s.id, s]));
    const state = new Map<number, 'visiting' | 'done'>();
    for (const step of steps) {
      if (state.get(step.id) === 'done') continue;
      const stack: Array<{ id: number; depIndex: number }> = [{ id: step.id, depIndex: 0 }];
      state.set(step.id, 'visiting');
      while (stack.length > 0) {
        const frame = stack[stack.length - 1];
        const deps = byId.get(frame.id)!.dependsOn;
        if (frame.depIndex >= deps.length) {
          state.set(frame.id, 'done');
          stack.pop();
          continue;
        }
        const depId = deps[frame.depIndex++];
        const depState = state.get(depId);
        if (depState === 'visiting') {
          throw new Error(`Plan invalid: dependency cycle involving steps ${depId} and ${frame.id}`);
        }
        if (depState !== 'done') {
          state.set(depId, 'visiting');
          stack.push({ id: depId, depIndex: 0 });
        }
      }
    }
  }

  restoreRun(run: RunState): void {
    this.db.insertRun(structuredClone(run));
    logger.info('StateMachine', `Run restored from disk`, { runId: run.id, status: run.status });
  }

  getRun(runId: string): RunState | undefined {
    const run = this.db.getRun(runId);
    return run ? structuredClone(run) : undefined;
  }

  getAllRuns(): RunState[] {
    return this.db.getAllRuns().map((r) => structuredClone(r));
  }

  setWorktree(runId: string, stepId: number, worktree: WorktreeContext): void {
    const run = this.requireRun(runId);
    const stepState = this.requireStep(run, stepId);
    if (stepState.status !== 'pending') {
      throw new Error(`Step ${stepId} worktree can only be set while pending, not '${stepState.status}'`);
    }
    if (stepState.worktree) {
      throw new Error(`Step ${stepId} worktree lifecycle context is already set`);
    }
    stepState.worktree = { ...worktree };
    logger.info('StateMachine', `Step ${stepId} worktree context persisted`, { runId, worktree });
    this.updateRunStatus(run);
  }

  startStep(runId: string, stepId: number, agent: string): void {
    const run = this.requireRun(runId);
    const stepState = this.requireStep(run, stepId);

    this.requireAdmissionsOpen(run);

    if (stepState.status === 'coding') {
      throw new Error(`Step ${stepId} is already being worked on by agent '${stepState.assignedAgent}'`);
    }

    if (stepState.status !== 'pending') {
      throw new Error(`Step ${stepId} cannot be started from status '${stepState.status}'`);
    }

    this.checkDependencies(run, stepState);

    const fileConflicts = this.collectFileConflicts(run, stepState);
    if (fileConflicts.length > 0) {
      throw new Error(`Step ${stepId} has file conflicts: ${fileConflicts.join(', ')}`);
    }

    // Claim files only after all admission checks have passed.
    stepState.claimedFiles = [...stepState.step.files];
    stepState.status = 'coding';
    stepState.assignedAgent = agent;
    stepState.startedAt = new Date().toISOString();
    logger.info('StateMachine', `Step ${stepId} started`, { runId, agent, files: stepState.claimedFiles });
    this.updateRunStatus(run);
  }

  getFileConflicts(runId: string, stepId: number): string[] {
    const run = this.requireRun(runId);
    const stepState = this.requireStep(run, stepId);
    return this.collectFileConflicts(run, stepState);
  }

  // Snapshot variants: compute from an already-fetched run so callers iterating
  // all steps (e.g., team_status) don't re-fetch and re-parse the run per step.
  fileConflictsFor(run: RunState, stepId: number): string[] {
    return this.collectFileConflicts(run, this.requireStep(run, stepId));
  }

  blockingReasonsFor(run: RunState, stepId: number): string[] {
    const stepState = this.requireStep(run, stepId);
    const reasons: string[] = [];

    for (const depId of stepState.step.dependsOn) {
      const dep = run.steps.find((s) => s.step.id === depId);
      if (!dep) {
        reasons.push(`Waiting on step ${depId}, which does not exist in this run — the step can never start`);
      } else if (dep.status === 'cancelled' || dep.status === 'cancelling') {
        reasons.push(`Blocked by cancelled dependency step ${depId}: ${dep.step.description}`);
      } else if (dep.status !== 'complete') {
        reasons.push(`Waiting on step ${depId}: ${dep.step.description}`);
      }
    }

    for (const other of run.steps) {
      if (other.step.id === stepId) continue;
      if (other.status !== 'coding' && other.status !== 'reviewing' && other.status !== 'cancelling') continue;
      for (const file of stepState.step.files) {
        if (other.claimedFiles.includes(file)) {
          reasons.push(`File conflict: ${file} is claimed by step ${other.step.id}`);
        }
      }
    }

    return reasons;
  }

  private collectFileConflicts(run: RunState, stepState: StepState): string[] {
    const conflicts: string[] = [];
    for (const other of run.steps) {
      if (other.step.id === stepState.step.id) continue;
      if (other.status !== 'coding' && other.status !== 'reviewing' && other.status !== 'cancelling') continue;
      for (const file of stepState.step.files) {
        if (other.claimedFiles.includes(file)) {
          conflicts.push(`${file} (also claimed by step ${other.step.id})`);
        }
      }
    }
    return conflicts;
  }

  getBlockingReasons(runId: string, stepId: number): string[] {
    return this.blockingReasonsFor(this.requireRun(runId), stepId);
  }

  submitResult(runId: string, stepId: number, result: StepResult): void {
    const run = this.requireRun(runId);
    const stepState = this.requireStep(run, stepId);

    if (stepState.status !== 'coding' && stepState.status !== 'reviewing') {
      throw new Error(`Step ${stepId} cannot submit result from status '${stepState.status}'`);
    }

    // Track stuck detection — same error signature repeating
    if (result.status === 'needs_revision' || result.status === 'blocked') {
      const errorSig = result.summary.trim().toLowerCase();
      if (stepState.lastErrorSignature === errorSig) {
        stepState.consecutiveSameError++;
      } else {
        stepState.lastErrorSignature = errorSig;
        stepState.consecutiveSameError = 1;
      }
    } else {
      stepState.lastErrorSignature = undefined;
      stepState.consecutiveSameError = 0;
    }

    // Preserve the displaced result (e.g., the coder's submission when the
    // reviewer's verdict overwrites it) so the state file keeps an audit trail.
    if (stepState.result) {
      stepState.resultHistory = [...(stepState.resultHistory ?? []), stepState.result];
    }
    stepState.result = result;

    if (result.status === 'blocked') {
      stepState.status = 'escalated';
      stepState.claimedFiles = [];
      logger.warn('StateMachine', `Step ${stepId} BLOCKED`, { runId, summary: result.summary });
    } else if (stepState.status === 'coding') {
      stepState.status = 'reviewing';
      logger.info('StateMachine', `Step ${stepId} submitted → reviewing`, { runId, resultStatus: result.status });
    } else {
      // Reviewer submitting — status stays 'reviewing'
      logger.info('StateMachine', `Step ${stepId} reviewer result received`, { runId, resultStatus: result.status });
    }

    if (stepState.consecutiveSameError > 0) {
      logger.warn('StateMachine', `Step ${stepId} consecutive same error: ${stepState.consecutiveSameError}`, { runId });
    }

    this.updateRunStatus(run);
  }

  advanceStep(runId: string, stepId: number): void {
    const run = this.requireRun(runId);
    const stepState = this.requireStep(run, stepId);

    if (stepState.status !== 'reviewing') {
      throw new Error(`Step ${stepId} cannot be advanced from status '${stepState.status}'`);
    }

    // Guard: only approve if the result is actually done or done_with_concerns
    if (stepState.result && stepState.result.status !== 'done' && stepState.result.status !== 'done_with_concerns') {
      throw new Error(`Step ${stepId} cannot be approved: result status is '${stepState.result.status}', expected 'done' or 'done_with_concerns'`);
    }

    stepState.status = 'complete';
    stepState.claimedFiles = [];
    stepState.completedAt = new Date().toISOString();
    logger.info('StateMachine', `Step ${stepId} APPROVED → complete`, { runId });
    this.updateRunStatus(run);
  }

  markReviewed(runId: string, stepId: number, summary?: string): void {
    const run = this.requireRun(runId);
    const stepState = this.requireStep(run, stepId);

    if (stepState.status !== 'coding' && stepState.status !== 'reviewing') {
      throw new Error(`Step ${stepId} cannot be marked reviewed from status '${stepState.status}'`);
    }

    // Preserve a genuinely submitted result (markReviewed is callable from
    // 'reviewing', which is only reachable via submitResult) so the synthetic
    // result below doesn't silently discard it — same audit-trail pattern as
    // submitResult.
    if (stepState.result) {
      stepState.resultHistory = [...(stepState.resultHistory ?? []), stepState.result];
    }

    // Read-only review steps never submit a coder result. Record a synthetic
    // 'done' result so the dashboard reflects the outcome, then close the step.
    stepState.result = {
      status: 'done',
      summary: summary ?? 'Read-only review completed — no code changes to submit.',
    };
    stepState.status = 'complete';
    stepState.claimedFiles = [];
    stepState.completedAt = new Date().toISOString();
    stepState.consecutiveSameError = 0;
    stepState.lastErrorSignature = undefined;
    logger.info('StateMachine', `Step ${stepId} MARKED REVIEWED → complete`, { runId });
    this.updateRunStatus(run);
  }

  requestRevision(runId: string, stepId: number): void {
    const run = this.requireRun(runId);
    const stepState = this.requireStep(run, stepId);

    this.requireAdmissionsOpen(run);

    if (stepState.status !== 'reviewing') {
      throw new Error(`Step ${stepId} cannot be revised from status '${stepState.status}'`);
    }

    if (!stepState.result || stepState.result.status !== 'needs_revision') {
      const actual = stepState.result?.status ?? 'null';
      throw new Error(`Step ${stepId} cannot be revised: result status is '${actual}', expected 'needs_revision'`);
    }

    stepState.retryCount++;

    if (stepState.retryCount > MAX_RETRIES) {
      stepState.status = 'escalated';
      stepState.claimedFiles = [];
      logger.warn('StateMachine', `Step ${stepId} ESCALATED — retry budget exhausted (${stepState.retryCount}/${MAX_RETRIES})`, { runId });
    } else {
      stepState.status = 'coding';
      logger.info('StateMachine', `Step ${stepId} revision requested (retry ${stepState.retryCount}/${MAX_RETRIES})`, { runId });
    }

    this.updateRunStatus(run);
  }

  resolveEscalation(runId: string, stepId: number): void {
    const revision = this.requireLifecycle(this.requireRun(runId)).revision;
    this.executeControl(runId, {
      action: 'retry_step',
      target: { kind: 'step', stepId },
      commandId: randomUUID(),
      expectedRevision: revision,
      summary: 'Deprecated resolve_escalation alias',
    });
  }

  /**
   * Apply an operator lifecycle command as one durable mutation. Validation is
   * completed before mutation; every accepted, non-replayed command then uses
   * the normal single updateRunStatus write/event path exactly once.
   */
  executeControl(runId: string, command: ExecutionControlCommand): LifecycleCommandReceipt {
    const run = this.requireRun(runId);
    const lifecycle = this.requireLifecycle(run);
    this.validateCommandShape(command);

    const fingerprint = this.commandFingerprint(command);
    const previous = lifecycle.commandReceipts.find((receipt) => receipt.commandId === command.commandId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        throw new Error(`Command ${command.commandId} was already used with a different payload`);
      }
      return structuredClone(previous);
    }
    if (command.expectedRevision !== lifecycle.revision) {
      throw new Error(
        `Lifecycle revision conflict: expected ${command.expectedRevision}, current ${lifecycle.revision}`,
      );
    }

    const fromPhase = lifecycle.controlPhase;
    this.validateControlTransition(run, command);
    this.applyControlTransition(run, command);

    const recordedAt = new Date().toISOString();
    const revision = lifecycle.revision + 1;
    lifecycle.revision = revision;
    const receipt: LifecycleCommandReceipt = {
      commandId: command.commandId,
      fingerprint,
      action: command.action,
      target: structuredClone(command.target),
      expectedRevision: command.expectedRevision,
      revision,
      recordedAt,
      outcome: {
        controlPhase: lifecycle.controlPhase,
        runStatus: this.deriveRunStatus(run),
        ...(command.target.kind === 'step'
          ? { stepStatus: this.requireStep(run, command.target.stepId).status }
          : {}),
      },
    };
    lifecycle.commandReceipts = [...lifecycle.commandReceipts, receipt].slice(-MAX_COMMAND_RECEIPTS);
    lifecycle.history = [...lifecycle.history, {
      commandId: command.commandId,
      action: command.action,
      target: structuredClone(command.target),
      revision,
      recordedAt,
      fromPhase,
      toPhase: lifecycle.controlPhase,
      ...(command.summary ? { summary: command.summary } : {}),
    }].slice(-MAX_LIFECYCLE_HISTORY);

    logger.info('StateMachine', `Lifecycle command ${command.action} applied`, {
      runId,
      commandId: command.commandId,
      revision,
      target: command.target,
    });
    this.updateRunStatus(run);
    return structuredClone(receipt);
  }

  private validateCommandShape(command: ExecutionControlCommand): void {
    if (typeof command.commandId !== 'string' || !command.commandId.trim()) {
      throw new Error('commandId must not be empty');
    }
    if (!EXECUTION_CONTROL_ACTIONS.has(command.action)) {
      throw new Error(`Unsupported lifecycle action '${String(command.action)}'`);
    }
    if (!Number.isInteger(command.expectedRevision) || command.expectedRevision < 0) {
      throw new Error('expectedRevision must be a non-negative integer');
    }
    const stepActions = new Set<ExecutionControlAction>(['cancel_step', 'retry_step']);
    const runActions = new Set<ExecutionControlAction>(['pause_run', 'resume_run', 'cancel_run', 'acknowledge_pause']);
    if (stepActions.has(command.action) && command.target.kind !== 'step') {
      throw new Error(`${command.action} requires a step target`);
    }
    if (runActions.has(command.action) && command.target.kind !== 'run') {
      throw new Error(`${command.action} requires a run target`);
    }
  }

  private validateControlTransition(run: RunState, command: ExecutionControlCommand): void {
    const lifecycle = this.requireLifecycle(run);
    const phase = lifecycle.controlPhase;
    const terminal = run.status === 'complete' || run.status === 'cancelled' || phase === 'cancelled';

    switch (command.action) {
      case 'pause_run':
        if (terminal) throw new Error(`Run ${run.id} is terminal and cannot be paused`);
        if (phase !== 'none') throw new Error(`Run ${run.id} cannot be paused from control phase '${phase}'`);
        break;
      case 'acknowledge_pause':
        if (phase !== 'pausing') throw new Error(`Run ${run.id} is not awaiting pause acknowledgement`);
        break;
      case 'resume_run':
        if (phase !== 'paused') throw new Error(`Run ${run.id} cannot resume from control phase '${phase}'`);
        break;
      case 'cancel_run':
        if (terminal) throw new Error(`Run ${run.id} is terminal and cannot be cancelled`);
        if (phase === 'cancelling') throw new Error(`Run ${run.id} cancellation is already in progress`);
        break;
      case 'cancel_step': {
        if (phase === 'cancelling' || phase === 'cancelled') {
          throw new Error(`Step cancellation is unavailable while run control phase is '${phase}'`);
        }
        const step = this.requireStep(run, command.target.kind === 'step' ? command.target.stepId : -1);
        if (step.status === 'complete') throw new Error(`Step ${step.step.id} is complete and immutable`);
        if (step.status === 'cancelled' || step.status === 'cancelling') {
          throw new Error(`Step ${step.step.id} is already ${step.status}`);
        }
        break;
      }
      case 'acknowledge_cancel':
        if (command.target.kind === 'run') {
          if (phase !== 'cancelling') throw new Error(`Run ${run.id} is not awaiting cancellation acknowledgement`);
        } else {
          if (phase === 'cancelling') {
            throw new Error(
              `Run ${run.id} cancellation must be acknowledged with a run target after all workers quiesce`,
            );
          }
          const step = this.requireStep(run, command.target.stepId);
          if (step.status !== 'cancelling') {
            throw new Error(`Step ${step.step.id} is not awaiting cancellation acknowledgement`);
          }
        }
        break;
      case 'retry_step': {
        if (phase !== 'none') throw new Error(`Step retry is unavailable while run control phase is '${phase}'`);
        if (terminal) throw new Error(`Run ${run.id} is terminal and cannot retry a step`);
        const step = this.requireStep(run, command.target.kind === 'step' ? command.target.stepId : -1);
        if (step.status !== 'escalated') throw new Error(`Step ${step.step.id} is not escalated`);
        if (!step.worktree) throw new Error(`Step ${step.step.id} cannot retry without persisted worktree context`);
        if ((step.manualAttempt ?? 0) >= MAX_MANUAL_ATTEMPTS) {
          throw new Error(`Step ${step.step.id} exhausted its ${MAX_MANUAL_ATTEMPTS} manual retry attempts`);
        }
        this.checkDependencies(run, step);
        const conflicts = this.collectFileConflicts(run, step);
        if (conflicts.length > 0) {
          throw new Error(`Step ${step.step.id} cannot retry — file conflicts: ${conflicts.join(', ')}`);
        }
        break;
      }
      default:
        throw new Error(`Unsupported lifecycle action '${String(command.action)}'`);
    }
  }

  private applyControlTransition(run: RunState, command: ExecutionControlCommand): void {
    const lifecycle = this.requireLifecycle(run);
    const now = new Date().toISOString();

    switch (command.action) {
      case 'pause_run': {
        lifecycle.pauseRequestedAt = now;
        const hasActiveWorkers = run.steps.some((step) =>
          step.status === 'coding' || step.status === 'reviewing' || step.status === 'cancelling');
        lifecycle.controlPhase = hasActiveWorkers ? 'pausing' : 'paused';
        if (!hasActiveWorkers) lifecycle.pausedAt = now;
        break;
      }
      case 'acknowledge_pause':
        lifecycle.controlPhase = 'paused';
        lifecycle.pausedAt = now;
        break;
      case 'resume_run':
        lifecycle.controlPhase = 'none';
        delete lifecycle.pauseRequestedAt;
        delete lifecycle.pausedAt;
        break;
      case 'cancel_run': {
        lifecycle.cancelRequestedAt = now;
        delete lifecycle.pauseRequestedAt;
        delete lifecycle.pausedAt;
        let draining = false;
        for (const step of run.steps) {
          if (step.status === 'complete' || step.status === 'cancelled') continue;
          if (step.status === 'coding' || step.status === 'reviewing' || step.status === 'cancelling') {
            step.status = 'cancelling';
            step.cancelRequestedAt ??= now;
            draining = true;
          } else {
            this.finishCancellation(step, now);
          }
        }
        lifecycle.controlPhase = draining ? 'cancelling' : 'cancelled';
        break;
      }
      case 'cancel_step': {
        const step = this.requireStep(run, command.target.kind === 'step' ? command.target.stepId : -1);
        if (step.status === 'coding' || step.status === 'reviewing') {
          step.status = 'cancelling';
          step.cancelRequestedAt = now;
        } else {
          this.finishCancellation(step, now);
        }
        break;
      }
      case 'acknowledge_cancel':
        if (command.target.kind === 'run') {
          for (const step of run.steps) {
            if (step.status === 'cancelling') this.finishCancellation(step, now);
          }
          lifecycle.controlPhase = 'cancelled';
        } else {
          this.finishCancellation(this.requireStep(run, command.target.stepId), now);
        }
        break;
      case 'retry_step': {
        const step = this.requireStep(run, command.target.kind === 'step' ? command.target.stepId : -1);
        step.resultHistory = step.result
          ? [...(step.resultHistory ?? []), step.result]
          : step.resultHistory;
        step.result = null;
        step.manualAttempt = (step.manualAttempt ?? 0) + 1;
        step.retryCount = 0;
        step.consecutiveSameError = 0;
        step.lastErrorSignature = undefined;
        step.claimedFiles = [...step.step.files];
        step.status = 'coding';
        step.startedAt = now;
        delete step.completedAt;
        delete step.cancelRequestedAt;
        delete step.cancelledAt;
        break;
      }
      default:
        throw new Error(`Unsupported lifecycle action '${String(command.action)}'`);
    }
  }

  private finishCancellation(step: StepState, now: string): void {
    step.status = 'cancelled';
    step.claimedFiles = [];
    step.cancelledAt = now;
  }

  private newLifecycle(): RunLifecycleV2 {
    return {
      version: RUN_LIFECYCLE_VERSION,
      capabilities: { ...EXECUTION_CONTROL_CAPABILITIES },
      controlPhase: 'none',
      revision: 0,
      commandReceipts: [],
      history: [],
    };
  }

  private requireLifecycle(run: RunState): RunLifecycleV2 {
    // Legacy runs restored before the database migration may still reach this
    // class directly in tests or embeddings. Canonicalize at first mutation;
    // this remains invisible until a successful command is persisted.
    run.lifecycle ??= this.newLifecycle();
    return run.lifecycle;
  }

  private requireAdmissionsOpen(run: RunState): void {
    const phase = this.requireLifecycle(run).controlPhase;
    if (phase !== 'none') {
      throw new Error(`Run ${run.id} is not admitting work while control phase is '${phase}'`);
    }
  }

  private commandFingerprint(command: ExecutionControlCommand): string {
    return JSON.stringify({
      action: command.action,
      target: command.target,
      expectedRevision: command.expectedRevision,
      summary: command.summary ?? null,
    });
  }

  private requireRun(runId: string): RunState {
    const run = this.db.getRun(runId);
    if (!run) throw new Error(`Run ${runId} not found`);
    return run;
  }

  private requireStep(run: RunState, stepId: number): StepState {
    const stepState = run.steps.find((s) => s.step.id === stepId);
    if (!stepState) throw new Error(`Step ${stepId} not found in run ${run.id}`);
    return stepState;
  }

  private checkDependencies(run: RunState, stepState: StepState): void {
    for (const depId of stepState.step.dependsOn) {
      const dep = run.steps.find((s) => s.step.id === depId);
      if (!dep) {
        throw new Error(`Step ${stepState.step.id} declares dependency on step ${depId}, which does not exist`);
      }
      if (dep.status !== 'complete') {
        throw new Error(`Step ${stepState.step.id} has unmet dependencies: step ${depId} is '${dep.status}'`);
      }
    }
  }

  private updateRunStatus(run: RunState): void {
    run.updatedAt = new Date().toISOString();
    run.status = this.deriveRunStatus(run);

    logger.debug('StateMachine', `Run ${run.id} status → ${run.status}`, {
      steps: run.steps.map((s) => ({ id: s.step.id, status: s.status })),
    });
    this.db.updateRun(run);
    this.emit('state_update', structuredClone(run));
  }

  private deriveRunStatus(run: RunState): RunState['status'] {
    if (run.lifecycle?.controlPhase === 'cancelled') return 'cancelled';
    if (run.steps.every((step) => step.status === 'complete')) return 'complete';
    if (run.steps.some((step) => step.status === 'escalated' || step.status === 'cancelled')) {
      return 'escalated';
    }
    if (run.steps.every((step) => step.status === 'pending')) return 'ready';
    if (run.steps.some((step) =>
      step.status === 'coding' || step.status === 'reviewing' || step.status === 'cancelling')) {
      return 'in_progress';
    }
    // Mix of pending + complete with nothing active is ready for admission.
    return 'ready';
  }
}
