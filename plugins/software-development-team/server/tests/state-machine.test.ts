import { describe, it, expect, beforeEach } from 'vitest';
import { StateMachine } from '../src/state/machine.js';
import { Database } from '../src/db/database.js';
import type { PlanStep, RunState, StepState } from '../src/types.js';

const makeStep = (id: number, dependsOn: number[] = [], files?: string[]): PlanStep => ({
  id,
  description: `Step ${id}`,
  files: files ?? [`file${id}.ts`],
  acceptanceCriteria: [`criterion ${id}`],
  dependsOn,
});

describe('StateMachine', () => {
  let sm: StateMachine;

  beforeEach(async () => {
    sm = new StateMachine(await Database.create());
  });

  describe('createRun', () => {
    it('creates a run with pending steps', () => {
      const steps = [makeStep(1), makeStep(2)];
      const run = sm.createRun(steps);
      expect(run.status).toBe('ready');
      expect(run.steps).toHaveLength(2);
      expect(run.steps[0].status).toBe('pending');
      expect(run.steps[1].status).toBe('pending');
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
      sm.startStep(run.id, 1, 'coder');
      sm.submitResult(run.id, 1, { status: 'blocked', summary: 'stuck' });
      sm.resolveEscalation(run.id, 1);
      const updated = sm.getRun(run.id)!;
      expect(updated.steps[0].status).toBe('coding');
      expect(updated.status).toBe('in_progress');
    });
  });

  describe('markReviewed', () => {
    it('closes a coding step directly to complete with a synthetic result', () => {
      const run = sm.createRun([makeStep(1)]);
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
      const run = sm.createRun([makeStep(1)]);
      sm.startStep(run.id, 1, 'reviewer');
      sm.markReviewed(run.id, 1, 'Security findings delivered.');
      expect(sm.getRun(run.id)!.steps[0].result?.summary).toBe('Security findings delivered.');
    });

    it('closes a reviewing step as well', () => {
      const run = sm.createRun([makeStep(1)]);
      sm.startStep(run.id, 1, 'coder');
      sm.submitResult(run.id, 1, { status: 'done', summary: 'implemented' });
      sm.markReviewed(run.id, 1, 'reviewed');
      expect(sm.getRun(run.id)!.steps[0].status).toBe('complete');
    });

    it('rejects marking a pending step as reviewed', () => {
      const run = sm.createRun([makeStep(1)]);
      expect(() => sm.markReviewed(run.id, 1)).toThrow("cannot be marked reviewed from status 'pending'");
    });

    it('rejects marking a complete step as reviewed', () => {
      const run = sm.createRun([makeStep(1)]);
      sm.startStep(run.id, 1, 'reviewer');
      sm.markReviewed(run.id, 1);
      expect(() => sm.markReviewed(run.id, 1)).toThrow("cannot be marked reviewed from status 'complete'");
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
