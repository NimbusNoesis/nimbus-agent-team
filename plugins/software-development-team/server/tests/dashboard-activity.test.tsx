import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/preact';
import {
  allRuns,
  connectionStatus,
  currentFilter,
  currentRun,
  dataFreshness,
  lastSyncedAt,
  loadingRunId,
  messages,
} from '../src/dashboard/client/state/store';
import type {
  LifecycleHistoryEntry,
  Message,
  RunState,
} from '../src/dashboard/client/state/store';
import type { ActivityItem } from '../src/dashboard/client/components/activity/MessageCard';
import { FilterBar } from '../src/dashboard/client/components/activity/FilterBar';
import { MessageCard } from '../src/dashboard/client/components/activity/MessageCard';
import {
  buildActivityItems,
  MessageList,
} from '../src/dashboard/client/components/activity/MessageList';
import { ActivityPanel } from '../src/dashboard/client/components/activity/ActivityPanel';

function makeRun(history: LifecycleHistoryEntry[] = [], id = 'r1'): RunState {
  return {
    id,
    task: 'Improve the dashboard',
    status: 'in_progress',
    steps: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:02:00Z',
    lifecycle: {
      version: 2,
      capabilities: {
        pause_run: true,
        resume_run: true,
        cancel_run: true,
        cancel_step: true,
        retry_step: true,
        acknowledge_pause: true,
        acknowledge_cancel: true,
      },
      controlPhase: 'none',
      revision: history.at(-1)?.revision ?? 0,
      commandReceipts: [],
      history,
    },
  };
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    runId: 'r1',
    from: 'coder',
    to: 'all',
    type: 'info',
    body: 'test message',
    timestamp: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeHistory(overrides: Partial<LifecycleHistoryEntry> = {}): LifecycleHistoryEntry {
  return {
    commandId: 'command-1',
    action: 'pause_run',
    target: { kind: 'run' },
    revision: 1,
    recordedAt: '2026-01-01T00:01:00Z',
    fromPhase: 'none',
    toPhase: 'pausing',
    summary: 'private operator reason that must not render',
    ...overrides,
  };
}

function makeActivity(id: string, timestamp: string, type: ActivityItem['type'] = 'info'): ActivityItem {
  return {
    key: `message:${id}`,
    kind: 'message',
    runId: 'r1',
    actor: 'coder',
    recipient: 'all',
    type,
    body: id,
    timestamp,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  cleanup();
  const run = makeRun();
  allRuns.value = [run];
  currentRun.value = run;
  currentFilter.value = 'all';
  messages.value = [];
  loadingRunId.value = null;
  connectionStatus.value = 'online';
  dataFreshness.value = 'fresh';
  lastSyncedAt.value = '2026-01-01T00:02:00Z';
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('FilterBar', () => {
  it('exposes native pressed controls, counts, and the control audit category', () => {
    render(<FilterBar counts={{ all: 3, info: 2, control: 1 }} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(7);
    expect(screen.getByRole('button', { name: 'All activity, 3' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'control activity, 1' })).toBeTruthy();
  });

  it('keeps selection until changed and offers a clear-filter control', () => {
    currentFilter.value = 'review';
    const { rerender } = render(<FilterBar counts={{ all: 2, review: 1 }} />);
    expect(screen.getByRole('button', { name: 'review activity, 1' }).getAttribute('aria-pressed')).toBe('true');
    rerender(<FilterBar counts={{ all: 5, review: 2 }} />);
    expect(currentFilter.value).toBe('review');
    fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }));
    expect(currentFilter.value).toBe('all');
  });

  it('uses ordinary buttons for keyboard activation', () => {
    render(<FilterBar counts={{ all: 1, escalation: 1 }} />);
    const escalation = screen.getByRole('button', { name: 'escalation activity, 1' });
    escalation.focus();
    fireEvent.click(escalation);
    expect(currentFilter.value).toBe('escalation');
    expect(document.activeElement).toBe(escalation);
  });
});

describe('activity model', () => {
  it('dedupes message ids and control command/revisions, then orders chronologically', () => {
    const items = buildActivityItems(
      [
        makeMessage({ id: 'later', timestamp: '2026-01-01T00:03:00Z' }),
        makeMessage({ id: 'same', body: 'old' }),
        makeMessage({ id: 'same', body: 'new' }),
      ],
      [makeHistory(), makeHistory()],
      'r1',
    );
    expect(items.map(item => item.key)).toEqual([
      'message:same',
      'control:command-1:1',
      'message:later',
    ]);
    expect(items[0].body).toBe('new');
  });

  it('reconstructs equal-revision audit entries once after reconnect', () => {
    const first = makeHistory({ commandId: 'first', revision: 2 });
    const second = makeHistory({ commandId: 'second', revision: 2, recordedAt: first.recordedAt });
    const items = buildActivityItems([], [second, first, second], 'r1');
    expect(items.map(item => item.key)).toEqual(['control:first:2', 'control:second:2']);
  });

  it('orders equivalent timestamp formats by their actual instant', () => {
    const items = buildActivityItems([
      makeMessage({ id: 'later', timestamp: '2026-01-01T01:00:00+00:00' }),
      makeMessage({ id: 'earlier', timestamp: '2026-01-01T01:30:00+01:00' }),
    ], [], 'r1');
    expect(items.map(item => item.key)).toEqual(['message:earlier', 'message:later']);
  });

  it('uses a safe standardized control summary and omits supplied reasons', () => {
    const [item] = buildActivityItems([], [makeHistory({
      action: 'cancel_step',
      target: { kind: 'step', stepId: 7 },
      toPhase: 'cancelling',
      summary: 'API token: never-show-this',
    })], 'r1');
    expect(item.body).toContain('Cancellation requested for step 7.');
    expect(item.body).toContain('changed from active to cancelling');
    expect(item.body).not.toContain('never-show-this');
  });

  it('ignores messages for another run', () => {
    const items = buildActivityItems([
      makeMessage({ id: 'ours' }),
      makeMessage({ id: 'theirs', runId: 'r2' }),
    ], [], 'r1');
    expect(items.map(item => item.key)).toEqual(['message:ours']);
  });
});

describe('MessageCard', () => {
  it('renders semantic actor, type, time, and non-color control status cues', () => {
    const item = buildActivityItems([], [makeHistory()], 'r1')[0];
    render(<MessageCard item={item} />);
    expect(screen.getByRole('article', { name: 'control activity from coordinator' })).toBeTruthy();
    expect(screen.getByText('control')).toBeTruthy();
    expect(document.querySelector('.msg-status-cue')?.textContent).toContain('pausing');
    expect(document.querySelector('time')?.getAttribute('datetime')).toBe(item.timestamp);
  });

  it('renders hostile-looking text as text, never raw HTML', () => {
    render(<MessageCard message={makeMessage({ body: '<img src=x onerror="steal()"> very-long-content' })} />);
    expect(screen.getByText('<img src=x onerror="steal()"> very-long-content')).toBeTruthy();
    expect(document.querySelector('.msg-body img')).toBeNull();
    expect(document.querySelector('.activity-text')).toBeTruthy();
  });

  it('keeps known and unknown actor classes without relying on color alone', () => {
    const { container, rerender } = render(<MessageCard message={makeMessage({ from: 'planner' })} />);
    expect(container.querySelector('.from-planner')).toBeTruthy();
    expect(screen.getByText('planner')).toBeTruthy();
    rerender(<MessageCard message={makeMessage({ from: 'custom-agent' })} />);
    expect(container.querySelector('.from-unknown')).toBeTruthy();
    expect(screen.getByText('custom-agent')).toBeTruthy();
  });
});

describe('MessageList', () => {
  it('renders a semantic log with stable item keys and applies the selected filter', () => {
    currentFilter.value = 'review';
    const items = [
      makeActivity('info', '2026-01-01T00:00:00Z'),
      makeActivity('review', '2026-01-01T00:01:00Z', 'review'),
    ];
    const { container } = render(<MessageList items={items} />);
    expect(screen.getByRole('log', { name: 'Run activity timeline' })).toBeTruthy();
    expect(screen.queryByText('info')).toBeNull();
    expect(screen.getByText('review', { selector: '.msg-body' })).toBeTruthy();
    expect(container.querySelector('[data-activity-key="message:review"]')).toBeTruthy();
  });

  it('follows appended activity only while already at the live edge', async () => {
    let height = 100;
    const initial = [makeActivity('one', '2026-01-01T00:00:00Z')];
    const { rerender } = render(<MessageList items={initial} />);
    const feed = screen.getByRole('log') as HTMLDivElement;
    Object.defineProperty(feed, 'scrollHeight', { configurable: true, get: () => height });
    Object.defineProperty(feed, 'clientHeight', { configurable: true, value: 50 });
    feed.scrollTop = 50;
    fireEvent.scroll(feed);
    height = 180;
    rerender(<MessageList items={[...initial, makeActivity('two', '2026-01-01T00:01:00Z')]} />);
    await waitFor(() => expect(feed.scrollTop).toBe(180));
    expect((screen.getByRole('button', { name: 'Following live activity' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('counts unseen entries while scrolled away and returns explicitly without moving focus on append', async () => {
    let height = 200;
    const initial = [makeActivity('one', '2026-01-01T00:00:00Z')];
    const { rerender } = render(<MessageList items={initial} />);
    const feed = screen.getByRole('log') as HTMLDivElement;
    Object.defineProperty(feed, 'scrollHeight', { configurable: true, get: () => height });
    Object.defineProperty(feed, 'clientHeight', { configurable: true, value: 50 });
    feed.scrollTop = 20;
    fireEvent.scroll(feed);
    const focusAnchor = document.createElement('button');
    document.body.append(focusAnchor);
    focusAnchor.focus();
    height = 260;
    rerender(<MessageList items={[...initial, makeActivity('two', '2026-01-01T00:01:00Z')]} />);
    const returnButton = await screen.findByRole('button', { name: '1 new entry — return to live' });
    expect(feed.scrollTop).toBe(20);
    expect(document.activeElement).toBe(focusAnchor);
    fireEvent.click(returnButton);
    expect(feed.scrollTop).toBe(260);
    expect((screen.getByRole('button', { name: 'Following live activity' }) as HTMLButtonElement).disabled).toBe(true);
    focusAnchor.remove();
  });

  it('resets all timeline-local state when the selected run changes', async () => {
    let height = 200;
    const runA = [makeActivity('a-one', '2026-01-01T00:00:00Z')];
    const { rerender } = render(<MessageList runId="r1" items={runA} />);
    const feedA = screen.getByRole('log') as HTMLDivElement;
    Object.defineProperty(feedA, 'scrollHeight', { configurable: true, get: () => height });
    Object.defineProperty(feedA, 'clientHeight', { configurable: true, value: 50 });
    feedA.scrollTop = 20;
    fireEvent.scroll(feedA);

    height = 320;
    const runB = [
      { ...makeActivity('b-one', '2026-01-01T00:00:00Z'), runId: 'r2' },
      { ...makeActivity('b-two', '2026-01-01T00:01:00Z'), runId: 'r2' },
    ];
    rerender(<MessageList runId="r2" items={runB} />);

    const feedB = screen.getByRole('log') as HTMLDivElement;
    expect(feedB).not.toBe(feedA);
    expect(feedB.scrollTop).toBe(0);
    expect(screen.queryByText('a-one')).toBeNull();
    expect(screen.getByText('b-one')).toBeTruthy();
    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'Following live activity' }) as HTMLButtonElement).disabled).toBe(true);
    });
    expect(screen.queryByRole('button', { name: /new entries? — return to live/ })).toBeNull();
  });
});

describe('ActivityPanel resources and connection truth', () => {
  it('renders loading, empty, and stale-with-content states', () => {
    dataFreshness.value = 'loading';
    const { rerender } = render(<ActivityPanel />);
    expect(document.querySelector('[data-state="loading"]')).toBeTruthy();

    dataFreshness.value = 'fresh';
    rerender(<ActivityPanel />);
    expect(document.querySelector('[data-state="empty"]')).toBeTruthy();

    messages.value = [makeMessage({ body: 'last known event' })];
    connectionStatus.value = 'offline';
    dataFreshness.value = 'stale';
    rerender(<ActivityPanel />);
    expect(document.querySelector('[data-state="stale"]')).toBeTruthy();
    expect(screen.getByText('last known event')).toBeTruthy();
    expect(screen.getByText(/offline\. stale\./)).toBeTruthy();
  });

  it('shows an error with retry when stale and no content exists', () => {
    connectionStatus.value = 'offline';
    dataFreshness.value = 'stale';
    render(<ActivityPanel />);
    expect(document.querySelector('[data-state="error"]')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('retries stale content, preserves the timeline, and reports a network failure', async () => {
    messages.value = [makeMessage({ body: 'preserved event' })];
    dataFreshness.value = 'stale';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    render(<ActivityPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(document.querySelector('[data-state="error"]')).toBeTruthy());
    expect(screen.getByText('preserved event')).toBeTruthy();
    expect(screen.getByText(/activity refresh failed/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('integrates message and control counts without leaking audit summaries', () => {
    currentRun.value = makeRun([makeHistory({ summary: 'secret cancellation reason' })]);
    messages.value = [makeMessage({ body: 'ordinary update' })];
    render(<ActivityPanel />);
    expect(screen.getByRole('button', { name: 'All activity, 2' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'control activity, 1' })).toBeTruthy();
    expect(screen.queryByText(/secret cancellation reason/)).toBeNull();
  });

  it('does not let a late failed retry from run A affect run B or block its retry', async () => {
    const runA = makeRun([], 'r1');
    const runB = makeRun([], 'r2');
    allRuns.value = [runA, runB];
    currentRun.value = runA;
    dataFreshness.value = 'stale';
    messages.value = [makeMessage({ body: 'run A history' })];
    const runAMessages = deferred<Response>();
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/runs') return Promise.resolve(jsonResponse([runA, runB]));
      if (url.endsWith('/r1/messages')) return runAMessages.promise;
      if (url.endsWith('/r2/messages')) {
        return Promise.resolve(jsonResponse([makeMessage({ id: 'b-fetched', runId: 'r2', body: 'run B refreshed' })]));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<ActivityPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    currentRun.value = runB;
    messages.value = [makeMessage({ id: 'b-existing', runId: 'r2', body: 'run B history' })];
    dataFreshness.value = 'stale';
    await waitFor(() => expect(screen.getByText('run B history')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.getByText('run B refreshed')).toBeTruthy());

    runAMessages.reject(new Error('late run A failure'));
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.getByText('run B refreshed')).toBeTruthy();
    expect(screen.queryByText(/activity refresh failed/)).toBeNull();
  });

  it('ignores a late successful retry payload from the previously selected run', async () => {
    const runA = makeRun([], 'r1');
    const runB = makeRun([], 'r2');
    allRuns.value = [runA, runB];
    currentRun.value = runA;
    dataFreshness.value = 'stale';
    messages.value = [makeMessage({ body: 'run A history' })];
    const runAMessages = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/runs') return Promise.resolve(jsonResponse([runA, runB]));
      if (url.endsWith('/r1/messages')) return runAMessages.promise;
      throw new Error(`Unexpected request: ${url}`);
    }));
    render(<ActivityPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    currentRun.value = runB;
    messages.value = [makeMessage({ id: 'b-existing', runId: 'r2', body: 'run B history' })];
    dataFreshness.value = 'fresh';
    await waitFor(() => expect(screen.getByText('run B history')).toBeTruthy());
    runAMessages.resolve(jsonResponse([makeMessage({ id: 'a-late', body: 'late run A payload' })]));

    await waitFor(() => expect(screen.queryByText('late run A payload')).toBeNull());
    expect(screen.getByText('run B history')).toBeTruthy();
    expect(document.querySelector('[data-state="error"]')).toBeNull();
  });
});
