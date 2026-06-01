import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { formatElapsed, formatRelativeTime, getRunLabel } from '../src/dashboard/client/utils/format';

describe('formatElapsed', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('formats seconds', () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:45Z'));
    expect(formatElapsed('2026-01-01T00:00:00Z')).toBe('45s');
  });

  it('formats minutes and seconds', () => {
    vi.setSystemTime(new Date('2026-01-01T00:03:15Z'));
    expect(formatElapsed('2026-01-01T00:00:00Z')).toBe('3m 15s');
  });

  it('formats hours and minutes', () => {
    vi.setSystemTime(new Date('2026-01-01T02:30:00Z'));
    expect(formatElapsed('2026-01-01T00:00:00Z')).toBe('2h 30m');
  });

  it('returns 0s when no elapsed time', () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    expect(formatElapsed('2026-01-01T00:00:00Z')).toBe('0s');
  });
});

describe('formatRelativeTime', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('formats seconds ago', () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:30Z'));
    expect(formatRelativeTime('2026-01-01T00:00:00Z')).toBe('30s ago');
  });

  it('formats minutes ago', () => {
    vi.setSystemTime(new Date('2026-01-01T00:05:00Z'));
    expect(formatRelativeTime('2026-01-01T00:00:00Z')).toBe('5m ago');
  });

  it('formats hours ago', () => {
    vi.setSystemTime(new Date('2026-01-01T03:15:00Z'));
    expect(formatRelativeTime('2026-01-01T00:00:00Z')).toBe('3h 15m ago');
  });
});

describe('getRunLabel', () => {
  it('returns numbered label with task', () => {
    expect(getRunLabel({ id: 'abc123', task: 'Fix the bug' }, 0)).toBe('#1: Fix the bug');
  });

  it('truncates long tasks to 40 chars', () => {
    const longTask = 'A'.repeat(50);
    const label = getRunLabel({ id: 'abc123', task: longTask }, 2);
    expect(label).toBe(`#3: ${'A'.repeat(40)}\u2026`);
  });

  it('falls back to ID slice when no task', () => {
    expect(getRunLabel({ id: 'abcdef1234567890' }, 0)).toBe('#1 (abcdef12)');
  });

  it('uses correct 1-based index', () => {
    expect(getRunLabel({ id: 'x', task: 'Test' }, 4)).toBe('#5: Test');
  });
});
