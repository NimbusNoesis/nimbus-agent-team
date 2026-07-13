import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import {
  allRuns,
  connectionStatus,
  controlOperations,
  currentRun,
  dataFreshness,
  loadingRunId,
} from '../src/dashboard/client/state/store';
import type {
  ExecutionControlCapabilities,
  RunControlPhase,
  RunState,
  StepState,
} from '../src/dashboard/client/state/store';
import { RunControls } from '../src/dashboard/client/components/controls/RunControls';
import { StepControls } from '../src/dashboard/client/components/controls/StepControls';
import { ControlConfirmationDialog } from '../src/dashboard/client/components/controls/ControlConfirmationDialog';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const capabilities: ExecutionControlCapabilities = {
  pause_run: true,
  resume_run: true,
  cancel_run: true,
  cancel_step: true,
  retry_step: true,
  acknowledge_pause: true,
  acknowledge_cancel: true,
};

function makeStep(overrides: Partial<StepState> = {}): StepState {
  return {
    step: { id: 1, description: 'Build controls', files: ['src/control.ts'], acceptanceCriteria: [], dependsOn: [] },
    status: 'pending', retryCount: 0, assignedAgent: null, result: null,
    claimedFiles: [], consecutiveSameError: 0,
    ...overrides,
  };
}

function makeRun(
  phase: RunControlPhase = 'none',
  overrides: Partial<RunState> = {},
  supported: Partial<ExecutionControlCapabilities> = {},
): RunState {
  return {
    id: 'run-ui', status: 'in_progress', steps: [makeStep()],
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:01:00Z',
    lifecycle: {
      version: 2, capabilities: { ...capabilities, ...supported }, controlPhase: phase,
      revision: 4, commandReceipts: [], history: [],
    },
    ...overrides,
  };
}

function select(run: RunState) {
  allRuns.value = [run];
  currentRun.value = run;
}

function successResponse(run: RunState, action: 'cancel_run' | 'retry_step' = 'cancel_run') {
  const target = action === 'retry_step' ? { kind: 'step' as const, stepId: 1 } : { kind: 'run' as const };
  run.lifecycle!.revision = 5;
  return {
    success: true,
    replayed: false,
    receipt: {
      commandId: '11111111-1111-4111-8111-111111111111', fingerprint: 'f', action, target,
      expectedRevision: 4, revision: 5, recordedAt: '2026-01-01T00:02:00Z',
      outcome: { controlPhase: run.lifecycle!.controlPhase, runStatus: run.status },
    },
    run,
  };
}

beforeEach(() => {
  cleanup();
  mockFetch.mockReset();
  allRuns.value = [];
  currentRun.value = null;
  connectionStatus.value = 'online';
  dataFreshness.value = 'fresh';
  loadingRunId.value = null;
  controlOperations.value = {};
});

afterEach(() => cleanup());

describe('RunControls', () => {
  it('renders only advertised operator actions and never exposes coordinator acknowledgements', () => {
    select(makeRun('none', {}, { resume_run: false }));
    render(<RunControls />);
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel run' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
    expect(screen.queryByText(/acknowledge/i)).toBeNull();
  });

  it.each([
    ['pausing', /Pausing admissions.*1 active worker draining.*1 file claim.*not force-stopped/i],
    ['paused', /Paused.*No new workers are admitted/i],
    ['cancelling', /Cancelling.*active worker draining.*claims remain held.*not force-stopped/i],
  ] as const)('uses truthful %s lifecycle language', (phase, expected) => {
    select(makeRun(phase, { steps: [makeStep({ status: 'coding', assignedAgent: 'coder', claimedFiles: ['src/control.ts'] })] }));
    render(<RunControls />);
    expect(screen.getByText(expected)).toBeTruthy();
  });

  it.each([
    ['complete', 'none'],
    ['cancelled', 'cancelled'],
  ] as const)('makes a %s run visibly immutable and disables every action', (status, phase) => {
    select(makeRun(phase, { status }));
    const { container } = render(<RunControls />);
    expect(screen.getByText(new RegExp(`${status}.*terminal and immutable`, 'i'))).toBeTruthy();
    for (const button of container.querySelectorAll('button')) expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('requires the exact run target phrase, enforces the reason limit, and describes consequences', () => {
    select(makeRun());
    render(<RunControls />);
    const opener = screen.getByRole('button', { name: 'Cancel run' });
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Cancel run run-ui' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByText(/active workers drain without force-kill/i)).toBeTruthy();
    const reason = screen.getByLabelText(/Reason/) as HTMLTextAreaElement;
    expect(reason.maxLength).toBe(500);
    const submit = screen.getByRole('button', { name: 'Cancel this run' }) as HTMLButtonElement;
    const confirmation = screen.getByLabelText(/Type cancel run run-ui/) as HTMLInputElement;
    fireEvent.input(confirmation, { target: { value: 'cancel run wrong' } });
    expect(submit.disabled).toBe(true);
    fireEvent.input(confirmation, { target: { value: 'cancel run run-ui' } });
    expect(submit.disabled).toBe(false);
  });

  it('traps focus, marks background inert, closes on Escape, and restores the opener focus', async () => {
    const background = document.createElement('section');
    background.id = 'activity-panel';
    document.body.append(background);
    select(makeRun());
    render(<RunControls />);
    const opener = screen.getByRole('button', { name: 'Cancel run' }) as HTMLButtonElement;
    opener.focus();
    fireEvent.click(opener);
    expect(background.hasAttribute('inert')).toBe(true);
    expect(background.getAttribute('aria-hidden')).toBe('true');

    const cancel = screen.getByRole('button', { name: 'Keep working' }) as HTMLButtonElement;
    const reason = screen.getByLabelText(/Reason/) as HTMLTextAreaElement;
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(cancel, { key: 'Tab' });
    expect(document.activeElement).toBe(reason);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(opener);
    expect(background.hasAttribute('inert')).toBe(false);
    expect(background.hasAttribute('aria-hidden')).toBe(false);
    background.remove();
  });

  it('keeps shared background isolated until the last independent dialog closes', () => {
    const preserved = document.createElement('section');
    preserved.setAttribute('aria-hidden', 'menu');
    preserved.setAttribute('inert', 'locked');
    const ordinary = document.createElement('section');
    document.body.append(preserved, ordinary);
    const intent = {
      action: 'pause_run' as const,
      target: { kind: 'run' as const },
      title: 'Pause test run',
      submitLabel: 'Pause admissions',
      consequence: 'No new work is admitted.',
    };
    const firstOpener = document.createElement('button');
    const secondOpener = document.createElement('button');
    document.body.append(firstOpener, secondOpener);

    const first = render(
      <ControlConfirmationDialog intent={intent} pending={false} opener={firstOpener} onCancel={() => {}} onConfirm={() => {}} />,
    );
    const second = render(
      <ControlConfirmationDialog intent={intent} pending={false} opener={secondOpener} onCancel={() => {}} onConfirm={() => {}} />,
    );
    const cancelButtons = screen.getAllByRole('button', { name: 'Keep working', hidden: true });
    expect(document.activeElement).toBe(cancelButtons[1]);

    first.unmount();
    expect(preserved.getAttribute('aria-hidden')).toBe('true');
    expect(preserved.hasAttribute('inert')).toBe(true);
    expect(ordinary.getAttribute('aria-hidden')).toBe('true');
    expect(document.activeElement).toBe(cancelButtons[1]);

    second.unmount();
    expect(preserved.getAttribute('aria-hidden')).toBe('menu');
    expect(preserved.getAttribute('inert')).toBe('locked');
    expect(ordinary.hasAttribute('aria-hidden')).toBe(false);
    expect(ordinary.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(secondOpener);
    preserved.remove();
    ordinary.remove();
    firstOpener.remove();
    secondOpener.remove();
  });

  it('submits a destructive command only once while pending and announces success', async () => {
    const run = makeRun();
    select(run);
    let resolveFetch!: (value: unknown) => void;
    mockFetch.mockReturnValue(new Promise(resolve => { resolveFetch = resolve; }));
    render(<RunControls />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel run' }));
    fireEvent.input(screen.getByLabelText(/Type cancel run run-ui/), { target: { value: 'cancel run run-ui' } });
    const submit = screen.getByRole('button', { name: 'Cancel this run' });
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    resolveFetch({ ok: true, json: () => Promise.resolve(successResponse(makeRun())) });
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/revision 5/i));
  });

  it('does not replay a 409 and requires a fresh open and empty confirmation', async () => {
    select(makeRun());
    mockFetch
      .mockResolvedValueOnce({
        ok: false, status: 409,
        json: () => Promise.resolve({ error: { code: 'revision_conflict', message: 'Run changed' } }),
      })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([makeRun('none')]) });
    render(<RunControls />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel run' }));
    fireEvent.input(screen.getByLabelText(/Type cancel run run-ui/), { target: { value: 'cancel run run-ui' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel this run' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/refreshed.*confirm again/i));
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel run' }));
    const freshConfirmation = screen.getByLabelText(/Type cancel run run-ui/) as HTMLInputElement;
    expect(freshConfirmation.value).toBe('');
    expect((screen.getByRole('button', { name: 'Cancel this run' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('announces a structured non-conflict error and leaves a deliberate retry available', async () => {
    select(makeRun());
    mockFetch.mockResolvedValue({
      ok: false, status: 400,
      json: () => Promise.resolve({ error: { code: 'invalid_reason', message: 'Reason was rejected' } }),
    });
    render(<RunControls />);
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pause admissions' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Reason was rejected'));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('button', { name: 'Pause' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('surfaces offline, stale, loading, phase, and per-target pending disabled reasons', () => {
    const run = makeRun();
    select(run);
    connectionStatus.value = 'offline';
    const { rerender } = render(<RunControls />);
    expect(screen.getAllByText(/dashboard is offline/i).length).toBeGreaterThan(0);
    connectionStatus.value = 'online';
    dataFreshness.value = 'stale';
    rerender(<RunControls />);
    expect(screen.getAllByText(/stale/i).length).toBeGreaterThan(0);
    dataFreshness.value = 'fresh';
    loadingRunId.value = run.id;
    rerender(<RunControls />);
    expect(screen.getAllByText(/still loading/i).length).toBeGreaterThan(0);
  });
});

describe('StepControls', () => {
  it('offers eligible escalated retry and exact-target cancellation with touch/narrow semantic hooks', () => {
    const step = makeStep({
      status: 'escalated', manualAttempt: 1,
      worktree: { branch: 'team-run-step-1', path: '/tmp/step-1', targetBranch: 'main', targetCommit: 'abc' },
    });
    select(makeRun('none', { steps: [step] }));
    const { container } = render(<StepControls stepState={step} />);
    expect(container.querySelector('[data-control-scope="step"]')).toBeTruthy();
    expect(container.querySelector('[data-control-action="retry_step"]')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Retry step' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel step' }));
    expect(screen.getByText(/dependent steps remain pending.*independent work can continue/i)).toBeTruthy();
    const submit = screen.getByRole('button', { name: 'Cancel this step' });
    fireEvent.input(screen.getByLabelText(/Type cancel step run-ui\/1/), { target: { value: 'cancel step run-ui/1' } });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows retry eligibility reasons and terminal step immutability', () => {
    const step = makeStep({ status: 'complete' });
    select(makeRun('none', { steps: [step] }));
    render(<StepControls stepState={step} />);
    expect((screen.getByRole('button', { name: 'Retry step' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Only an escalated step can be retried/i)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Cancel step' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/already terminal or cancelling/i)).toBeTruthy();
    expect(screen.queryByText(/acknowledge/i)).toBeNull();
  });

  it('sends an eligible retry once with the step target and current lifecycle revision', async () => {
    const step = makeStep({
      status: 'escalated',
      worktree: { branch: 'team-run-step-1', path: '/tmp/step-1', targetBranch: 'main', targetCommit: 'abc' },
    });
    select(makeRun('none', { steps: [step] }));
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(successResponse(makeRun('none', { steps: [step] }), 'retry_step')) });
    render(<StepControls stepState={step} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry step' }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry escalated step' }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toMatchObject({ action: 'retry_step', target: { kind: 'step', stepId: 1 }, expectedRevision: 4 });
    expect(body).not.toHaveProperty('confirmation');
  });
});
