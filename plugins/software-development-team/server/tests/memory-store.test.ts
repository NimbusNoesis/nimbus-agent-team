import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../src/memory/store.js';
import { Database } from '../src/db/database.js';

describe('MemoryStore', () => {
  let store: MemoryStore;

  beforeEach(async () => {
    store = new MemoryStore(await Database.create());
  });

  it('writes and reads a memory entry', () => {
    store.write({ key: 'auth-approach', namespace: 'decisions', value: 'Use JWT', runId: 'r1' });
    const entry = store.read('decisions', 'auth-approach');
    expect(entry?.value).toBe('Use JWT');
    expect(entry?.runId).toBe('r1');
  });

  it('overwrites existing entry with same key and namespace', () => {
    store.write({ key: 'k', namespace: 'context', value: 'old' });
    store.write({ key: 'k', namespace: 'context', value: 'new' });
    expect(store.read('context', 'k')?.value).toBe('new');
  });

  it('lists entries by namespace', () => {
    store.write({ key: 'a', namespace: 'decisions', value: '1' });
    store.write({ key: 'b', namespace: 'decisions', value: '2' });
    store.write({ key: 'c', namespace: 'context', value: '3' });
    expect(store.list('decisions')).toHaveLength(2);
  });

  it('searches entries by content', () => {
    store.write({ key: 'a', namespace: 'decisions', value: 'Use JWT for auth' });
    store.write({ key: 'b', namespace: 'context', value: 'Express routes' });
    const results = store.search('JWT');
    expect(results).toHaveLength(1);
    expect(results[0].key).toBe('a');
  });

  it('deletes an entry', () => {
    store.write({ key: 'k', namespace: 'decisions', value: 'v' });
    store.delete('decisions', 'k');
    expect(store.read('decisions', 'k')).toBeUndefined();
  });

  describe('delete', () => {
    it('emits entry_delete once with the original value and updatedAt preserved', () => {
      store.write({ key: 'k', namespace: 'decisions', value: 'v', runId: 'r1' });
      const written = store.read('decisions', 'k')!;

      const events: unknown[] = [];
      store.on('entry_delete', (entry) => events.push(entry));

      expect(store.delete('decisions', 'k')).toBe(true);

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        key: 'k',
        namespace: 'decisions',
        value: 'v',
        runId: 'r1',
        updatedAt: written.updatedAt,
      });
    });

    it('does not emit entry_change on delete', () => {
      store.write({ key: 'k', namespace: 'decisions', value: 'v' });
      let changeEvents = 0;
      store.on('entry_change', () => changeEvents++);
      store.delete('decisions', 'k');
      expect(changeEvents).toBe(0);
    });

    it('returns false and emits nothing when the key is missing', () => {
      let events = 0;
      store.on('entry_delete', () => events++);
      store.on('entry_change', () => events++);
      expect(store.delete('decisions', 'no-such-key')).toBe(false);
      expect(events).toBe(0);
    });
  });

  describe('restore', () => {
    it('preserves the persisted updatedAt instead of re-stamping it', () => {
      store.restore({
        key: 'old-entry', namespace: 'learnings', value: 'from disk',
        runId: 'r1', updatedAt: '2020-01-02T03:04:05.000Z',
      });
      const entry = store.read('learnings', 'old-entry');
      expect(entry?.updatedAt).toBe('2020-01-02T03:04:05.000Z');
      expect(entry?.value).toBe('from disk');
    });

    it('emits no entry_change event', () => {
      let events = 0;
      store.on('entry_change', () => events++);
      store.restore({
        key: 'silent', namespace: 'context', value: 'v', updatedAt: '2021-06-07T00:00:00.000Z',
      });
      expect(events).toBe(0);
    });
  });
});
