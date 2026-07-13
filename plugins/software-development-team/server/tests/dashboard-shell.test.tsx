import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import {
  allRuns, connectionStatus, currentRun, dataFreshness, lastSyncedAt, memoryEntries,
} from '../src/dashboard/client/state/store';
import type { RunState } from '../src/dashboard/client/state/store';

vi.mock('../src/dashboard/client/state/api', () => ({
  fetchRuns: vi.fn(),
  fetchMemory: vi.fn(),
  selectRun: vi.fn(),
  sendGuidance: vi.fn(),
}));
vi.mock('../src/dashboard/client/state/websocket', () => ({ connectWebSocket: vi.fn() }));

import { fetchMemory, fetchRuns, selectRun } from '../src/dashboard/client/state/api';
import { connectWebSocket } from '../src/dashboard/client/state/websocket';
import { App } from '../src/dashboard/client/app';
import { AsyncState } from '../src/dashboard/client/components/common/AsyncState';
import { WorkspaceNavigation } from '../src/dashboard/client/components/navigation/WorkspaceNavigation';

const run: RunState = {
  id: 'selected-run',
  task: 'Semantic dashboard shell',
  status: 'in_progress',
  steps: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:01:00Z',
};

beforeEach(() => {
  cleanup();
  allRuns.value = [];
  currentRun.value = null;
  memoryEntries.value = [];
  connectionStatus.value = 'connecting';
  dataFreshness.value = 'loading';
  lastSyncedAt.value = null;
  vi.clearAllMocks();
  vi.mocked(fetchRuns).mockResolvedValue([run]);
  vi.mocked(fetchMemory).mockResolvedValue([]);
  vi.mocked(selectRun).mockImplementation(async selected => {
    currentRun.value = selected;
    dataFreshness.value = 'fresh';
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('semantic dashboard shell', () => {
  it('exposes one coherent landmark hierarchy and deterministic focus targets', async () => {
    render(<App />);
    await screen.findByRole('main', { name: 'Selected run workspace' });

    expect(screen.getByRole('banner', { name: 'Run overview' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Runs' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Workspace views' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Plan Steps' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Activity Feed' })).toBeTruthy();
    expect(screen.getByRole('complementary', { name: 'Run Context' })).toBeTruthy();
    expect(connectWebSocket).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('link', { name: 'Skip to workspace' }));
    expect(document.activeElement).toBe(screen.getByRole('main'));

    fireEvent.click(screen.getByRole('link', { name: 'Activity' }));
    expect(document.activeElement).toBe(document.getElementById('activity-panel'));
  });

  it('preserves selected-run content behind an explicit stale-data notice', async () => {
    render(<App />);
    await screen.findByRole('main');
    dataFreshness.value = 'stale';
    expect(await screen.findByText(/Showing the last known data/)).toBeTruthy();
    expect(screen.getByRole('main')).toBeTruthy();
    expect(screen.getByText(/Selected run Semantic dashboard shell/)).toBeTruthy();
  });

  it('keeps the operator-selected run when a shell refresh returns multiple runs', async () => {
    const selected = { ...run, id: 'operator-selection', task: 'Keep this run selected' };
    allRuns.value = [selected];
    currentRun.value = selected;
    vi.mocked(fetchRuns).mockResolvedValue([run, selected]);
    render(<App />);
    await waitFor(() => expect(selectRun).toHaveBeenCalledWith(selected));
    expect(currentRun.value?.id).toBe('operator-selection');
  });

  it('renders an empty state rather than an ambiguous blank workspace', async () => {
    vi.mocked(fetchRuns).mockResolvedValue([]);
    render(<App />);
    expect(await screen.findByText('No runs are available yet.')).toBeTruthy();
    expect(screen.getByRole('main')).toBeTruthy();
    expect(screen.getByText('No active run')).toBeTruthy();
  });

  it('offers an explicit retry after bootstrap failure', async () => {
    vi.mocked(fetchRuns)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([run]);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await screen.findByRole('main');
    expect(fetchRuns).toHaveBeenCalledTimes(2);
    errorSpy.mockRestore();
  });
});

describe('shared async and adaptive navigation behavior', () => {
  it('keeps stale children while loading/error states have useful live semantics', () => {
    const { rerender } = render(<AsyncState state="loading"><p>content</p></AsyncState>);
    expect(screen.getByRole('status', { name: 'Dashboard: loading' })).toBeTruthy();
    rerender(<AsyncState state="error" onRetry={() => {}}><p>content</p></AsyncState>);
    expect(screen.getByRole('alert', { name: 'Dashboard: error' })).toBeTruthy();
    rerender(<AsyncState state="stale"><p>preserved content</p></AsyncState>);
    expect(screen.getByText('preserved content')).toBeTruthy();
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('uses a single navigation DOM and preserves navigation focus across layout changes', async () => {
    let layoutListener: (() => void) | undefined;
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: false,
      media: '(max-width: 900px)',
      addEventListener: (_type: string, listener: () => void) => { layoutListener = listener; },
      removeEventListener: vi.fn(),
    })));
    render(
      <>
        <WorkspaceNavigation />
        <section id="steps-panel" tabIndex={-1} />
        <section id="activity-panel" tabIndex={-1} />
        <aside id="status-panel" tabIndex={-1} />
      </>,
    );
    expect(screen.getAllByRole('navigation', { name: 'Workspace views' })).toHaveLength(1);
    const activity = screen.getByRole('link', { name: 'Activity' });
    activity.focus();
    layoutListener?.();
    await waitFor(() => expect(document.activeElement).toBe(activity));
    expect(activity.getAttribute('href')).toBe('#activity-panel');
  });

  it('does not steal input or control focus when the workspace layout changes', async () => {
    let layoutListener: (() => void) | undefined;
    const removeEventListener = vi.fn();
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: false,
      media: '(max-width: 900px)',
      addEventListener: (_type: string, listener: () => void) => { layoutListener = listener; },
      removeEventListener,
    })));
    const { unmount } = render(
      <>
        <WorkspaceNavigation />
        <label>Operator note<input /></label>
        <button type="button">Confirm control</button>
      </>,
    );

    const input = screen.getByRole('textbox', { name: 'Operator note' });
    input.focus();
    layoutListener?.();
    await Promise.resolve();
    expect(document.activeElement).toBe(input);

    const control = screen.getByRole('button', { name: 'Confirm control' });
    control.focus();
    layoutListener?.();
    await Promise.resolve();
    expect(document.activeElement).toBe(control);

    unmount();
    expect(removeEventListener).toHaveBeenCalledWith('change', layoutListener);
  });
});
