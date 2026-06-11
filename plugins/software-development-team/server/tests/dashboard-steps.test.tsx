import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/preact';
import {
  allRuns, currentRun, expandedStepId, memoryEntries,
  expandedMemoryKeys, currentFilter, messages, loadingRunId,
} from '../src/dashboard/client/state/store';
import type { RunState, StepState } from '../src/dashboard/client/state/store';

import { StepsPanel } from '../src/dashboard/client/components/steps/StepsPanel';
import { StepCard } from '../src/dashboard/client/components/steps/StepCard';
import { StepDetail } from '../src/dashboard/client/components/steps/StepDetail';
import { WIP_LIMIT } from '../src/constants';

function makeStep(overrides: Partial<StepState> & { step?: Partial<StepState['step']> } = {}): StepState {
  const { step: stepOverrides, ...rest } = overrides;
  return {
    step: { id: 1, description: 'Test step', files: [], acceptanceCriteria: [], dependsOn: [], ...stepOverrides },
    status: 'pending',
    retryCount: 0,
    assignedAgent: null,
    result: null,
    claimedFiles: [],
    consecutiveSameError: 0,
    ...rest,
  };
}

function makeRun(overrides: Partial<RunState> = {}): RunState {
  return {
    id: 'run-1',
    status: 'in_progress',
    steps: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:01:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  cleanup();
  allRuns.value = [];
  currentRun.value = null;
  expandedStepId.value = null;
  memoryEntries.value = [];
  expandedMemoryKeys.value = new Set();
  currentFilter.value = 'all';
  messages.value = [];
  loadingRunId.value = null;
});

// ---------------------------------------------------------------------------
// StepsPanel
// ---------------------------------------------------------------------------
describe('StepsPanel', () => {
  it('shows "No active run" when currentRun is null', () => {
    render(<StepsPanel />);
    expect(screen.getByText('No active run')).toBeTruthy();
  });

  it('renders correct number of step cards when run has steps', () => {
    currentRun.value = makeRun({
      steps: [
        makeStep({ step: { id: 1, description: 'Step one', files: [], acceptanceCriteria: [], dependsOn: [] } }),
        makeStep({ step: { id: 2, description: 'Step two', files: [], acceptanceCriteria: [], dependsOn: [] }, status: 'complete' }),
        makeStep({ step: { id: 3, description: 'Step three', files: [], acceptanceCriteria: [], dependsOn: [] }, status: 'coding' }),
      ],
    });
    const { container } = render(<StepsPanel />);
    const stepEls = container.querySelectorAll('.step');
    expect(stepEls.length).toBe(3);
  });

  it('each step card shows its description text', () => {
    currentRun.value = makeRun({
      steps: [
        makeStep({ step: { id: 1, description: 'Alpha task', files: [], acceptanceCriteria: [], dependsOn: [] } }),
        makeStep({ step: { id: 2, description: 'Beta task', files: [], acceptanceCriteria: [], dependsOn: [] } }),
      ],
    });
    render(<StepsPanel />);
    expect(screen.getByText('Alpha task')).toBeTruthy();
    expect(screen.getByText('Beta task')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// StepCard
// ---------------------------------------------------------------------------
describe('StepCard', () => {
  it('renders with correct CSS class for "complete" status', () => {
    const { container } = render(<StepCard stepState={makeStep({ status: 'complete' })} />);
    expect(container.querySelector('.step.complete')).toBeTruthy();
  });

  it('renders with correct CSS class for "coding" status', () => {
    const { container } = render(<StepCard stepState={makeStep({ status: 'coding' })} />);
    expect(container.querySelector('.step.coding')).toBeTruthy();
  });

  it('renders with correct CSS class for "reviewing" status', () => {
    const { container } = render(<StepCard stepState={makeStep({ status: 'reviewing' })} />);
    expect(container.querySelector('.step.reviewing')).toBeTruthy();
  });

  it('renders with correct CSS class for "pending" status', () => {
    const { container } = render(<StepCard stepState={makeStep({ status: 'pending' })} />);
    expect(container.querySelector('.step.pending')).toBeTruthy();
  });

  it('renders with correct CSS class for "escalated" status', () => {
    const { container } = render(<StepCard stepState={makeStep({ status: 'escalated' })} />);
    expect(container.querySelector('.step.escalated')).toBeTruthy();
  });

  it('shows uppercase status text', () => {
    render(<StepCard stepState={makeStep({ status: 'coding' })} />);
    expect(screen.getByText(/CODING/)).toBeTruthy();
  });

  it('shows step icon for each status', () => {
    // complete → ✓
    const { container: c1 } = render(<StepCard stepState={makeStep({ status: 'complete' })} />);
    expect(c1.textContent).toContain('\u2713');
    cleanup();

    // escalated → ⚠
    const { container: c2 } = render(<StepCard stepState={makeStep({ status: 'escalated' })} />);
    expect(c2.textContent).toContain('\u26A0');
    cleanup();

    // pending → ○
    const { container: c3 } = render(<StepCard stepState={makeStep({ status: 'pending' })} />);
    expect(c3.textContent).toContain('\u25CB');
  });

  it('shows description', () => {
    render(<StepCard stepState={makeStep({ step: { id: 1, description: 'My great task', files: [], acceptanceCriteria: [], dependsOn: [] } })} />);
    expect(screen.getByText('My great task')).toBeTruthy();
  });

  it('shows retry count badge when retryCount > 0', () => {
    render(<StepCard stepState={makeStep({ retryCount: 2 })} />);
    expect(screen.getByText('Retry 2/3')).toBeTruthy();
  });

  it('hides retry count when retryCount is 0', () => {
    const { container } = render(<StepCard stepState={makeStep({ retryCount: 0 })} />);
    expect(container.querySelector('.step-retry')).toBeNull();
  });

  it('clicking header expands the step (sets expandedStepId)', () => {
    const stepState = makeStep({ step: { id: 42, description: 'Expand me', files: [], acceptanceCriteria: [], dependsOn: [] } });
    const { container } = render(<StepCard stepState={stepState} />);
    expect(expandedStepId.value).toBeNull();
    const header = container.querySelector('.step-header') as HTMLElement;
    fireEvent.click(header);
    expect(expandedStepId.value).toBe(42);
  });

  it('clicking header again collapses the step (clears expandedStepId)', () => {
    const stepState = makeStep({ step: { id: 42, description: 'Expand me', files: [], acceptanceCriteria: [], dependsOn: [] } });
    expandedStepId.value = 42;
    const { container } = render(<StepCard stepState={stepState} />);
    const header = container.querySelector('.step-header') as HTMLElement;
    fireEvent.click(header);
    expect(expandedStepId.value).toBeNull();
  });

  it('shows StepDetail when expanded', () => {
    const stepState = makeStep({ step: { id: 7, description: 'Detail step', files: [], acceptanceCriteria: [], dependsOn: [] } });
    expandedStepId.value = 7;
    currentRun.value = makeRun({ steps: [stepState] });
    const { container } = render(<StepCard stepState={stepState} />);
    expect(container.querySelector('.step.expanded')).toBeTruthy();
    expect(container.querySelector('.step-detail')).toBeTruthy();
  });

  it('hides StepDetail when collapsed', () => {
    const stepState = makeStep({ step: { id: 7, description: 'Detail step', files: [], acceptanceCriteria: [], dependsOn: [] } });
    expandedStepId.value = null;
    const { container } = render(<StepCard stepState={stepState} />);
    expect(container.querySelector('.step-detail')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// StepDetail
// ---------------------------------------------------------------------------
describe('StepDetail', () => {
  it('shows blocking reasons for pending step with unmet dependencies', () => {
    const dep = makeStep({ step: { id: 1, description: 'Dep step', files: [], acceptanceCriteria: [], dependsOn: [] }, status: 'coding' });
    const s = makeStep({ step: { id: 2, description: 'Blocked step', files: [], acceptanceCriteria: [], dependsOn: [1] }, status: 'pending' });
    currentRun.value = makeRun({ steps: [dep, s] });
    render(<StepDetail stepState={s} />);
    expect(screen.getByText(/Waiting on step 1/)).toBeTruthy();
  });

  it('shows WIP limit blocking reason when WIP_LIMIT+ steps active', () => {
    const active = Array.from({ length: WIP_LIMIT }, (_, i) =>
      makeStep({ step: { id: i + 1, description: `Active ${i + 1}`, files: [], acceptanceCriteria: [], dependsOn: [] }, status: i === 0 ? 'reviewing' : 'coding' })
    );
    const pending = makeStep({ step: { id: WIP_LIMIT + 1, description: 'Pending', files: [], acceptanceCriteria: [], dependsOn: [] }, status: 'pending' });
    currentRun.value = makeRun({ steps: [...active, pending] });
    render(<StepDetail stepState={pending} />);
    expect(screen.getByText(/WIP limit reached/)).toBeTruthy();
  });

  it('does NOT show blocking section for non-pending steps', () => {
    const s = makeStep({ step: { id: 1, description: 'Coding step', files: [], acceptanceCriteria: [], dependsOn: [99] }, status: 'coding' });
    currentRun.value = makeRun({ steps: [s] });
    const { container } = render(<StepDetail stepState={s} />);
    expect(container.querySelector('.step-blocking')).toBeNull();
  });

  it('shows result section with summary and status class', () => {
    const s = makeStep({
      status: 'complete',
      result: { status: 'done', summary: 'All tests pass' },
    });
    currentRun.value = makeRun({ steps: [s] });
    const { container } = render(<StepDetail stepState={s} />);
    expect(screen.getByText('All tests pass')).toBeTruthy();
    expect(container.querySelector('.step-result-done')).toBeTruthy();
  });

  it('shows result details when present', () => {
    const s = makeStep({
      status: 'complete',
      result: { status: 'done', summary: 'Summary text', details: 'Extra detail info' },
    });
    currentRun.value = makeRun({ steps: [s] });
    render(<StepDetail stepState={s} />);
    expect(screen.getByText('Extra detail info')).toBeTruthy();
  });

  it('shows acceptance criteria with check marks when complete', () => {
    const s = makeStep({
      step: { id: 1, description: 'Step', files: [], acceptanceCriteria: ['Tests pass', 'Types check'], dependsOn: [] },
      status: 'complete',
    });
    currentRun.value = makeRun({ steps: [s] });
    const { container } = render(<StepDetail stepState={s} />);
    const checked = container.querySelectorAll('.step-criteria-check.checked');
    expect(checked.length).toBe(2);
    // Check marks (✓)
    expect(container.textContent).toContain('\u2713');
  });

  it('shows acceptance criteria with circles when not complete', () => {
    const s = makeStep({
      step: { id: 1, description: 'Step', files: [], acceptanceCriteria: ['Tests pass', 'Types check'], dependsOn: [] },
      status: 'coding',
    });
    currentRun.value = makeRun({ steps: [s] });
    const { container } = render(<StepDetail stepState={s} />);
    const unchecked = container.querySelectorAll('.step-criteria-check:not(.checked)');
    expect(unchecked.length).toBe(2);
    expect(container.textContent).toContain('\u25CB');
  });

  it('shows files list', () => {
    const s = makeStep({
      step: { id: 1, description: 'Step', files: ['src/foo.ts', 'src/bar.ts'], acceptanceCriteria: [], dependsOn: [] },
      status: 'coding',
    });
    currentRun.value = makeRun({ steps: [s] });
    render(<StepDetail stepState={s} />);
    expect(screen.getByText(/src\/foo\.ts/)).toBeTruthy();
    expect(screen.getByText(/src\/bar\.ts/)).toBeTruthy();
  });

  it('shows file conflict indicator when file conflicts exist', () => {
    const other = makeStep({
      step: { id: 2, description: 'Other coding step', files: ['src/shared.ts'], acceptanceCriteria: [], dependsOn: [] },
      status: 'coding',
      claimedFiles: ['src/shared.ts'],
    });
    const s = makeStep({
      step: { id: 1, description: 'This coding step', files: ['src/shared.ts'], acceptanceCriteria: [], dependsOn: [] },
      status: 'coding',
    });
    currentRun.value = makeRun({ steps: [other, s] });
    const { container } = render(<StepDetail stepState={s} />);
    // The file item should have conflict class
    expect(container.querySelector('.step-file-item.conflict')).toBeTruthy();
    expect(container.textContent).toContain('\u26A0 conflict');
  });

  it('shows dependencies with met/unmet status', () => {
    const dep = makeStep({ step: { id: 1, description: 'Dep step', files: [], acceptanceCriteria: [], dependsOn: [] }, status: 'complete' });
    const s = makeStep({ step: { id: 2, description: 'Child step', files: [], acceptanceCriteria: [], dependsOn: [1] }, status: 'coding' });
    currentRun.value = makeRun({ steps: [dep, s] });
    const { container } = render(<StepDetail stepState={s} />);
    expect(container.querySelector('.step-dep-item.met')).toBeTruthy();
    expect(container.textContent).toContain('complete');
  });

  it('shows dependency as unmet when dep step is not complete', () => {
    const dep = makeStep({ step: { id: 1, description: 'Dep step', files: [], acceptanceCriteria: [], dependsOn: [] }, status: 'coding' });
    const s = makeStep({ step: { id: 2, description: 'Child step', files: [], acceptanceCriteria: [], dependsOn: [1] }, status: 'pending' });
    currentRun.value = makeRun({ steps: [dep, s] });
    const { container } = render(<StepDetail stepState={s} />);
    expect(container.querySelector('.step-dep-item.unmet')).toBeTruthy();
  });

  it('shows timing section with started/completed/elapsed', () => {
    const s = makeStep({
      status: 'complete',
      startedAt: '2026-01-01T00:00:00Z',
      completedAt: '2026-01-01T00:01:30Z',
    });
    currentRun.value = makeRun({ steps: [s] });
    const { container } = render(<StepDetail stepState={s} />);
    expect(container.querySelector('.step-timing')).toBeTruthy();
    expect(screen.getByText('Started')).toBeTruthy();
    expect(screen.getByText('Completed')).toBeTruthy();
    expect(screen.getByText('Elapsed')).toBeTruthy();
    // elapsed = 90s = 1m 30s
    expect(container.textContent).toContain('1m 30s');
  });

  it('shows "(running)" for elapsed when no completedAt', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:45Z'));
    const s = makeStep({
      status: 'coding',
      startedAt: '2026-01-01T00:00:00Z',
    });
    currentRun.value = makeRun({ steps: [s] });
    const { container } = render(<StepDetail stepState={s} />);
    expect(container.textContent).toContain('(running)');
    vi.useRealTimers();
  });
});
