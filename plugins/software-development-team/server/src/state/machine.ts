import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { PlanStep, RunState, StepState, StepResult, WorktreeContext } from '../types.js';
import { logger } from '../logger.js';
import { Database } from '../db/database.js';

const MAX_RETRIES = 3;

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
      } else if (dep.status !== 'complete') {
        reasons.push(`Waiting on step ${depId}: ${dep.step.description}`);
      }
    }

    for (const other of run.steps) {
      if (other.step.id === stepId) continue;
      if (other.status !== 'coding' && other.status !== 'reviewing') continue;
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
      if (other.status !== 'coding' && other.status !== 'reviewing') continue;
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
    const run = this.requireRun(runId);
    const stepState = this.requireStep(run, stepId);

    if (stepState.status !== 'escalated') {
      throw new Error(`Step ${stepId} is not escalated`);
    }

    // Escalation cleared this step's claims, so resuming must re-run the same
    // admission check as startStep against other active steps' claims. Throw
    // BEFORE any mutation so a rejected call is side-effect free (no DB write,
    // no updatedAt change, no state_update emission).
    const fileConflicts = this.collectFileConflicts(run, stepState);
    if (fileConflicts.length > 0) {
      throw new Error(`Step ${stepId} cannot resume from escalation — file conflicts: ${fileConflicts.join(', ')}`);
    }

    // Re-claim the step's planned files so collectFileConflicts sees this step
    // again while it is back in 'coding'.
    stepState.claimedFiles = [...stepState.step.files];
    stepState.retryCount = 0;
    stepState.consecutiveSameError = 0;
    stepState.lastErrorSignature = undefined;
    stepState.status = 'coding';
    logger.info('StateMachine', `Step ${stepId} escalation resolved → coding`, { runId });
    this.updateRunStatus(run);
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

    const allComplete = run.steps.every((s) => s.status === 'complete');
    const allPending = run.steps.every((s) => s.status === 'pending');
    const anyEscalated = run.steps.some((s) => s.status === 'escalated');
    const anyActive = run.steps.some(
      (s) => s.status === 'coding' || s.status === 'reviewing'
    );

    if (allComplete) {
      run.status = 'complete';
    } else if (allPending) {
      run.status = 'ready';
    } else if (anyEscalated && !anyActive) {
      run.status = 'escalated';
    } else if (anyActive) {
      run.status = 'in_progress';
    } else {
      // Mix of pending + complete with nothing active or escalated (stalled run)
      run.status = 'ready';
    }

    logger.debug('StateMachine', `Run ${run.id} status → ${run.status}`, {
      steps: run.steps.map((s) => ({ id: s.step.id, status: s.status })),
    });
    this.db.updateRun(run);
    this.emit('state_update', structuredClone(run));
  }
}
