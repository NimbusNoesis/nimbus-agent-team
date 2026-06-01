import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/preact';
import {
  allRuns, currentRun, expandedStepId, memoryEntries,
  expandedMemoryKeys, currentFilter, messages, loadingRunId,
} from '../src/dashboard/client/state/store';
import type { Message } from '../src/dashboard/client/state/store';

import { FilterBar } from '../src/dashboard/client/components/activity/FilterBar';
import { MessageCard } from '../src/dashboard/client/components/activity/MessageCard';
import { MessageList } from '../src/dashboard/client/components/activity/MessageList';
import { ActivityPanel } from '../src/dashboard/client/components/activity/ActivityPanel';

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

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: `msg-${Math.random()}`,
    runId: 'r1',
    from: 'coder',
    to: 'all',
    type: 'info',
    body: 'test message',
    timestamp: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// --- FilterBar ---
describe('FilterBar', () => {
  it('renders all 6 filter buttons', () => {
    const { container } = render(<FilterBar />);
    const buttons = container.querySelectorAll('.filter-btn');
    expect(buttons.length).toBe(6);
    const labels = ['all', 'info', 'review', 'escalation', 'guidance', 'result'];
    labels.forEach(label => {
      expect(screen.getByText(label)).toBeTruthy();
    });
  });

  it('shows "all" as active by default', () => {
    currentFilter.value = 'all';
    const { container } = render(<FilterBar />);
    const buttons = container.querySelectorAll('.filter-btn');
    const allBtn = Array.from(buttons).find(b => b.textContent?.includes('all'));
    expect(allBtn).toBeTruthy();
    expect(allBtn!.className).toContain('active');
  });

  it('shows correct message counts per type', () => {
    messages.value = [
      makeMessage({ type: 'info' }),
      makeMessage({ type: 'info' }),
      makeMessage({ type: 'review' }),
    ];
    const { container } = render(<FilterBar />);
    const countSpans = container.querySelectorAll('.filter-count');
    // all=3, info=2, review=1, escalation=0, guidance=0, result=0
    const counts = Array.from(countSpans).map(s => s.textContent);
    expect(counts[0]).toBe('3');  // all
    expect(counts[1]).toBe('2');  // info
    expect(counts[2]).toBe('1');  // review
    expect(counts[3]).toBe('0');  // escalation
    expect(counts[4]).toBe('0');  // guidance
    expect(counts[5]).toBe('0');  // result
  });

  it('clicking a filter button updates currentFilter signal', () => {
    const { container } = render(<FilterBar />);
    const buttons = container.querySelectorAll('.filter-btn');
    const reviewBtn = Array.from(buttons).find(b => b.textContent?.includes('review') && !b.textContent?.includes('escalation'));
    expect(reviewBtn).toBeTruthy();
    fireEvent.click(reviewBtn!);
    expect(currentFilter.value).toBe('review');
  });

  it('active button gets .active class, others do not', () => {
    currentFilter.value = 'info';
    const { container } = render(<FilterBar />);
    const buttons = container.querySelectorAll('.filter-btn');
    const infoBtn = Array.from(buttons).find(b => b.textContent?.startsWith('info'));
    expect(infoBtn).toBeTruthy();
    expect(infoBtn!.className).toContain('active');

    const nonActiveButtons = Array.from(buttons).filter(b => !b.textContent?.startsWith('info'));
    nonActiveButtons.forEach(btn => {
      expect(btn.className).not.toContain('active');
    });
  });
});

// --- MessageCard ---
describe('MessageCard', () => {
  it('renders message body text', () => {
    const msg = makeMessage({ body: 'Hello from coder' });
    render(<MessageCard message={msg} />);
    expect(screen.getByText('Hello from coder')).toBeTruthy();
  });

  it('shows agent name with correct CSS variable color', () => {
    const msg = makeMessage({ from: 'coordinator' });
    const { container } = render(<MessageCard message={msg} />);
    const fromSpan = container.querySelector('.msg-from') as HTMLElement | null;
    expect(fromSpan).toBeTruthy();
    expect(fromSpan!.textContent).toBe('coordinator');
    expect(fromSpan!.style.color).toBe('var(--coordinator)');
  });

  it('shows type badge with correct class', () => {
    const msg = makeMessage({ type: 'review' });
    const { container } = render(<MessageCard message={msg} />);
    const badge = container.querySelector('.msg-type-badge');
    expect(badge).toBeTruthy();
    expect(badge!.className).toContain('msg-type-review');
    expect(badge!.textContent).toBe('review');
  });

  it('shows timestamp', () => {
    const msg = makeMessage({ timestamp: '2026-01-01T00:00:00Z' });
    const { container } = render(<MessageCard message={msg} />);
    const header = container.querySelector('.msg-header');
    expect(header).toBeTruthy();
    // The time is rendered as locale string — just verify some time text is present
    const spans = header!.querySelectorAll('span');
    const timeSpan = spans[spans.length - 1];
    expect(timeSpan.textContent).toBeTruthy();
    expect(timeSpan.textContent!.length).toBeGreaterThan(0);
  });

  it('adds from-{agent} class for known agents', () => {
    const msg = makeMessage({ from: 'planner' });
    const { container } = render(<MessageCard message={msg} />);
    const card = container.querySelector('.message');
    expect(card).toBeTruthy();
    expect(card!.className).toContain('from-planner');
  });

  it('adds from-unknown class for unknown agents', () => {
    const msg = makeMessage({ from: 'some-unknown-agent' });
    const { container } = render(<MessageCard message={msg} />);
    const card = container.querySelector('.message');
    expect(card).toBeTruthy();
    expect(card!.className).toContain('from-unknown');
  });

  it('adds escalation class for escalation messages', () => {
    const msg = makeMessage({ type: 'escalation' });
    const { container } = render(<MessageCard message={msg} />);
    const card = container.querySelector('.message');
    expect(card).toBeTruthy();
    expect(card!.className).toContain('escalation');
  });

  it('does not add escalation class for non-escalation messages', () => {
    const msg = makeMessage({ type: 'info' });
    const { container } = render(<MessageCard message={msg} />);
    const card = container.querySelector('.message');
    expect(card).toBeTruthy();
    expect(card!.className).not.toContain('escalation');
  });
});

// --- MessageList ---
describe('MessageList', () => {
  it('renders all messages when filter is "all"', () => {
    currentFilter.value = 'all';
    messages.value = [
      makeMessage({ body: 'msg one', type: 'info' }),
      makeMessage({ body: 'msg two', type: 'review' }),
      makeMessage({ body: 'msg three', type: 'escalation' }),
    ];
    render(<MessageList />);
    expect(screen.getByText('msg one')).toBeTruthy();
    expect(screen.getByText('msg two')).toBeTruthy();
    expect(screen.getByText('msg three')).toBeTruthy();
  });

  it('shows only matching messages when filter is set', () => {
    currentFilter.value = 'review';
    messages.value = [
      makeMessage({ body: 'info msg', type: 'info' }),
      makeMessage({ body: 'review msg', type: 'review' }),
    ];
    render(<MessageList />);
    expect(screen.getByText('review msg')).toBeTruthy();
    expect(screen.queryByText('info msg')).toBeNull();
  });

  it('respects currentFilter signal (filters messages)', () => {
    currentFilter.value = 'escalation';
    messages.value = [
      makeMessage({ body: 'escalated!', type: 'escalation' }),
      makeMessage({ body: 'just info', type: 'info' }),
    ];
    render(<MessageList />);
    expect(screen.getByText('escalated!')).toBeTruthy();
    expect(screen.queryByText('just info')).toBeNull();
  });

  it('renders empty when no messages', () => {
    messages.value = [];
    const { container } = render(<MessageList />);
    const feed = container.querySelector('#activity-feed');
    expect(feed).toBeTruthy();
    expect(feed!.children.length).toBe(0);
  });
});

// --- ActivityPanel ---
describe('ActivityPanel', () => {
  it('renders both FilterBar and MessageList together', () => {
    currentFilter.value = 'all';
    messages.value = [makeMessage({ body: 'panel msg' })];
    const { container } = render(<ActivityPanel />);
    // FilterBar renders the filter buttons
    const filterBar = container.querySelector('#filter-bar');
    expect(filterBar).toBeTruthy();
    // MessageList renders the activity feed
    const feed = container.querySelector('#activity-feed');
    expect(feed).toBeTruthy();
    // Message body is visible
    expect(screen.getByText('panel msg')).toBeTruthy();
  });
});
