import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/preact';
import {
  allRuns, currentRun, expandedStepId, memoryEntries,
  expandedMemoryKeys, currentFilter, messages, loadingRunId,
} from '../src/dashboard/client/state/store';
import type { RunState, StepState } from '../src/dashboard/client/state/store';

vi.mock('../src/dashboard/client/state/api', () => ({
  selectRun: vi.fn(),
  fetchRuns: vi.fn(),
  fetchMessages: vi.fn(),
  fetchMemory: vi.fn(),
  sendGuidance: vi.fn(),
}));

import { selectRun } from '../src/dashboard/client/state/api';

// Lazily import components after mocks are established
import { Header } from '../src/dashboard/client/components/header/Header';
import { ProgressBar } from '../src/dashboard/client/components/header/ProgressBar';
import { RunSelector } from '../src/dashboard/client/components/header/RunSelector';

function makeStep(overrides: Partial<StepState> = {}): StepState {
  return {
    step: { id: 1, description: 'Test step', files: [], acceptanceCriteria: [], dependsOn: [] },
    status: 'pending',
    retryCount: 0,
    assignedAgent: null,
    result: null,
    claimedFiles: [],
    consecutiveSameError: 0,
    ...overrides,
  };
}

function makeRun(overrides: Partial<RunState> = {}): RunState {
  return {
    id: 'run-1',
    status: 'in_progress',
    steps: [
      makeStep({ status: 'complete' }),
      makeStep({
        step: { id: 2, description: 'Step 2', files: [], acceptanceCriteria: [], dependsOn: [] },
        status: 'coding',
      }),
    ],
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
  vi.clearAllMocks();
});

describe('Header', () => {
  it('renders title "Claude Coding Team" when no run', () => {
    render(<Header />);
    expect(screen.getByText('Claude Coding Team')).toBeTruthy();
  });

  it('shows badge with "hidden" class when no run', () => {
    const { container } = render(<Header />);
    const badge = container.querySelector('.badge');
    expect(badge).toBeTruthy();
    expect(badge!.className).toContain('hidden');
  });

  it('shows badge with correct status text and "running" class when run is in_progress', () => {
    currentRun.value = makeRun({ status: 'in_progress' });
    allRuns.value = [currentRun.value];
    const { container } = render(<Header />);
    const badge = container.querySelector('.badge');
    expect(badge).toBeTruthy();
    expect(badge!.className).toContain('running');
    expect(badge!.textContent).toBe('IN_PROGRESS');
  });

  it('shows badge with "complete" class when run is complete', () => {
    currentRun.value = makeRun({ status: 'complete' });
    allRuns.value = [currentRun.value];
    const { container } = render(<Header />);
    const badge = container.querySelector('.badge');
    expect(badge).toBeTruthy();
    expect(badge!.className).toContain('complete');
    expect(badge!.textContent).toBe('COMPLETE');
  });

  it('shows run info with step count', () => {
    const run = makeRun();
    currentRun.value = run;
    allRuns.value = [run];
    render(<Header />);
    // 1 of 2 steps is complete
    expect(screen.getByText(/Step 1\/2/)).toBeTruthy();
  });

  it('shows retries in run info when retries > 0', () => {
    const run = makeRun({
      steps: [
        makeStep({ status: 'complete', retryCount: 2 }),
        makeStep({
          step: { id: 2, description: 'Step 2', files: [], acceptanceCriteria: [], dependsOn: [] },
          status: 'coding',
          retryCount: 1,
        }),
      ],
    });
    currentRun.value = run;
    allRuns.value = [run];
    render(<Header />);
    expect(screen.getByText(/3 retries/)).toBeTruthy();
  });
});

describe('ProgressBar', () => {
  it('is hidden when no run', () => {
    const { container } = render(<ProgressBar />);
    const el = container.querySelector('.progress-bar-container');
    expect(el).toBeTruthy();
    expect(el!.className).toContain('hidden');
  });

  it('is hidden when total steps is 0', () => {
    currentRun.value = makeRun({ steps: [] });
    const { container } = render(<ProgressBar />);
    const el = container.querySelector('.progress-bar-container');
    expect(el).toBeTruthy();
    expect(el!.className).toContain('hidden');
  });

  it('shows correct label "2/5" for 2 complete of 5 total', () => {
    currentRun.value = makeRun({
      steps: [
        makeStep({ status: 'complete' }),
        makeStep({ step: { id: 2, description: 'S2', files: [], acceptanceCriteria: [], dependsOn: [] }, status: 'complete' }),
        makeStep({ step: { id: 3, description: 'S3', files: [], acceptanceCriteria: [], dependsOn: [] }, status: 'coding' }),
        makeStep({ step: { id: 4, description: 'S4', files: [], acceptanceCriteria: [], dependsOn: [] }, status: 'pending' }),
        makeStep({ step: { id: 5, description: 'S5', files: [], acceptanceCriteria: [], dependsOn: [] }, status: 'pending' }),
      ],
    });
    render(<ProgressBar />);
    expect(screen.getByText('2/5')).toBeTruthy();
  });

  it('fill width matches percentage (40% for 2/5)', () => {
    currentRun.value = makeRun({
      steps: [
        makeStep({ status: 'complete' }),
        makeStep({ step: { id: 2, description: 'S2', files: [], acceptanceCriteria: [], dependsOn: [] }, status: 'complete' }),
        makeStep({ step: { id: 3, description: 'S3', files: [], acceptanceCriteria: [], dependsOn: [] }, status: 'coding' }),
        makeStep({ step: { id: 4, description: 'S4', files: [], acceptanceCriteria: [], dependsOn: [] }, status: 'pending' }),
        makeStep({ step: { id: 5, description: 'S5', files: [], acceptanceCriteria: [], dependsOn: [] }, status: 'pending' }),
      ],
    });
    const { container } = render(<ProgressBar />);
    const fill = container.querySelector('.progress-bar-fill') as HTMLElement | null;
    expect(fill).toBeTruthy();
    expect(fill!.style.width).toBe('40%');
  });
});

describe('RunSelector', () => {
  it('returns null when there are 0 runs', () => {
    allRuns.value = [];
    const { container } = render(<RunSelector />);
    expect(container.querySelector('select')).toBeNull();
  });

  it('returns null when there is only 1 run', () => {
    allRuns.value = [makeRun()];
    currentRun.value = allRuns.value[0];
    const { container } = render(<RunSelector />);
    expect(container.querySelector('select')).toBeNull();
  });

  it('renders select with options when multiple runs', () => {
    const run1 = makeRun({ id: 'run-1', status: 'complete' });
    const run2 = makeRun({ id: 'run-2', status: 'in_progress' });
    allRuns.value = [run1, run2];
    currentRun.value = run1;
    const { container } = render(<RunSelector />);
    const select = container.querySelector('select');
    expect(select).toBeTruthy();
    const options = container.querySelectorAll('option');
    expect(options.length).toBe(2);
  });

  it('options show run labels and status', () => {
    const run1 = makeRun({ id: 'run-1', status: 'complete' });
    const run2 = makeRun({ id: 'run-2', status: 'in_progress' });
    allRuns.value = [run1, run2];
    currentRun.value = run1;
    const { container } = render(<RunSelector />);
    const options = Array.from(container.querySelectorAll('option'));
    // First option: run1 label and status
    expect(options[0].textContent).toContain('complete');
    // Second option: run2 label and status
    expect(options[1].textContent).toContain('in_progress');
  });

  it('calls selectRun on change', () => {
    const run1 = makeRun({ id: 'run-1', status: 'complete' });
    const run2 = makeRun({ id: 'run-2', status: 'in_progress' });
    allRuns.value = [run1, run2];
    currentRun.value = run1;
    const { container } = render(<RunSelector />);
    const select = container.querySelector('select') as HTMLSelectElement;
    expect(select).toBeTruthy();
    fireEvent.change(select, { target: { value: 'run-2' } });
    expect(selectRun).toHaveBeenCalledWith(run2);
  });
});
