import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StateMachine } from '../src/state/machine.js';
import { Database } from '../src/db/database.js';
import type { ExecutionControlAction, ExecutionMode, PlanStep, RunState, StepState } from '../src/types.js';

const makeStep = (
  id: number,
  dependsOn: number[] = [],
  files?: string[],
  executionMode?: ExecutionMode,
): PlanStep => ({
  id,
  description: `Step ${id}`,
  files: files ?? [`file${id}.ts`],
  acceptanceCriteria: [`criterion ${id}`],
  dependsOn,
  ...(executionMode === undefined ? {} : { executionMode }),
});

describe('StateMachine', () => {
  let sm: StateMachine;
  let db: Database;

  beforeEach(async () => {
    db = await Database.create();
    sm = new StateMachine(db);
  });

  const worktree = (stepId: number) => ({
    targetBranch: 'main',
    targetCommit: 'abc123',
    path: `/tmp/run/step-${stepId}`,
    branch: `team-run-step-${stepId}`,
  });

  describe('createRun', () => {
    it('creates a run with pending steps', () => {
      const steps = [makeStep(1), makeStep(2)];
      const run = sm.createRun(steps);
      expect(run.status).toBe('ready');
      expect(run.steps).toHaveLength(2);
      expect(run.steps[0].status).toBe('pending');
      expect(run.steps[1].status).toBe('pending');
      expect(run.steps.map(({ step }) => step.executionMode)).toEqual(['code', 'code']);
    });

    it('canonicalizes execution modes while preserving explicit read-only steps', () => {
      const run = sm.createRun([makeStep(1), makeStep(2, [], undefined, 'read_only')]);

      expect(run.steps[0].step.executionMode).toBe('code');
      expect(run.steps[1].step.executionMode).toBe('read_only');
      expect(sm.getRun(run.id)!.steps.map(({ step }) => step.executionMode)).toEqual([
        'code',
        'read_only',
      ]);
    });

    it('rejects unsupported execution modes without inserting or emitting a run', () => {
      const insertSpy = vi.spyOn(db, 'insertRun');
      const events: RunState[] = [];
      sm.on('state_update', (state: RunState) => events.push(state));
      const invalid = { ...makeStep(1), executionMode: 'documentation' } as unknown as PlanStep;

      expect(() => sm.createRun([invalid])).toThrow("unsupported execution mode \"documentation\"");
      expect(insertSpy).not.toHaveBeenCalled();
      expect(sm.getAllRuns()).toEqual([]);
      expect(events).toHaveLength(0);
    });

    it('generates a unique run ID', () => {
      const run1 = sm.createRun([makeStep(1)]);
      const run2 = sm.createRun([makeStep(1)]);
      expect(run1.id).not.toBe(run2.id);
    });
  });

  describe('startStep', () => {
    it('transitions a pending step to coding', () => {
      const run = sm.createRun([makeStep(1)]);
      sm.startStep(run.id, 1, 'coder');
      const updated = sm.getRun(run.id)!;
      expect(updated.steps[0].status).toBe('coding');
      expect(updated.steps[0].assignedAgent).toBe('coder');
      expect(updated.status).toBe('in_progress');
    });

    it('rejects starting a step with unmet dependencies', () => {
      const run = sm.createRun([makeStep(1), makeStep(2, [1])]);
      expect(() => sm.startStep(run.id, 2, 'coder')).toThrow('dependencies');
    });

    it('throws when step is already in coding status (prevents silent agent takeover)', () => {
      const run = sm.createRun([makeStep(1)]);
      sm.startStep(run.id, 1, 'coder-1');
      // A second agent trying to start the same step should be rejected
      expect(() => sm.startStep(run.id, 1, 'coder-2')).toThrow('already being worked on');
    });

    it('allows independent pairwise-disjoint steps to start immediately', () => {
      const run = sm.createRun([
        makeStep(1, [], ['a.ts']),
        makeStep(2, [], ['b.ts']),
        makeStep(3, [], ['c.ts']),
      ]);

      sm.startStep(run.id, 1, 'coder-1');
      sm.startStep(run.id, 2, 'coder-2');
      sm.startStep(run.id, 3, 'coder-3');

      expect(sm.getRun(run.id)!.steps.map((step) => step.status)).toEqual([
        'coding',
        'coding',
        'coding',
      ]);
    });

    it('rejects every overlapping coding claim with deterministic conflict details', () => {
      const run = sm.createRun([
        makeStep(1, [], ['shared-a.ts', 'shared-b.ts']),
        makeStep(2, [], ['shared-c.ts', 'shared-d.ts']),
        makeStep(3, [], ['shared-a.ts', 'shared-b.ts', 'shared-c.ts']),
      ]);
      sm.startStep(run.id, 1, 'coder-1');
      sm.startStep(run.id, 2, 'coder-2');

      expect(() => sm.startStep(run.id, 3, 'coder-3')).toThrow(
        'Step 3 has file conflicts: shared-a.ts (also claimed by step 1), shared-b.ts (also claimed by step 1), shared-c.ts (also claimed by step 2)'
      );
    });

    it('rejects overlaps with reviewing steps and retains their claims', () => {
      const run = sm.createRun([
        makeStep(1, [], ['shared.ts']),
        makeStep(2, [], ['shared.ts']),
      ]);
      sm.startStep(run.id, 1, 'coder-1');
      sm.submitResult(run.id, 1, { status: 'done', summary: 'implemented' });

      expect(() => sm.startStep(run.id, 2, 'coder-2')).toThrow(
        'Step 2 has file conflicts: shared.ts (also claimed by step 1)'
      );
      expect(sm.getRun(run.id)!.steps[0].claimedFiles).toEqual(['shared.ts']);
      expect(sm.getRun(run.id)!.steps[0].status).toBe('reviewing');
    });

    it('leaves state, persistence, timestamps, and events unchanged after rejection', () => {
      const run = sm.createRun([
        makeStep(1, [], ['shared.ts']),
        makeStep(2, [], ['shared.ts']),
      ]);
      sm.startStep(run.id, 1, 'coder-1');
      const before = sm.getRun(run.id)!;
      const events: RunState[] = [];
      sm.on('state_update', (state: RunState) => events.push(state));

      expect(() => sm.startStep(run.id, 2, 'coder-2')).toThrow('file conflicts');

      expect(sm.getRun(run.id)).toEqual(before);
      expect(sm.getRun(run.id)!.updatedAt).toBe(before.updatedAt);
      expect(events).toHaveLength(0);
    });

    it('compares claimed paths as exact strings without normalization', () => {
      const run = sm.createRun([
        makeStep(1, [], ['src/file.ts']),
        makeStep(2, [], ['./src/file.ts']),
      ]);

      sm.startStep(run.id, 1, 'coder-1');
      expect(() => sm.startStep(run.id, 2, 'coder-2')).not.toThrow();
    });
  });

  describe('submitResult', () => {
    it('transitions coding step to reviewing on done', () => {
      const run = sm.createRun([makeStep(1)]);
      sm.startStep(run.id, 1, 'coder');
      sm.submitResult(run.id, 1, { status: 'done', summary: 'implemented' });
      const updated = sm.getRun(run.id)!;
      expect(updated.steps[0].status).toBe('reviewing');
    });

    it('marks step as escalated on blocked', () => {
      const run = sm.createRun([makeStep(1)]);
      sm.startStep(run.id, 1, 'coder');
      sm.submitResult(run.id, 1, { status: 'blocked', summary: 'stuck' });
      const updated = sm.getRun(run.id)!;
      expect(updated.steps[0].status).toBe('escalated');
      expect(updated.status).toBe('escalated');
    });

    it('allows reviewer to submit result from reviewing state', () => {
      const run = sm.createRun([makeStep(1)]);
      sm.startStep(run.id, 1, 'coder');
      sm.submitResult(run.id, 1, { status: 'done', summary: 'coded' });
      sm.submitResult(run.id, 1, { status: 'needs_revision', summary: 'missing validation' });
      const updated = sm.getRun(run.id)!;
      expect(updated.steps[0].status).toBe('reviewing');
      expect(updated.steps[0].result!.status).toBe('needs_revision');
    });
  });

  describe('advanceStep', () => {
    it('marks a reviewing step as complete when result is done', () => {
      const run = sm.createRun([makeStep(1)]);
      sm.startStep(run.id, 1, 'coder');
      sm.submitResult(run.id, 1, { status: 'done', summary: 'done' });
      sm.advanceStep(run.id, 1);
      const updated = sm.getRun(run.id)!;
      expect(updated.steps[0].status).toBe('complete');
    });

    it('allows advancing when result is done_with_concerns', () => {
      const run = sm.createRun([makeStep(1)]);
      sm.startStep(run.id, 1, 'coder');
      sm.submitResult(run.id, 1, { status: 'done_with_concerns', summary: 'works but...' });
      sm.advanceStep(run.id, 1);
      expect(sm.getRun(run.id)!.steps[0].status).toBe('complete');
    });

    it('rejects advancing when result is needs_revision', () => {
      const run = sm.createRun([makeStep(1)]);
      sm.startStep(run.id, 1, 'coder');
      sm.submitResult(run.id, 1, { status: 'done', summary: 'coded' });
      // Reviewer submits needs_revision
      sm.submitResult(run.id, 1, { status: 'needs_revision', summary: 'bad' });
      expect(() => sm.advanceStep(run.id, 1)).toThrow('cannot be approved');
    });

    it('sets run to complete when all steps complete', () => {
      const run = sm.createRun([makeStep(1)]);
      sm.startStep(run.id, 1, 'coder');
      sm.submitResult(run.id, 1, { status: 'done', summary: 'done' });
      sm.advanceStep(run.id, 1);
      expect(sm.getRun(run.id)!.status).toBe('complete');
    });
  });

  describe('requestRevision', () => {
    it('transitions reviewing step back to coding and increments retry', () => {
      const run = sm.createRun([makeStep(1)]);
      sm.startStep(run.id, 1, 'coder');
      sm.submitResult(run.id, 1, { status: 'done', summary: 'done' });
      // Reviewer submits needs_revision before requestRevision
      sm.submitResult(run.id, 1, { status: 'needs_revision', summary: 'fix the types' });
      sm.requestRevision(run.id, 1);
      const updated = sm.getRun(run.id)!;
      expect(updated.steps[0].status).toBe('coding');
      expect(updated.steps[0].retryCount).toBe(1);
    });

    it('allows 3 retries before escalation', () => {
      const run = sm.createRun([makeStep(1)]);
      // First attempt: startStep from pending
      sm.startStep(run.id, 1, 'coder');

      // 3 full revision cycles — coder gets 3 more attempts
      // After requestRevision step is 'coding', so no re-startStep needed
      for (let i = 0; i < 3; i++) {
        sm.submitResult(run.id, 1, { status: 'done', summary: 'done' });
        // Reviewer submits needs_revision before requestRevision
        sm.submitResult(run.id, 1, { status: 'needs_revision', summary: 'still needs work' });
        sm.requestRevision(run.id, 1);
        expect(sm.getRun(run.id)!.steps[0].status).toBe('coding');
      }
      // 4th revision triggers escalation (retryCount = 4 > MAX_RETRIES=3)
      sm.submitResult(run.id, 1, { status: 'done', summary: 'done' });
      sm.submitResult(run.id, 1, { status: 'needs_revision', summary: 'still needs work' });
      sm.requestRevision(run.id, 1);
      expect(sm.getRun(run.id)!.steps[0].status).toBe('escalated');
    });

    it('throws when result status is not needs_revision', () => {
      const run = sm.createRun([makeStep(1)]);
      sm.startStep(run.id, 1, 'coder');
      sm.submitResult(run.id, 1, { status: 'done', summary: 'done' });
      // result is 'done', not 'needs_revision'
      expect(() => sm.requestRevision(run.id, 1)).toThrow('needs_revision');
    });

    it('throws when result status is done_with_concerns', () => {
      const run = sm.createRun([makeStep(1)]);
      sm.startStep(run.id, 1, 'coder');
      sm.submitResult(run.id, 1, { status: 'done_with_concerns', summary: 'works but concerns' });
      // result is 'done_with_concerns', not 'needs_revision'
      expect(() => sm.requestRevision(run.id, 1)).toThrow('needs_revision');
    });
  });

  describe('pipeline parallelism', () => {
    it('allows starting step N+1 while step N is reviewing if no dependency', () => {
      const run = sm.createRun([makeStep(1), makeStep(2)]);
      sm.startStep(run.id, 1, 'coder');
      sm.submitResult(run.id, 1, { status: 'done', summary: 'done' });
      sm.startStep(run.id, 2, 'coder');
      const updated = sm.getRun(run.id)!;
      expect(updated.steps[0].status).toBe('reviewing');
      expect(updated.steps[1].status).toBe('coding');
    });

    it('blocks starting step N+1 if it depends on step N and N is not complete', () => {
      const run = sm.createRun([makeStep(1), makeStep(2, [1])]);
      sm.startStep(run.id, 1, 'coder');
      sm.submitResult(run.id, 1, { status: 'done', summary: 'done' });
      expect(() => sm.startStep(run.id, 2, 'coder')).toThrow('dependencies');
    });
  });

  describe('concurrency', () => {
    it('allows many steps to be active at once (no WIP cap)', () => {
      const steps = Array.from({ length: 12 }, (_, i) => makeStep(i + 1));
      const run = sm.createRun(steps);
      for (let id = 1; id <= 12; id++) {
        sm.startStep(run.id, id, 'coder');
      }
      expect(sm.getRun(run.id)!.steps.every((s) => s.status === 'coding')).toBe(true);
    });
  });

  describe('resolveEscalation', () => {
    it('transitions escalated step back to coding', () => {
      const run = sm.createRun([makeStep(1)]);
      sm.setWorktree(run.id, 1, worktree(1));
      sm.startStep(run.id, 1, 'coder');
      sm.submitResult(run.id, 1, { status: 'blocked', summary: 'stuck' });
      sm.resolveEscalation(run.id, 1);
      const updated = sm.getRun(run.id)!;
      expect(updated.steps[0].status).toBe('coding');
      expect(updated.status).toBe('in_progress');
      expect(updated.steps[0].manualAttempt).toBe(1);
      expect(updated.lifecycle?.history[0].summary).toMatch(/deprecated/i);
    });

    it('restores claimedFiles to the planned files so conflicts are visible again', () => {
      const run = sm.createRun([
        makeStep(1, [], ['shared.ts', 'other.ts']),
        makeStep(2, [], ['shared.ts']),
      ]);
      sm.setWorktree(run.id, 1, worktree(1));
      sm.startStep(run.id, 1, 'coder');
      sm.submitResult(run.id, 1, { status: 'blocked', summary: 'stuck' });
      // Escalation clears claims
      expect(sm.getRun(run.id)!.steps[0].claimedFiles).toEqual([]);

      sm.resolveEscalation(run.id, 1);

      const updated = sm.getRun(run.id)!;
      expect(updated.steps[0].claimedFiles).toEqual(['shared.ts', 'other.ts']);
      // The resumed step's claims must block an overlapping startStep
      expect(() => sm.startStep(run.id, 2, 'coder-2')).toThrow(
        'Step 2 has file conflicts: shared.ts (also claimed by step 1)'
      );
    });

    it('throws when another active step claims an overlapping file, without side effects', () => {
      const run = sm.createRun([
        makeStep(1, [], ['shared.ts']),
        makeStep(2, [], ['shared.ts']),
      ]);
      sm.setWorktree(run.id, 1, worktree(1));
      // Step 1 escalates, releasing its claim on shared.ts
      sm.startStep(run.id, 1, 'coder-1');
      sm.submitResult(run.id, 1, { status: 'blocked', summary: 'stuck' });
      // Step 2 starts coding and claims shared.ts
      sm.startStep(run.id, 2, 'coder-2');

      const before = sm.getRun(run.id)!;
      const events: RunState[] = [];
      sm.on('state_update', (state: RunState) => events.push(state));

      expect(() => sm.resolveEscalation(run.id, 1)).toThrow(
        'Step 1 cannot retry — file conflicts: shared.ts (also claimed by step 2)'
      );

      const after = sm.getRun(run.id)!;
      expect(after).toEqual(before);
      expect(after.steps[0].status).toBe('escalated');
      expect(after.steps[0].claimedFiles).toEqual([]);
      expect(after.updatedAt).toBe(before.updatedAt);
      expect(events).toHaveLength(0);
    });

    it('rejects overlaps with reviewing steps as well', () => {
      const run = sm.createRun([
        makeStep(1, [], ['shared.ts']),
        makeStep(2, [], ['shared.ts']),
      ]);
      sm.setWorktree(run.id, 1, worktree(1));
      sm.startStep(run.id, 1, 'coder-1');
      sm.submitResult(run.id, 1, { status: 'blocked', summary: 'stuck' });
      sm.startStep(run.id, 2, 'coder-2');
      sm.submitResult(run.id, 2, { status: 'done', summary: 'done' });
      // Step 2 is reviewing and still holds shared.ts

      expect(() => sm.resolveEscalation(run.id, 1)).toThrow('shared.ts (also claimed by step 2)');
      expect(sm.getRun(run.id)!.steps[0].status).toBe('escalated');
    });
  });

  describe('execution controls', () => {
    it('pauses cooperatively, retains active claims, freezes admissions, and resumes', () => {
      const run = sm.createRun([
        makeStep(1, [], ['active.ts']),
        makeStep(2, [], ['next.ts']),
      ]);
      sm.startStep(run.id, 1, 'coder');

      const pause = sm.executeControl(run.id, {
        action: 'pause_run', target: { kind: 'run' }, commandId: 'pause-1', expectedRevision: 0,
      });
      expect(pause.outcome.controlPhase).toBe('pausing');
      expect(sm.getRun(run.id)!.steps[0].claimedFiles).toEqual(['active.ts']);
      expect(() => sm.startStep(run.id, 2, 'coder')).toThrow("control phase is 'pausing'");

      // A worker admitted before the pause may drain and report its result.
      sm.submitResult(run.id, 1, { status: 'done', summary: 'drained' });
      expect(sm.getRun(run.id)!.steps[0].status).toBe('reviewing');
      expect(() => sm.requestRevision(run.id, 1)).toThrow("control phase is 'pausing'");

      sm.executeControl(run.id, {
        action: 'acknowledge_pause', target: { kind: 'run' }, commandId: 'pause-ack-1', expectedRevision: 1,
      });
      expect(sm.getRun(run.id)!.lifecycle?.controlPhase).toBe('paused');
      sm.executeControl(run.id, {
        action: 'resume_run', target: { kind: 'run' }, commandId: 'resume-1', expectedRevision: 2,
      });
      expect(sm.getRun(run.id)!.lifecycle?.controlPhase).toBe('none');
      expect(() => sm.startStep(run.id, 2, 'coder')).not.toThrow();
    });

    it('pauses immediately when no workers need to drain', () => {
      const run = sm.createRun([makeStep(1)]);
      const receipt = sm.executeControl(run.id, {
        action: 'pause_run', target: { kind: 'run' }, commandId: 'pause-ready', expectedRevision: 0,
      });
      expect(receipt.outcome.controlPhase).toBe('paused');
      expect(sm.getRun(run.id)!.lifecycle?.pausedAt).toBeDefined();
    });

    it('cancels an active step cooperatively, rejects late output, then releases claims on acknowledgement', () => {
      const run = sm.createRun([
        makeStep(1, [], ['shared.ts']),
        makeStep(2, [], ['shared.ts']),
      ]);
      sm.startStep(run.id, 1, 'coder');
      sm.executeControl(run.id, {
        action: 'cancel_step', target: { kind: 'step', stepId: 1 }, commandId: 'cancel-step-1', expectedRevision: 0,
      });

      let state = sm.getRun(run.id)!;
      expect(state.steps[0].status).toBe('cancelling');
      expect(state.steps[0].claimedFiles).toEqual(['shared.ts']);
      expect(() => sm.submitResult(run.id, 1, { status: 'done', summary: 'late' }))
        .toThrow("cannot submit result from status 'cancelling'");
      expect(() => sm.startStep(run.id, 2, 'coder')).toThrow('file conflicts');

      sm.executeControl(run.id, {
        action: 'acknowledge_cancel', target: { kind: 'step', stepId: 1 }, commandId: 'cancel-ack-1', expectedRevision: 1,
      });
      state = sm.getRun(run.id)!;
      expect(state.steps[0].status).toBe('cancelled');
      expect(state.steps[0].claimedFiles).toEqual([]);
      expect(state.steps[0].cancelledAt).toBeDefined();
      expect(() => sm.startStep(run.id, 2, 'coder')).not.toThrow();
      expect(state.status).toBe('escalated');
    });

    it('cancels inactive steps immediately without cascading and reports dependent blockers', () => {
      const run = sm.createRun([
        makeStep(1),
        makeStep(2, [1]),
        makeStep(3),
      ]);
      sm.executeControl(run.id, {
        action: 'cancel_step', target: { kind: 'step', stepId: 1 }, commandId: 'cancel-pending', expectedRevision: 0,
      });
      const state = sm.getRun(run.id)!;
      expect(state.steps.map((step) => step.status)).toEqual(['cancelled', 'pending', 'pending']);
      expect(state.status).toBe('escalated');
      expect(sm.getBlockingReasons(run.id, 2)).toEqual([
        'Blocked by cancelled dependency step 1: Step 1',
      ]);
      expect(() => sm.startStep(run.id, 2, 'coder')).toThrow("step 1 is 'cancelled'");
      expect(() => sm.startStep(run.id, 3, 'coder')).not.toThrow();
      expect(sm.getRun(run.id)!.status).toBe('escalated');
    });

    it('cancels a run only after active workers drain while cancelling pending work immediately', () => {
      const run = sm.createRun([makeStep(1), makeStep(2), makeStep(3)]);
      sm.startStep(run.id, 1, 'coder');
      sm.submitResult(run.id, 1, { status: 'done', summary: 'awaiting review' });
      sm.startStep(run.id, 2, 'coder');
      sm.executeControl(run.id, {
        action: 'cancel_run', target: { kind: 'run' }, commandId: 'cancel-run-1', expectedRevision: 0,
      });
      let state = sm.getRun(run.id)!;
      expect(state.lifecycle?.controlPhase).toBe('cancelling');
      expect(state.steps.map((step) => step.status)).toEqual(['cancelling', 'cancelling', 'cancelled']);
      expect(state.steps[0].claimedFiles).toEqual(['file1.ts']);
      expect(() => sm.startStep(run.id, 3, 'coder')).toThrow("control phase is 'cancelling'");
      expect(() => sm.submitResult(run.id, 2, { status: 'done', summary: 'late' }))
        .toThrow("cannot submit result from status 'cancelling'");
      expect(() => sm.executeControl(run.id, {
        action: 'acknowledge_cancel', target: { kind: 'step', stepId: 1 }, commandId: 'wrong-scope-ack', expectedRevision: 1,
      })).toThrow('must be acknowledged with a run target');

      sm.executeControl(run.id, {
        action: 'acknowledge_cancel', target: { kind: 'run' }, commandId: 'cancel-run-ack', expectedRevision: 1,
      });
      state = sm.getRun(run.id)!;
      expect(state.lifecycle?.controlPhase).toBe('cancelled');
      expect(state.status).toBe('cancelled');
      expect(state.steps.every((step) => step.status === 'cancelled')).toBe(true);
      expect(state.steps.every((step) => step.claimedFiles.length === 0)).toBe(true);
    });

    it('cancels an inactive run immediately and keeps completed steps immutable', () => {
      const run = sm.createRun([makeStep(1), makeStep(2)]);
      sm.startStep(run.id, 1, 'coder');
      sm.submitResult(run.id, 1, { status: 'done', summary: 'done' });
      sm.advanceStep(run.id, 1);

      expect(() => sm.executeControl(run.id, {
        action: 'cancel_step', target: { kind: 'step', stepId: 1 }, commandId: 'cancel-complete', expectedRevision: 0,
      })).toThrow('complete and immutable');

      sm.executeControl(run.id, {
        action: 'cancel_run', target: { kind: 'run' }, commandId: 'cancel-inactive-run', expectedRevision: 0,
      });
      const state = sm.getRun(run.id)!;
      expect(state.lifecycle?.controlPhase).toBe('cancelled');
      expect(state.status).toBe('cancelled');
      expect(state.steps.map((step) => step.status)).toEqual(['complete', 'cancelled']);
    });

    it('retries only eligible escalated steps with durable worktrees and preserves attempt history', () => {
      const run = sm.createRun([makeStep(1)]);
      sm.setWorktree(run.id, 1, worktree(1));
      sm.startStep(run.id, 1, 'coder');
      sm.submitResult(run.id, 1, { status: 'blocked', summary: 'first blocker' });

      const receipt = sm.executeControl(run.id, {
        action: 'retry_step', target: { kind: 'step', stepId: 1 }, commandId: 'retry-1', expectedRevision: 0,
      });
      const step = sm.getRun(run.id)!.steps[0];
      expect(receipt.outcome.stepStatus).toBe('coding');
      expect(step.manualAttempt).toBe(1);
      expect(step.retryCount).toBe(0);
      expect(step.claimedFiles).toEqual(['file1.ts']);
      expect(step.resultHistory?.at(-1)?.summary).toBe('first blocker');
      expect(step.result).toBeNull();
      expect(step.worktree).toEqual(worktree(1));
    });

    it('rejects retry without a worktree, unmet dependencies, conflicts, or remaining manual attempts', () => {
      const missing = sm.createRun([makeStep(1)]);
      sm.startStep(missing.id, 1, 'coder');
      sm.submitResult(missing.id, 1, { status: 'blocked', summary: 'blocked' });
      expect(() => sm.executeControl(missing.id, {
        action: 'retry_step', target: { kind: 'step', stepId: 1 }, commandId: 'retry-missing', expectedRevision: 0,
      })).toThrow('without persisted worktree');

      const dependent = sm.createRun([makeStep(1), makeStep(2, [1])]);
      sm.setWorktree(dependent.id, 2, worktree(2));
      // Restore gives us a realistic escalated dependent whose prerequisite is incomplete.
      const dependentState = sm.getRun(dependent.id)!;
      dependentState.steps[1].status = 'escalated';
      sm.restoreRun({ ...dependentState, id: 'dependent-retry' });
      expect(() => sm.executeControl('dependent-retry', {
        action: 'retry_step', target: { kind: 'step', stepId: 2 }, commandId: 'retry-dependent', expectedRevision: 0,
      })).toThrow('unmet dependencies');

      const conflicting = sm.createRun([
        makeStep(1, [], ['shared.ts']), makeStep(2, [], ['shared.ts']),
      ]);
      sm.setWorktree(conflicting.id, 1, worktree(1));
      sm.startStep(conflicting.id, 1, 'coder');
      sm.submitResult(conflicting.id, 1, { status: 'blocked', summary: 'blocked' });
      sm.startStep(conflicting.id, 2, 'coder');
      expect(() => sm.executeControl(conflicting.id, {
        action: 'retry_step', target: { kind: 'step', stepId: 1 }, commandId: 'retry-conflict', expectedRevision: 0,
      })).toThrow('file conflicts');

      const exhausted = sm.createRun([makeStep(1)]);
      sm.setWorktree(exhausted.id, 1, worktree(1));
      sm.startStep(exhausted.id, 1, 'coder');
      for (let attempt = 0; attempt < 3; attempt++) {
        sm.submitResult(exhausted.id, 1, { status: 'blocked', summary: `blocked ${attempt + 1}` });
        sm.executeControl(exhausted.id, {
          action: 'retry_step',
          target: { kind: 'step', stepId: 1 },
          commandId: `retry-${attempt + 1}`,
          expectedRevision: attempt,
        });
      }
      sm.submitResult(exhausted.id, 1, { status: 'blocked', summary: 'blocked 4' });
      expect(() => sm.executeControl(exhausted.id, {
        action: 'retry_step', target: { kind: 'step', stepId: 1 }, commandId: 'retry-exhausted', expectedRevision: 3,
      })).toThrow('exhausted its 3 manual retry attempts');
      expect(sm.getRun(exhausted.id)!.steps[0].manualAttempt).toBe(3);
    });

    it('returns retained identical replays and rejects payload mismatches or stale revisions side-effect-free', () => {
      const run = sm.createRun([makeStep(1)]);
      const events: RunState[] = [];
      sm.on('state_update', (state: RunState) => events.push(state));
      const updateSpy = vi.spyOn(db, 'updateRun');
      const command = {
        action: 'pause_run' as const,
        target: { kind: 'run' as const },
        commandId: 'idempotent-pause',
        expectedRevision: 0,
      };

      const first = sm.executeControl(run.id, command);
      const afterFirst = sm.getRun(run.id)!;
      expect(updateSpy).toHaveBeenCalledTimes(1);
      expect(events).toHaveLength(1);
      expect(afterFirst.lifecycle?.revision).toBe(1);
      expect(afterFirst.lifecycle?.commandReceipts).toHaveLength(1);
      expect(afterFirst.lifecycle?.history).toHaveLength(1);

      expect(sm.executeControl(run.id, command)).toEqual(first);
      expect(sm.getRun(run.id)).toEqual(afterFirst);
      expect(updateSpy).toHaveBeenCalledTimes(1);
      expect(events).toHaveLength(1);

      expect(() => sm.executeControl(run.id, { ...command, action: 'cancel_run' }))
        .toThrow('different payload');
      expect(() => sm.executeControl(run.id, {
        action: 'resume_run', target: { kind: 'run' }, commandId: 'stale-resume', expectedRevision: 0,
      })).toThrow('revision conflict');
      expect(sm.getRun(run.id)).toEqual(afterFirst);
      expect(updateSpy).toHaveBeenCalledTimes(1);
      expect(events).toHaveLength(1);
    });

    it('rejects inherited and unknown runtime actions without durable side effects', () => {
      const run = sm.createRun([makeStep(1)]);
      const before = sm.getRun(run.id)!;
      const updateSpy = vi.spyOn(db, 'updateRun');
      const events: RunState[] = [];
      sm.on('state_update', (state: RunState) => events.push(state));

      for (const action of ['toString', 'hasOwnProperty', 'unknown_action']) {
        expect(() => sm.executeControl(run.id, {
          action: action as ExecutionControlAction,
          target: { kind: 'run' },
          commandId: `unsupported-${action}`,
          expectedRevision: 0,
        })).toThrow(`Unsupported lifecycle action '${action}'`);

        const after = sm.getRun(run.id)!;
        expect(after).toEqual(before);
        expect(after.lifecycle?.revision).toBe(0);
        expect(after.lifecycle?.commandReceipts).toEqual([]);
        expect(after.lifecycle?.history).toEqual([]);
        expect(updateSpy).not.toHaveBeenCalled();
        expect(events).toEqual([]);
      }
    });

    it('bounds durable command receipts and lifecycle history', () => {
      const run = sm.createRun([makeStep(1)]);
      const seeded = sm.getRun(run.id)!;
      const receipt = (revision: number) => ({
        commandId: `seed-${revision}`,
        fingerprint: `seed-${revision}`,
        action: 'pause_run' as const,
        target: { kind: 'run' as const },
        expectedRevision: revision - 1,
        revision,
        recordedAt: seeded.createdAt,
        outcome: { controlPhase: 'paused' as const, runStatus: 'ready' as const },
      });
      seeded.id = 'bounded-run';
      seeded.lifecycle!.revision = 255;
      seeded.lifecycle!.commandReceipts = Array.from({ length: 255 }, (_, index) => receipt(index + 1));
      seeded.lifecycle!.history = Array.from({ length: 127 }, (_, index) => ({
        commandId: `history-${index + 1}`,
        action: 'pause_run' as const,
        target: { kind: 'run' as const },
        revision: index + 1,
        recordedAt: seeded.createdAt,
        fromPhase: 'none' as const,
        toPhase: 'paused' as const,
      }));
      sm.restoreRun(seeded);

      sm.executeControl('bounded-run', {
        action: 'pause_run', target: { kind: 'run' }, commandId: 'pause-256', expectedRevision: 255,
      });
      sm.executeControl('bounded-run', {
        action: 'resume_run', target: { kind: 'run' }, commandId: 'resume-257', expectedRevision: 256,
      });
      const lifecycle = sm.getRun('bounded-run')!.lifecycle!;
      expect(lifecycle.revision).toBe(257);
      expect(lifecycle.commandReceipts).toHaveLength(256);
      expect(lifecycle.history).toHaveLength(128);
      expect(lifecycle.commandReceipts[0].commandId).toBe('seed-2');
      expect(lifecycle.history[0].commandId).toBe('history-2');
    });

    it('restores in-flight lifecycle state and replays a durable receipt without another effect', () => {
      const run = sm.createRun([makeStep(1), makeStep(2)]);
      sm.startStep(run.id, 1, 'coder');
      const command = {
        action: 'pause_run' as const,
        target: { kind: 'run' as const },
        commandId: 'restart-pause',
        expectedRevision: 0,
      };
      const receipt = sm.executeControl(run.id, command);
      const beforeRestart = sm.getRun(run.id)!;

      const restarted = new StateMachine(db);
      const updateSpy = vi.spyOn(db, 'updateRun');
      const events: RunState[] = [];
      restarted.on('state_update', (state: RunState) => events.push(state));

      expect(restarted.getRun(run.id)).toEqual(beforeRestart);
      expect(restarted.executeControl(run.id, command)).toEqual(receipt);
      expect(restarted.getRun(run.id)).toEqual(beforeRestart);
      expect(updateSpy).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    });

    it('keeps completed and cancelled targets terminal with rejected commands side-effect-free', () => {
      const completed = sm.createRun([makeStep(1)]);
      sm.startStep(completed.id, 1, 'coder');
      sm.submitResult(completed.id, 1, { status: 'done', summary: 'done' });
      sm.advanceStep(completed.id, 1);

      const completedBefore = sm.getRun(completed.id)!;
      const updateSpy = vi.spyOn(db, 'updateRun');
      const events: RunState[] = [];
      sm.on('state_update', (state: RunState) => events.push(state));
      expect(() => sm.executeControl(completed.id, {
        action: 'pause_run', target: { kind: 'run' }, commandId: 'pause-complete', expectedRevision: 0,
      })).toThrow('terminal and cannot be paused');
      expect(() => sm.executeControl(completed.id, {
        action: 'cancel_run', target: { kind: 'run' }, commandId: 'cancel-complete-run', expectedRevision: 0,
      })).toThrow('terminal and cannot be cancelled');
      expect(sm.getRun(completed.id)).toEqual(completedBefore);

      const cancelled = sm.createRun([makeStep(1)]);
      sm.executeControl(cancelled.id, {
        action: 'cancel_run', target: { kind: 'run' }, commandId: 'cancel-terminal', expectedRevision: 0,
      });
      const cancelledBefore = sm.getRun(cancelled.id)!;
      const writesAfterCancel = updateSpy.mock.calls.length;
      const eventsAfterCancel = events.length;
      expect(() => sm.executeControl(cancelled.id, {
        action: 'resume_run', target: { kind: 'run' }, commandId: 'resume-cancelled', expectedRevision: 1,
      })).toThrow("cannot resume from control phase 'cancelled'");
      expect(() => sm.startStep(cancelled.id, 1, 'coder')).toThrow("control phase is 'cancelled'");
      expect(sm.getRun(cancelled.id)).toEqual(cancelledBefore);
      expect(updateSpy).toHaveBeenCalledTimes(writesAfterCancel);
      expect(events).toHaveLength(eventsAfterCancel);
    });
  });

  describe('markReviewed', () => {
    it('closes a coding read-only step directly to complete with a synthetic result', () => {
      const run = sm.createRun([makeStep(1, [], undefined, 'read_only')]);
      sm.startStep(run.id, 1, 'reviewer');
      sm.markReviewed(run.id, 1);
      const updated = sm.getRun(run.id)!;
      expect(updated.steps[0].status).toBe('complete');
      expect(updated.steps[0].result?.status).toBe('done');
      expect(updated.steps[0].result?.summary).toMatch(/review/i);
      expect(updated.steps[0].completedAt).toBeDefined();
      expect(updated.steps[0].claimedFiles).toEqual([]);
      expect(updated.status).toBe('complete');
    });

    it('uses a provided summary when given', () => {
      const run = sm.createRun([makeStep(1, [], undefined, 'read_only')]);
      sm.startStep(run.id, 1, 'reviewer');
      sm.markReviewed(run.id, 1, 'Security findings delivered.');
      expect(sm.getRun(run.id)!.steps[0].result?.summary).toBe('Security findings delivered.');
    });

    it('does not create resultHistory when no result was ever submitted', () => {
      const run = sm.createRun([makeStep(1, [], undefined, 'read_only')]);
      sm.startStep(run.id, 1, 'reviewer');
      sm.markReviewed(run.id, 1);
      expect(sm.getRun(run.id)!.steps[0].resultHistory).toBeUndefined();
    });

    it('rejects every non-read-only or non-pristine-coding state without side effects', () => {
      const code = sm.createRun([makeStep(1)]);
      sm.startStep(code.id, 1, 'coder');

      const pending = sm.createRun([makeStep(1, [], undefined, 'read_only')]);

      const reviewingDone = sm.createRun([makeStep(1, [], undefined, 'read_only')]);
      sm.startStep(reviewingDone.id, 1, 'reviewer');
      sm.submitResult(reviewingDone.id, 1, { status: 'done', summary: 'submitted' });

      const reviewingRejected = sm.createRun([makeStep(1, [], undefined, 'read_only')]);
      sm.startStep(reviewingRejected.id, 1, 'reviewer');
      sm.submitResult(reviewingRejected.id, 1, { status: 'done', summary: 'submitted' });
      sm.submitResult(reviewingRejected.id, 1, {
        status: 'needs_revision',
        summary: 'rejected',
      });

      const codingWithResult = sm.createRun([makeStep(1, [], undefined, 'read_only')]);
      sm.startStep(codingWithResult.id, 1, 'reviewer');
      const malformedCoding = sm.getRun(codingWithResult.id)!;
      malformedCoding.steps[0].result = { status: 'done', summary: 'unexpected submission' };
      db.updateRun(malformedCoding);

      const complete = sm.createRun([makeStep(1, [], undefined, 'read_only')]);
      sm.startStep(complete.id, 1, 'reviewer');
      sm.markReviewed(complete.id, 1);

      const escalated = sm.createRun([makeStep(1, [], undefined, 'read_only')]);
      sm.startStep(escalated.id, 1, 'reviewer');
      sm.submitResult(escalated.id, 1, { status: 'blocked', summary: 'blocked' });

      const cancelled = sm.createRun([makeStep(1, [], undefined, 'read_only')]);
      sm.executeControl(cancelled.id, {
        action: 'cancel_run',
        target: { kind: 'run' },
        commandId: 'cancel-read-only',
        expectedRevision: 0,
      });

      const cases = [
        { runId: code.id, error: "execution mode 'code'" },
        { runId: pending.id, error: "status 'pending'" },
        { runId: reviewingDone.id, error: "status 'reviewing'" },
        { runId: reviewingRejected.id, error: "status 'reviewing'" },
        { runId: codingWithResult.id, error: 'after a result has been submitted' },
        { runId: complete.id, error: "status 'complete'" },
        { runId: escalated.id, error: "status 'escalated'" },
        { runId: cancelled.id, error: "status 'cancelled'" },
      ];
      const updateSpy = vi.spyOn(db, 'updateRun');
      const events: RunState[] = [];
      sm.on('state_update', (state: RunState) => events.push(state));

      for (const testCase of cases) {
        const before = sm.getRun(testCase.runId)!;
        const writesBefore = updateSpy.mock.calls.length;
        const eventsBefore = events.length;

        expect(() => sm.markReviewed(testCase.runId, 1)).toThrow(testCase.error);
        expect(sm.getRun(testCase.runId)).toEqual(before);
        expect(updateSpy).toHaveBeenCalledTimes(writesBefore);
        expect(events).toHaveLength(eventsBefore);
      }
    });
  });

  describe('updateRunStatus', () => {
    it('returns to ready when all steps are pending', () => {
      const run = sm.createRun([makeStep(1), makeStep(2)]);
      // Run starts as ready with all pending
      expect(sm.getRun(run.id)!.status).toBe('ready');
    });
  });

  describe('restoreRun', () => {
    it('restores a run and makes it retrievable via getRun', () => {
      const fakeRun: RunState = {
        id: 'restored-run',
        status: 'in_progress',
        steps: [{
          step: makeStep(1),
          status: 'coding',
          retryCount: 0,
          assignedAgent: 'coder',
          result: null,
          claimedFiles: ['file1.ts'],
          consecutiveSameError: 0,
        }],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:01:00Z',
      };
      sm.restoreRun(fakeRun);
      const retrieved = sm.getRun('restored-run');
      expect(retrieved).toBeDefined();
      expect(retrieved!.status).toBe('in_progress');
      expect(retrieved!.steps[0].assignedAgent).toBe('coder');
      expect(retrieved!.steps[0].step.executionMode).toBe('code');
    });

    it('preserves explicit read-only mode while restoring', () => {
      const source = sm.createRun([makeStep(1, [], undefined, 'read_only')]);
      const restored = sm.getRun(source.id)!;
      restored.id = 'restored-read-only';

      sm.restoreRun(restored);

      expect(sm.getRun(restored.id)!.steps[0].step.executionMode).toBe('read_only');
    });

    it('canonicalizes a legacy step without changing lifecycle-v2 or result history', () => {
      const source = sm.createRun([makeStep(1)]);
      sm.executeControl(source.id, {
        action: 'pause_run',
        target: { kind: 'run' },
        commandId: 'legacy-pause',
        expectedRevision: 0,
      });
      sm.executeControl(source.id, {
        action: 'resume_run',
        target: { kind: 'run' },
        commandId: 'legacy-resume',
        expectedRevision: 1,
      });
      const legacy = sm.getRun(source.id)!;
      legacy.id = 'legacy-execution-mode';
      delete legacy.steps[0].step.executionMode;
      legacy.status = 'in_progress';
      legacy.steps[0].status = 'reviewing';
      legacy.steps[0].result = { status: 'done', summary: 'current result' };
      legacy.steps[0].resultHistory = [
        { status: 'done', summary: 'first result' },
        { status: 'needs_revision', summary: 'review feedback' },
      ];
      const expectedLifecycle = structuredClone(legacy.lifecycle);
      const expectedHistory = structuredClone(legacy.steps[0].resultHistory);

      sm.restoreRun(legacy);
      const restored = sm.getRun(legacy.id)!;

      expect(restored.steps[0].step.executionMode).toBe('code');
      expect(restored.status).toBe('in_progress');
      expect(restored.steps[0].status).toBe('reviewing');
      expect(restored.steps[0].result).toEqual({ status: 'done', summary: 'current result' });
      expect(restored.steps[0].resultHistory).toEqual(expectedHistory);
      expect(restored.lifecycle).toEqual(expectedLifecycle);
    });

    it('rejects unsupported execution modes without inserting or emitting a restored run', () => {
      const source = sm.createRun([makeStep(1)]);
      const invalid = sm.getRun(source.id)!;
      invalid.id = 'invalid-restored-mode';
      invalid.steps[0].step.executionMode = 'documentation' as ExecutionMode;
      const insertSpy = vi.spyOn(db, 'insertRun');
      insertSpy.mockClear();
      const events: RunState[] = [];
      sm.on('state_update', (state: RunState) => events.push(state));

      expect(() => sm.restoreRun(invalid)).toThrow("unsupported execution mode \"documentation\"");
      expect(insertSpy).not.toHaveBeenCalled();
      expect(sm.getRun(invalid.id)).toBeUndefined();
      expect(events).toHaveLength(0);
    });

    it('does not emit state_update on restore', () => {
      const events: any[] = [];
      sm.on('state_update', (run: any) => events.push(run));
      const fakeRun: RunState = {
        id: 'restored-run-2',
        status: 'ready',
        steps: [{
          step: makeStep(1),
          status: 'pending',
          retryCount: 0,
          assignedAgent: null,
          result: null,
          claimedFiles: [],
          consecutiveSameError: 0,
        }],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:01:00Z',
      };
      sm.restoreRun(fakeRun);
      // restoreRun should NOT emit state_update (only createRun does)
      expect(events).toHaveLength(0);
    });
  });

  describe('getFileConflicts', () => {
    it('returns empty array when no other steps claim same files', () => {
      const run = sm.createRun([
        makeStep(1, [], ['a.ts']),
        makeStep(2, [], ['b.ts']),
      ]);
      sm.startStep(run.id, 1, 'coder');
      expect(sm.getFileConflicts(run.id, 2)).toEqual([]);
    });

    it('returns conflicts when another coding step claims same file', () => {
      const run = sm.createRun([
        makeStep(1, [], ['shared.ts']),
        makeStep(2, [], ['shared.ts']),
      ]);
      sm.startStep(run.id, 1, 'coder');
      const conflicts = sm.getFileConflicts(run.id, 2);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toContain('shared.ts');
      expect(conflicts[0]).toContain('step 1');
    });

    it('returns conflicts when another reviewing step claims same file', () => {
      const run = sm.createRun([
        makeStep(1, [], ['shared.ts']),
        makeStep(2, [], ['shared.ts']),
      ]);
      sm.startStep(run.id, 1, 'coder');
      sm.submitResult(run.id, 1, { status: 'done', summary: 'done' });
      // Step 1 is now reviewing with claimed files
      const conflicts = sm.getFileConflicts(run.id, 2);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toContain('shared.ts');
    });

    it('ignores pending and complete steps', () => {
      const run = sm.createRun([
        makeStep(1, [], ['shared.ts']),
        makeStep(2, [], ['shared.ts']),
        makeStep(3, [], ['shared.ts']),
      ]);
      // Step 1 stays pending (no conflict)
      // Step 2 goes to complete
      sm.startStep(run.id, 2, 'coder');
      sm.submitResult(run.id, 2, { status: 'done', summary: 'done' });
      sm.advanceStep(run.id, 2);
      // Step 3 should see no conflicts (1 is pending, 2 is complete)
      expect(sm.getFileConflicts(run.id, 3)).toEqual([]);
    });
  });

  describe('getBlockingReasons', () => {
    it('returns dependency reasons for incomplete dependencies', () => {
      const run = sm.createRun([makeStep(1), makeStep(2, [1])]);
      const reasons = sm.getBlockingReasons(run.id, 2);
      expect(reasons).toHaveLength(1);
      expect(reasons[0]).toContain('Waiting on step 1');
    });

    it('returns file conflict reasons', () => {
      const run = sm.createRun([
        makeStep(1, [], ['shared.ts']),
        makeStep(2, [], ['shared.ts']),
      ]);
      sm.startStep(run.id, 1, 'coder');
      const reasons = sm.getBlockingReasons(run.id, 2);
      expect(reasons.some(r => r.includes('File conflict'))).toBe(true);
    });

    it('returns empty array when no blockers exist', () => {
      const run = sm.createRun([makeStep(1), makeStep(2)]);
      expect(sm.getBlockingReasons(run.id, 1)).toEqual([]);
    });
  });

  describe('stuck detection', () => {
    it('increments consecutiveSameError on repeated identical error summaries', () => {
      const run = sm.createRun([makeStep(1)]);
      sm.startStep(run.id, 1, 'coder');
      sm.submitResult(run.id, 1, { status: 'needs_revision', summary: 'same error' });
      // After first error: consecutiveSameError = 1
      expect(sm.getRun(run.id)!.steps[0].consecutiveSameError).toBe(1);

      // Reviewer submits revision request, coder retries with same error
      sm.requestRevision(run.id, 1);
      sm.submitResult(run.id, 1, { status: 'needs_revision', summary: 'same error' });
      expect(sm.getRun(run.id)!.steps[0].consecutiveSameError).toBe(2);
    });

    it('resets consecutiveSameError when error signature changes', () => {
      const run = sm.createRun([makeStep(1)]);
      sm.startStep(run.id, 1, 'coder');
      sm.submitResult(run.id, 1, { status: 'needs_revision', summary: 'error A' });
      expect(sm.getRun(run.id)!.steps[0].consecutiveSameError).toBe(1);

      sm.requestRevision(run.id, 1);
      sm.submitResult(run.id, 1, { status: 'needs_revision', summary: 'error B' });
      // Different error → reset to 1
      expect(sm.getRun(run.id)!.steps[0].consecutiveSameError).toBe(1);
      expect(sm.getRun(run.id)!.steps[0].lastErrorSignature).toBe('error b');
    });

    it('resets stuck tracking on successful result', () => {
      const run = sm.createRun([makeStep(1)]);
      sm.startStep(run.id, 1, 'coder');
      sm.submitResult(run.id, 1, { status: 'needs_revision', summary: 'error' });
      expect(sm.getRun(run.id)!.steps[0].consecutiveSameError).toBe(1);

      sm.requestRevision(run.id, 1);
      sm.submitResult(run.id, 1, { status: 'done', summary: 'fixed' });
      expect(sm.getRun(run.id)!.steps[0].consecutiveSameError).toBe(0);
      expect(sm.getRun(run.id)!.steps[0].lastErrorSignature).toBeUndefined();
    });
  });

  describe('invalid transitions', () => {
    it('submitResult throws from pending status', () => {
      const run = sm.createRun([makeStep(1)]);
      expect(() => sm.submitResult(run.id, 1, { status: 'done', summary: 'done' }))
        .toThrow("cannot submit result from status 'pending'");
    });

    it('advanceStep throws from coding status', () => {
      const run = sm.createRun([makeStep(1)]);
      sm.startStep(run.id, 1, 'coder');
      expect(() => sm.advanceStep(run.id, 1))
        .toThrow("cannot be advanced from status 'coding'");
    });

    it('advanceStep throws from pending status', () => {
      const run = sm.createRun([makeStep(1)]);
      expect(() => sm.advanceStep(run.id, 1))
        .toThrow("cannot be advanced from status 'pending'");
    });

    it('requestRevision throws from coding status', () => {
      const run = sm.createRun([makeStep(1)]);
      sm.startStep(run.id, 1, 'coder');
      expect(() => sm.requestRevision(run.id, 1))
        .toThrow("cannot be revised from status 'coding'");
    });

    it('resolveEscalation throws from coding status', () => {
      const run = sm.createRun([makeStep(1)]);
      sm.startStep(run.id, 1, 'coder');
      expect(() => sm.resolveEscalation(run.id, 1))
        .toThrow('not escalated');
    });
  });

  describe('plan validation', () => {
    it('rejects duplicate step ids', () => {
      expect(() => sm.createRun([makeStep(1), makeStep(1)]))
        .toThrow('duplicate step id 1');
    });

    it('rejects a step that depends on itself', () => {
      expect(() => sm.createRun([makeStep(1, [1])]))
        .toThrow('depends on itself');
    });

    it('rejects dependencies on nonexistent steps', () => {
      expect(() => sm.createRun([makeStep(1, [99])]))
        .toThrow('depends on step 99, which does not exist');
    });

    it('rejects dependency cycles', () => {
      expect(() => sm.createRun([makeStep(1, [2]), makeStep(2, [1])]))
        .toThrow('dependency cycle');
    });

    it('rejects longer dependency cycles', () => {
      expect(() => sm.createRun([makeStep(1, [3]), makeStep(2, [1]), makeStep(3, [2])]))
        .toThrow('dependency cycle');
    });

    it('accepts a valid diamond dependency graph', () => {
      const run = sm.createRun([makeStep(1), makeStep(2, [1]), makeStep(3, [1]), makeStep(4, [2, 3])]);
      expect(run.steps).toHaveLength(4);
    });
  });

  describe('result history', () => {
    it('preserves the displaced coder result when the reviewer verdict overwrites it', () => {
      const run = sm.createRun([makeStep(1)]);
      sm.startStep(run.id, 1, 'coder');
      sm.submitResult(run.id, 1, { status: 'done', summary: 'coder finished' });
      sm.submitResult(run.id, 1, { status: 'done', summary: 'reviewer approved' });
      const step = sm.getRun(run.id)!.steps[0];
      expect(step.result?.summary).toBe('reviewer approved');
      expect(step.resultHistory).toHaveLength(1);
      expect(step.resultHistory![0].summary).toBe('coder finished');
    });

    it('accumulates history across revision cycles', () => {
      const run = sm.createRun([makeStep(1)]);
      sm.startStep(run.id, 1, 'coder');
      sm.submitResult(run.id, 1, { status: 'done', summary: 'attempt 1' });
      sm.submitResult(run.id, 1, { status: 'needs_revision', summary: 'reviewer rejected' });
      sm.requestRevision(run.id, 1);
      sm.submitResult(run.id, 1, { status: 'done', summary: 'attempt 2' });
      const step = sm.getRun(run.id)!.steps[0];
      expect(step.result?.summary).toBe('attempt 2');
      expect(step.resultHistory!.map((r) => r.summary)).toEqual(['attempt 1', 'reviewer rejected']);
    });
  });
});
