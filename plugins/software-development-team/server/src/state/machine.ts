import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { PlanStep, RunState, StepState, StepResult } from '../types.js';
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
    this.checkWipLimit(run, stepId);

    // Claim files and warn about overlaps with other active steps
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
    const conflicts: string[] = [];
    for (const other of run.steps) {
      if (other.step.id === stepId) continue;
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
    const run = this.requireRun(runId);
    const stepState = this.requireStep(run, stepId);
    const reasons: string[] = [];

    // Check unmet dependencies
    for (const depId of stepState.step.dependsOn) {
      const dep = run.steps.find((s) => s.step.id === depId);
      if (dep && dep.status !== 'complete') {
        reasons.push(`Waiting on step ${depId}: ${dep.step.description}`);
      }
    }

    // Check WIP limit
    const activeSteps = run.steps.filter(
      (s) => s.step.id !== stepId && (s.status === 'coding' || s.status === 'reviewing')
    );
    if (activeSteps.length >= 2) {
      reasons.push(`WIP limit reached (max 2 concurrent steps)`);
    }

    // Check file conflicts
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

  private checkWipLimit(run: RunState, stepId: number): void {
    const activeSteps = run.steps.filter(
      (s) => s.step.id !== stepId && (s.status === 'coding' || s.status === 'reviewing')
    );
    if (activeSteps.length >= 2) {
      throw new Error(
        `WIP limit reached: ${activeSteps.length} steps already active (${activeSteps.map((s) => `step ${s.step.id}: ${s.status}`).join(', ')}). Wait for a step to complete before starting another.`
      );
    }
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
