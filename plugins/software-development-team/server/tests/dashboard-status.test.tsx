import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/preact';
import {
  allRuns, currentRun, expandedStepId, memoryEntries,
  expandedMemoryKeys, currentFilter, messages, loadingRunId,
  connectionStatus, dataFreshness, lastSyncedAt,
} from '../src/dashboard/client/state/store';
import type { RunState, StepState, MemoryEntry } from '../src/dashboard/client/state/store';

// Mock api and websocket modules for App and GuidanceInput tests
vi.mock('../src/dashboard/client/state/api', () => ({
  selectRun: vi.fn(),
  fetchRuns: vi.fn().mockResolvedValue([]),
  fetchMessages: vi.fn().mockResolvedValue([]),
  fetchMemory: vi.fn().mockResolvedValue([]),
  sendGuidance: vi.fn().mockResolvedValue(true),
}));
vi.mock('../src/dashboard/client/state/websocket', () => ({
  connectWebSocket: vi.fn(),
}));

import { sendGuidance, fetchRuns } from '../src/dashboard/client/state/api';
import { connectWebSocket } from '../src/dashboard/client/state/websocket';

import { StatusPanel } from '../src/dashboard/client/components/status/StatusPanel';
import { AgentCard } from '../src/dashboard/client/components/status/AgentCard';
import { MemoryPanel } from '../src/dashboard/client/components/status/MemoryPanel';
import { MemoryGroup } from '../src/dashboard/client/components/status/MemoryGroup';
import { MemoryEntryCard } from '../src/dashboard/client/components/status/MemoryEntry';
import { GuidanceInput } from '../src/dashboard/client/components/status/GuidanceInput';
import { App } from '../src/dashboard/client/app';

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
  connectionStatus.value = 'online';
  dataFreshness.value = 'fresh';
  lastSyncedAt.value = new Date().toISOString();
  vi.clearAllMocks();
  vi.mocked(sendGuidance).mockReset().mockResolvedValue(true);
});

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
    steps: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:01:00Z',
    ...overrides,
  };
}

function makeMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    key: 'test-key',
    namespace: 'decisions',
    value: 'test value',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolver => { resolve = resolver; });
  return { promise, resolve };
}

// --- StatusPanel ---
describe('StatusPanel', () => {
  it('renders 6 agent cards (one for each agent)', () => {
    const { container } = render(<StatusPanel />);
    const agentCards = container.querySelectorAll('.agent-card');
    expect(agentCards.length).toBe(6);
  });

  it('renders "Shared Memory" heading', () => {
    render(<StatusPanel />);
    expect(screen.getByText('Shared Memory')).toBeTruthy();
  });

  it('renders GuidanceInput', () => {
    const { container } = render(<StatusPanel />);
    expect(container.querySelector('#guidance-input')).toBeTruthy();
  });

  it('provides keyboard-safe segmented navigation with active tab semantics', () => {
    currentRun.value = makeRun();
    render(<StatusPanel />);
    const agents = screen.getByRole('tab', { name: 'Agents' });
    const memory = screen.getByRole('tab', { name: 'Memory' });

    agents.focus();
    fireEvent.keyDown(agents, { key: 'ArrowRight' });

    expect(memory.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(memory);
    expect(screen.getByRole('tabpanel', { name: 'Memory' }).hidden).toBe(false);
  });

  it('does not move focus when selected-run state changes', () => {
    currentRun.value = makeRun({ id: 'run-a' });
    render(<StatusPanel />);
    const agents = screen.getByRole('tab', { name: 'Agents' });
    agents.focus();

    currentRun.value = makeRun({ id: 'run-b' });

    expect(document.activeElement).toBe(agents);
  });
});

// --- AgentCard ---
describe('AgentCard', () => {
  it('renders idle state when no active step', () => {
    currentRun.value = makeRun({ steps: [] });
    const { container } = render(<AgentCard agentName="coder" />);
    const card = container.querySelector('.agent-card');
    expect(card).toBeTruthy();
    expect(card!.className).toContain('idle');
  });

  it('shows "IDLE" badge for idle agent', () => {
    currentRun.value = makeRun({ steps: [] });
    render(<AgentCard agentName="coder" />);
    expect(screen.getByText('IDLE')).toBeTruthy();
  });

  it('shows "active" class and status badge when agent has active step', () => {
    currentRun.value = makeRun({
      steps: [makeStep({ assignedAgent: 'coder', status: 'coding' })],
    });
    const { container } = render(<AgentCard agentName="coder" />);
    const card = container.querySelector('.agent-card');
    expect(card!.className).toContain('active');
    expect(screen.getByText('CODING')).toBeTruthy();
  });

  it('shows step info with step ID and description for active agent', () => {
    currentRun.value = makeRun({
      steps: [makeStep({
        step: { id: 3, description: 'Do important work', files: [], acceptanceCriteria: [], dependsOn: [] },
        assignedAgent: 'coder',
        status: 'coding',
      })],
    });
    render(<AgentCard agentName="coder" />);
    expect(screen.getByText(/Step 3: Do important work/)).toBeTruthy();
  });

  it('shows "Orchestrating run\u2026" for coordinator when run is in_progress', () => {
    currentRun.value = makeRun({ status: 'in_progress', steps: [] });
    const { container } = render(<AgentCard agentName="coordinator" />);
    const stepInfo = container.querySelector('.agent-step-info');
    expect(stepInfo).toBeTruthy();
    expect(stepInfo!.textContent).toContain('Orchestrating selected run');
  });

  it('shows elapsed timer when active step has startedAt', () => {
    currentRun.value = makeRun({
      steps: [makeStep({
        assignedAgent: 'coder',
        status: 'coding',
        startedAt: new Date(Date.now() - 30000).toISOString(),
      })],
    });
    const { container } = render(<AgentCard agentName="coder" />);
    expect(container.querySelector('.agent-elapsed')).toBeTruthy();
    expect(screen.getByText('Elapsed:')).toBeTruthy();
  });

  it('shows last active time from messages', () => {
    currentRun.value = makeRun({ id: 'run-1' });
    messages.value = [
      {
        id: 'msg-1',
        runId: 'run-1',
        from: 'coder',
        to: 'coordinator',
        type: 'info',
        body: 'Working on it',
        timestamp: new Date(Date.now() - 5000).toISOString(),
      },
    ];
    render(<AgentCard agentName="coder" />);
    expect(screen.getByText(/Last recorded activity:/)).toBeTruthy();
  });

  it('timer ticks with fake timers — elapsed updates after 1000ms', () => {
    vi.useFakeTimers();
    // startedAt is 5 seconds before fake "now"
    const startedAt = new Date(Date.now() - 5000).toISOString();
    currentRun.value = makeRun({
      steps: [makeStep({
        assignedAgent: 'coder',
        status: 'coding',
        startedAt,
      })],
    });

    const { container } = render(<AgentCard agentName="coder" />);
    const elapsed1 = container.querySelector('.agent-elapsed')!.textContent;

    // Advance fake clock by 1 second — fires setInterval and moves Date.now() forward
    // Wrap in act() so Preact flushes its state updates to the DOM
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    const elapsed2 = container.querySelector('.agent-elapsed')!.textContent;
    // After 1s advance: elapsed goes from ~5s to ~6s
    expect(elapsed2).not.toBe(elapsed1);
    // Sanity: both are seconds-format strings
    expect(elapsed1).toMatch(/\d+s/);
    expect(elapsed2).toMatch(/\d+s/);

    vi.useRealTimers();
  });

  it('does not fabricate an active worker from a recent info message', () => {
    currentRun.value = makeRun({ steps: [] });
    messages.value = [{
      id: 'msg-1', runId: 'run-1', from: 'coder', to: 'coordinator',
      type: 'info', body: 'Working on it',
      timestamp: new Date(Date.now() - 60_000).toISOString(),
    }];
    const { container } = render(<AgentCard agentName="coder" />);
    expect(container.querySelector('.agent-card')!.className).toContain('idle');
    expect(screen.getByText('IDLE')).toBeTruthy();
    expect(screen.getByText(/Last recorded activity:/)).toBeTruthy();
  });

  it('stale info message (11 min ago) does NOT mark agent active', () => {
    currentRun.value = makeRun({ steps: [] });
    messages.value = [{
      id: 'msg-1', runId: 'run-1', from: 'coder', to: 'coordinator',
      type: 'info', body: 'Working on it',
      timestamp: new Date(Date.now() - 11 * 60_000).toISOString(),
    }];
    const { container } = render(<AgentCard agentName="coder" />);
    expect(container.querySelector('.agent-card')!.className).toContain('idle');
    expect(screen.getByText('IDLE')).toBeTruthy();
  });

  it('ignores messages from another run when reporting last activity', () => {
    currentRun.value = makeRun({ id: 'selected-run' });
    messages.value = [{
      id: 'msg-other', runId: 'other-run', from: 'coder', to: 'coordinator',
      type: 'info', body: 'Old work', timestamp: new Date().toISOString(),
    }];
    render(<AgentCard agentName="coder" />);
    expect(screen.queryByText(/Last recorded activity:/)).toBeNull();
    expect(screen.getByText('IDLE')).toBeTruthy();
  });

  it('uses semantic roster cards and lifecycle text as a non-color cue', () => {
    currentRun.value = makeRun({
      steps: [makeStep({ assignedAgent: 'researcher', status: 'coding' })],
    });
    render(<AgentCard agentName="researcher" />);
    expect(screen.getByRole('listitem', { name: 'researcher, coding' })).toBeTruthy();
    expect(screen.getByText('CODING')).toBeTruthy();
  });

  it('does not start a timer for message-only activity', () => {
    vi.useFakeTimers();
    currentRun.value = makeRun({ steps: [] });
    messages.value = [{
      id: 'msg-1', runId: 'run-1', from: 'coder', to: 'coordinator',
      type: 'info', body: 'Working on it',
      timestamp: new Date(Date.now() - (10 * 60_000 - 5_000)).toISOString(),
    }];
    const { container } = render(<AgentCard agentName="coder" />);
    expect(container.querySelector('.agent-card')!.className).toContain('idle');
    expect(vi.getTimerCount()).toBe(0);

    vi.useRealTimers();
  });
});

// --- MemoryPanel ---
describe('MemoryPanel', () => {
  it('shows "No shared memory entries yet" when empty', () => {
    memoryEntries.value = [];
    render(<MemoryPanel />);
    expect(screen.getByText(/No shared memory entries yet/)).toBeTruthy();
  });

  it('groups entries by namespace', () => {
    memoryEntries.value = [
      makeMemoryEntry({ namespace: 'decisions', key: 'k1', value: 'v1' }),
      makeMemoryEntry({ namespace: 'decisions', key: 'k2', value: 'v2' }),
      makeMemoryEntry({ namespace: 'context', key: 'k3', value: 'v3' }),
    ];
    const { container } = render(<MemoryPanel />);
    const groups = container.querySelectorAll('.memory-group');
    expect(groups.length).toBe(2);
  });

  it('follows NAMESPACE_ORDER for ordering', () => {
    memoryEntries.value = [
      makeMemoryEntry({ namespace: 'reflections', key: 'r1', value: 'r' }),
      makeMemoryEntry({ namespace: 'decisions', key: 'd1', value: 'd' }),
      makeMemoryEntry({ namespace: 'context', key: 'c1', value: 'c' }),
    ];
    const { container } = render(<MemoryPanel />);
    const badges = Array.from(container.querySelectorAll('.memory-ns-badge'));
    const namespaces = badges.map(b => b.textContent);
    // decisions comes before context which comes before reflections per NAMESPACE_ORDER
    expect(namespaces.indexOf('decisions')).toBeLessThan(namespaces.indexOf('context'));
    expect(namespaces.indexOf('context')).toBeLessThan(namespaces.indexOf('reflections'));
  });

  it('handles unknown namespaces (appends after known ones)', () => {
    memoryEntries.value = [
      makeMemoryEntry({ namespace: 'custom-ns', key: 'k1', value: 'v1' }),
      makeMemoryEntry({ namespace: 'decisions', key: 'k2', value: 'v2' }),
    ];
    const { container } = render(<MemoryPanel />);
    const badges = Array.from(container.querySelectorAll('.memory-ns-badge'));
    const namespaces = badges.map(b => b.textContent);
    // decisions (known) should come before custom-ns (unknown)
    expect(namespaces.indexOf('decisions')).toBeLessThan(namespaces.indexOf('custom-ns'));
  });

  it('renders loading, offline error, and stale-with-content resource states', () => {
    dataFreshness.value = 'loading';
    const { rerender } = render(<MemoryPanel />);
    expect(screen.getByLabelText('Shared memory: loading')).toBeTruthy();

    dataFreshness.value = 'fresh';
    connectionStatus.value = 'offline';
    rerender(<MemoryPanel />);
    expect(screen.getByLabelText('Shared memory: error')).toBeTruthy();

    memoryEntries.value = [makeMemoryEntry({ value: 'last known value' })];
    dataFreshness.value = 'stale';
    rerender(<MemoryPanel />);
    expect(screen.getByText('last known value')).toBeTruthy();
    expect(screen.getByText(/last-known shared memory/)).toBeTruthy();
  });
});

// --- MemoryGroup ---
describe('MemoryGroup', () => {
  it('renders namespace badge with namespace name', () => {
    const entries = [makeMemoryEntry({ namespace: 'decisions' })];
    render(<MemoryGroup namespace="decisions" entries={entries} />);
    expect(screen.getByText('decisions')).toBeTruthy();
  });

  it('shows entry count', () => {
    const entries = [
      makeMemoryEntry({ key: 'k1' }),
      makeMemoryEntry({ key: 'k2' }),
      makeMemoryEntry({ key: 'k3' }),
    ];
    const { container } = render(<MemoryGroup namespace="decisions" entries={entries} />);
    const countEl = container.querySelector('.memory-group-count');
    expect(countEl!.textContent).toBe('3');
  });

  it('renders MemoryEntryCard for each entry', () => {
    const entries = [
      makeMemoryEntry({ key: 'key-a', value: 'value a' }),
      makeMemoryEntry({ key: 'key-b', value: 'value b' }),
    ];
    const { container } = render(<MemoryGroup namespace="decisions" entries={entries} />);
    const entryEls = container.querySelectorAll('.memory-entry');
    expect(entryEls.length).toBe(2);
  });

  it('labels each namespace as a section and exposes its count', () => {
    const entries = [makeMemoryEntry({ key: 'one' }), makeMemoryEntry({ key: 'two' })];
    render(<MemoryGroup namespace="decisions" entries={entries} />);
    expect(screen.getByRole('region', { name: 'decisions' })).toBeTruthy();
    expect(screen.getByLabelText('2 entries')).toBeTruthy();
  });
});

// --- MemoryEntryCard ---
describe('MemoryEntryCard', () => {
  it('shows entry key and truncated value (100 chars + ellipsis)', () => {
    const longValue = 'a'.repeat(120);
    const entry = makeMemoryEntry({ key: 'my-key', value: longValue, namespace: 'decisions' });
    render(<MemoryEntryCard entry={entry} namespace="decisions" borderColor="red" />);
    expect(screen.getByText('my-key')).toBeTruthy();
    // Should show truncated text with ellipsis
    const valueEl = screen.getByText('a'.repeat(100) + '\u2026');
    expect(valueEl).toBeTruthy();
  });

  it('shows full value when short (<=100 chars)', () => {
    const shortValue = 'short value';
    const entry = makeMemoryEntry({ key: 'my-key', value: shortValue });
    render(<MemoryEntryCard entry={entry} namespace="decisions" borderColor="red" />);
    expect(screen.getByText('short value')).toBeTruthy();
  });

  it('shows "Show more" toggle for long values', () => {
    const longValue = 'b'.repeat(110);
    const entry = makeMemoryEntry({ value: longValue });
    render(<MemoryEntryCard entry={entry} namespace="decisions" borderColor="red" />);
    expect(screen.getByText('Show more')).toBeTruthy();
  });

  it('click toggles expandedMemoryKeys and shows full value', () => {
    const longValue = 'c'.repeat(110);
    const entry = makeMemoryEntry({ key: 'expand-key', value: longValue, namespace: 'decisions' });
    expandedMemoryKeys.value = new Set();

    render(<MemoryEntryCard entry={entry} namespace="decisions" borderColor="red" />);

    // Initially collapsed
    expect(expandedMemoryKeys.value.has('decisions:expand-key')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(expandedMemoryKeys.value.has('decisions:expand-key')).toBe(true);
    expect(screen.getByText(longValue)).toBeTruthy();
  });

  it('shows "Show less" when expanded', () => {
    const longValue = 'd'.repeat(110);
    const entry = makeMemoryEntry({ key: 'collapse-key', value: longValue, namespace: 'decisions' });
    expandedMemoryKeys.value = new Set(['decisions:collapse-key']);

    render(<MemoryEntryCard entry={entry} namespace="decisions" borderColor="red" />);
    expect(screen.getByText('Show less')).toBeTruthy();
  });

  it('renders memory as text and exposes native expand/copy controls', () => {
    const unsafeText = '<img src=x onerror=alert(1)>' + 'x'.repeat(100);
    const { container } = render(
      <MemoryEntryCard
        entry={makeMemoryEntry({ value: unsafeText })}
        namespace="decisions"
        borderColor="red"
      />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show more' }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('button', { name: 'Copy value' })).toBeTruthy();
  });
});

// --- GuidanceInput ---
describe('GuidanceInput', () => {
  it('renders input and send button', () => {
    const { container } = render(<GuidanceInput />);
    expect(container.querySelector('input[type="text"]')).toBeTruthy();
    expect(screen.getByText('Send')).toBeTruthy();
  });

  it('does not call sendGuidance when input is empty', () => {
    currentRun.value = makeRun();
    render(<GuidanceInput />);
    const button = screen.getByText('Send');
    fireEvent.click(button);
    expect(sendGuidance).not.toHaveBeenCalled();
  });

  it('does not call sendGuidance when no current run', () => {
    currentRun.value = null;
    const { container } = render(<GuidanceInput />);
    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'some guidance' } });
    // Directly set value since fireEvent.input may not set .value
    Object.defineProperty(input, 'value', { writable: true, value: 'some guidance' });
    const button = screen.getByText('Send');
    fireEvent.click(button);
    expect(sendGuidance).not.toHaveBeenCalled();
  });

  it('calls sendGuidance with runId and body on button click, clears input', async () => {
    currentRun.value = makeRun({ id: 'run-abc' });
    const { container } = render(<GuidanceInput />);
    const input = container.querySelector('input[type="text"]') as HTMLInputElement;

    fireEvent.input(input, { target: { value: 'help the team' } });
    const button = screen.getByText('Send');
    fireEvent.click(button);

    expect(sendGuidance).toHaveBeenCalledWith('run-abc', 'help the team');
    await waitFor(() => expect(input.value).toBe(''));
    expect(container.querySelector('.guidance-error')).toBeNull();
  });

  it('calls sendGuidance on Enter keypress', async () => {
    currentRun.value = makeRun({ id: 'run-xyz' });
    const { container } = render(<GuidanceInput />);
    const input = container.querySelector('input[type="text"]') as HTMLInputElement;

    fireEvent.input(input, { target: { value: 'enter guidance' } });
    fireEvent.submit(input.closest('form')!);

    expect(sendGuidance).toHaveBeenCalledWith('run-xyz', 'enter guidance');
    await waitFor(() => expect(input.value).toBe(''));
  });

  it('shows guidance-error and preserves input text when send fails', async () => {
    vi.mocked(sendGuidance).mockResolvedValueOnce(false);
    currentRun.value = makeRun({ id: 'run-abc' });
    const { container } = render(<GuidanceInput />);
    const input = container.querySelector('input[type="text"]') as HTMLInputElement;

    fireEvent.input(input, { target: { value: 'do not lose me' } });
    fireEvent.click(screen.getByText('Send'));

    await waitFor(() => expect(container.querySelector('.guidance-error')).toBeTruthy());
    // Input must NOT be cleared on failure — the user keeps their text.
    expect(input.value).toBe('do not lose me');
  });

  it('clears guidance-error on next typing', async () => {
    vi.mocked(sendGuidance).mockResolvedValueOnce(false);
    currentRun.value = makeRun({ id: 'run-abc' });
    const { container } = render(<GuidanceInput />);
    const input = container.querySelector('input[type="text"]') as HTMLInputElement;

    fireEvent.input(input, { target: { value: 'first try' } });
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => expect(container.querySelector('.guidance-error')).toBeTruthy());

    fireEvent.input(input, { target: { value: 'first try again' } });
    await waitFor(() => expect(container.querySelector('.guidance-error')).toBeNull());
  });

  it('clears guidance-error on next successful send', async () => {
    vi.mocked(sendGuidance).mockResolvedValueOnce(false);
    currentRun.value = makeRun({ id: 'run-abc' });
    const { container } = render(<GuidanceInput />);
    const input = container.querySelector('input[type="text"]') as HTMLInputElement;

    fireEvent.input(input, { target: { value: 'retry me' } });
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => expect(container.querySelector('.guidance-error')).toBeTruthy());

    // Second send succeeds (default mockResolvedValue(true)).
    fireEvent.click(screen.getByText('Try again'));
    await waitFor(() => expect(container.querySelector('.guidance-error')).toBeNull());
    expect(input.value).toBe('');
  });

  it('names the exact target run and explains offline/loading/stale disabled states', () => {
    currentRun.value = makeRun({ id: 'run-target', task: 'Upgrade dashboard' });
    connectionStatus.value = 'offline';
    const { rerender } = render(<GuidanceInput />);
    expect(screen.getByText('run-target')).toBeTruthy();
    expect(screen.getByText(/offline/)).toBeTruthy();
    expect((screen.getByRole('textbox') as HTMLInputElement).disabled).toBe(true);

    connectionStatus.value = 'online';
    dataFreshness.value = 'loading';
    rerender(<GuidanceInput />);
    expect(screen.getByText(/data loads/)).toBeTruthy();

    dataFreshness.value = 'stale';
    rerender(<GuidanceInput />);
    expect(screen.getByText(/Refresh stale run data/)).toBeTruthy();
  });

  it('keeps separate drafts when the selected run changes and retains focus', () => {
    currentRun.value = makeRun({ id: 'run-a' });
    render(<GuidanceInput />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    input.focus();
    fireEvent.input(input, { target: { value: 'draft for A' } });

    act(() => { currentRun.value = makeRun({ id: 'run-b' }); });
    expect(input.value).toBe('');
    expect(document.activeElement).toBe(input);
    fireEvent.input(input, { target: { value: 'draft for B' } });

    act(() => { currentRun.value = makeRun({ id: 'run-a' }); });
    expect(input.value).toBe('draft for A');
    act(() => { currentRun.value = makeRun({ id: 'run-b' }); });
    expect(input.value).toBe('draft for B');
  });

  it('enforces single-flight submission without clearing edits made while pending', async () => {
    const request = deferred<boolean>();
    vi.mocked(sendGuidance).mockReturnValueOnce(request.promise);
    currentRun.value = makeRun({ id: 'run-one' });
    render(<GuidanceInput />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    input.focus();
    fireEvent.input(input, { target: { value: 'first draft' } });
    const form = input.closest('form')!;

    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(sendGuidance).toHaveBeenCalledTimes(1);
    fireEvent.input(input, { target: { value: 'newer draft' } });
    await act(async () => {
      request.resolve(true);
      await request.promise;
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Guidance sent'));
    expect(input.value).toBe('newer draft');
    expect(document.activeElement).toBe(input);
  });

  it('does not apply a completed response to a newly selected run', async () => {
    const request = deferred<boolean>();
    vi.mocked(sendGuidance).mockReturnValueOnce(request.promise);
    currentRun.value = makeRun({ id: 'run-a' });
    render(<GuidanceInput />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'send A' } });
    fireEvent.submit(input.closest('form')!);

    act(() => { currentRun.value = makeRun({ id: 'run-b' }); });
    fireEvent.input(input, { target: { value: 'keep B' } });
    await act(async () => {
      request.resolve(true);
      await request.promise;
      await Promise.resolve();
    });

    expect(input.value).toBe('keep B');
    expect(screen.queryByText(/Guidance sent to run run-a/)).toBeNull();
    act(() => { currentRun.value = makeRun({ id: 'run-a' }); });
    expect(input.value).toBe('');
    expect(screen.getByText(/Guidance sent to run run-a/)).toBeTruthy();
  });
});

// --- App ---
describe('App', () => {
  it('renders all 3 panel sections (steps, activity, status)', () => {
    const { container } = render(<App />);
    expect(container.querySelector('#steps-panel')).toBeTruthy();
    expect(container.querySelector('#activity-panel')).toBeTruthy();
    expect(container.querySelector('#status-panel')).toBeTruthy();
  });

  it('calls fetchRuns on mount', async () => {
    render(<App />);
    await waitFor(() => {
      expect(fetchRuns).toHaveBeenCalled();
    });
  });

  it('calls connectWebSocket on mount', async () => {
    render(<App />);
    await waitFor(() => {
      expect(connectWebSocket).toHaveBeenCalled();
    });
  });
});
