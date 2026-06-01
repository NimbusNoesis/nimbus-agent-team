import { describe, it, expect, beforeEach } from 'vitest';
import { Database } from '../src/db/database.js';
import { makeRun, makeMessage, makeMemoryEntry } from './helpers.js';
import type { RunState, Message, MemoryEntry } from '../src/types.js';

describe('Database', () => {
  let db: Database;

  beforeEach(async () => {
    db = await Database.create();
  });

  describe('Run CRUD', () => {
    it('insertRun + getRun round-trips a full RunState', () => {
      const run = makeRun('r1', { task: 'Build the thing', status: 'ready' });
      db.insertRun(run);
      const retrieved = db.getRun('r1');
      expect(retrieved).toEqual(run);
    });

    it('getRun returns undefined for non-existent id', () => {
      expect(db.getRun('nonexistent')).toBeUndefined();
    });

    it('getAllRuns returns runs ordered by created_at ASC', () => {
      const early = makeRun('r1', { createdAt: '2026-01-01T00:00:00Z' });
      const late = makeRun('r2', { createdAt: '2026-01-02T00:00:00Z' });
      db.insertRun(late);
      db.insertRun(early);
      const runs = db.getAllRuns();
      expect(runs).toHaveLength(2);
      expect(runs[0].id).toBe('r1');
      expect(runs[1].id).toBe('r2');
    });

    it('getAllRuns returns empty array when no runs exist', () => {
      expect(db.getAllRuns()).toEqual([]);
    });

    it('updateRun persists changes', () => {
      const run = makeRun('r1', { status: 'ready' });
      db.insertRun(run);
      run.status = 'complete';
      run.task = 'Updated task';
      db.updateRun(run);
      const retrieved = db.getRun('r1');
      expect(retrieved!.status).toBe('complete');
      expect(retrieved!.task).toBe('Updated task');
    });

    it('insertRun with duplicate id throws', () => {
      const run = makeRun('r1');
      db.insertRun(run);
      expect(() => db.insertRun(run)).toThrow();
    });
  });

  describe('Message CRUD', () => {
    it('insertMessage + getMessages round-trips correctly', () => {
      const msg = makeMessage({ id: 'm1', runId: 'r1' });
      db.insertMessage(msg);
      const messages = db.getMessages('r1');
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual(msg);
    });

    it('getMessages returns empty array for unknown runId', () => {
      expect(db.getMessages('nonexistent')).toEqual([]);
    });

    it('getMessages returns messages ordered by timestamp ASC', () => {
      db.insertMessage(makeMessage({ id: 'm2', runId: 'r1', timestamp: '2026-01-01T00:02:00Z' }));
      db.insertMessage(makeMessage({ id: 'm1', runId: 'r1', timestamp: '2026-01-01T00:01:00Z' }));
      const messages = db.getMessages('r1');
      expect(messages[0].id).toBe('m1');
      expect(messages[1].id).toBe('m2');
    });

    it('getMessagesByRun maps column names correctly', () => {
      db.insertMessage(makeMessage({ id: 'm1', runId: 'r1', from: 'coder', to: 'reviewer' }));
      const messages = db.getMessagesByRun('r1');
      expect(messages[0].from).toBe('coder');
      expect(messages[0].to).toBe('reviewer');
      expect(messages[0].runId).toBe('r1');
    });
  });

  describe('enforceMessageCap', () => {
    it('does nothing when count <= maxMessages', () => {
      db.insertMessage(makeMessage({ id: 'm1', runId: 'r1' }));
      db.insertMessage(makeMessage({ id: 'm2', runId: 'r1' }));
      db.enforceMessageCap('r1', 5);
      expect(db.getMessages('r1')).toHaveLength(2);
    });

    it('deletes oldest messages when count exceeds maxMessages by 1', () => {
      for (let i = 0; i < 4; i++) {
        db.insertMessage(makeMessage({
          id: `m${i}`,
          runId: 'r1',
          timestamp: `2026-01-01T00:0${i}:00Z`,
        }));
      }
      db.enforceMessageCap('r1', 3);
      const messages = db.getMessages('r1');
      expect(messages).toHaveLength(3);
      expect(messages[0].id).toBe('m1');
    });

    it('deletes oldest N messages when count exceeds maxMessages by N', () => {
      for (let i = 0; i < 5; i++) {
        db.insertMessage(makeMessage({
          id: `m${i}`,
          runId: 'r1',
          timestamp: `2026-01-01T00:0${i}:00Z`,
        }));
      }
      db.enforceMessageCap('r1', 2);
      const messages = db.getMessages('r1');
      expect(messages).toHaveLength(2);
      expect(messages[0].id).toBe('m3');
      expect(messages[1].id).toBe('m4');
    });

    it('preserves newest messages after cap enforcement', () => {
      for (let i = 0; i < 5; i++) {
        db.insertMessage(makeMessage({
          id: `m${i}`,
          runId: 'r1',
          body: `message ${i}`,
          timestamp: `2026-01-01T00:0${i}:00Z`,
        }));
      }
      db.enforceMessageCap('r1', 3);
      const messages = db.getMessages('r1');
      expect(messages.map(m => m.body)).toEqual(['message 2', 'message 3', 'message 4']);
    });
  });

  describe('Memory CRUD', () => {
    it('writeMemoryEntry + readMemoryEntry round-trips with runId', () => {
      const entry = makeMemoryEntry({ runId: 'r1' });
      db.writeMemoryEntry(entry);
      const retrieved = db.readMemoryEntry('decisions', 'test-key');
      expect(retrieved).toEqual(entry);
    });

    it('writeMemoryEntry upserts on conflict (same namespace+key)', () => {
      db.writeMemoryEntry(makeMemoryEntry({ value: 'old' }));
      db.writeMemoryEntry(makeMemoryEntry({ value: 'new', updatedAt: '2026-01-02T00:00:00Z' }));
      const entry = db.readMemoryEntry('decisions', 'test-key');
      expect(entry!.value).toBe('new');
    });

    it('readMemoryEntry returns undefined for non-existent entry', () => {
      expect(db.readMemoryEntry('decisions', 'nonexistent')).toBeUndefined();
    });

    it('listByNamespace returns only matching entries, ordered by updated_at', () => {
      db.writeMemoryEntry(makeMemoryEntry({ key: 'k2', namespace: 'decisions', updatedAt: '2026-01-02T00:00:00Z' }));
      db.writeMemoryEntry(makeMemoryEntry({ key: 'k1', namespace: 'decisions', updatedAt: '2026-01-01T00:00:00Z' }));
      db.writeMemoryEntry(makeMemoryEntry({ key: 'other', namespace: 'context' }));
      const entries = db.listByNamespace('decisions');
      expect(entries).toHaveLength(2);
      expect(entries[0].key).toBe('k1');
      expect(entries[1].key).toBe('k2');
    });

    it('listByNamespace returns empty array for empty namespace', () => {
      expect(db.listByNamespace('reviews')).toEqual([]);
    });

    it('getAllMemory returns all entries ordered by namespace ASC, updated_at ASC', () => {
      db.writeMemoryEntry(makeMemoryEntry({ key: 'k1', namespace: 'decisions', updatedAt: '2026-01-01T00:00:00Z' }));
      db.writeMemoryEntry(makeMemoryEntry({ key: 'k2', namespace: 'context', updatedAt: '2026-01-01T00:00:00Z' }));
      db.writeMemoryEntry(makeMemoryEntry({ key: 'k3', namespace: 'reviews', updatedAt: '2026-01-01T00:00:00Z' }));
      const entries = db.getAllMemory();
      expect(entries).toHaveLength(3);
      expect(entries[0].namespace).toBe('context');
      expect(entries[1].namespace).toBe('decisions');
      expect(entries[2].namespace).toBe('reviews');
    });

    it('deleteMemoryEntry removes the entry', () => {
      db.writeMemoryEntry(makeMemoryEntry());
      db.deleteMemoryEntry('decisions', 'test-key');
      expect(db.readMemoryEntry('decisions', 'test-key')).toBeUndefined();
    });

    it('deleteMemoryEntry is a no-op for non-existent entry', () => {
      expect(() => db.deleteMemoryEntry('decisions', 'nonexistent')).not.toThrow();
    });
  });

  describe('searchMemory', () => {
    it('matches on key substring', () => {
      db.writeMemoryEntry(makeMemoryEntry({ key: 'auth-decision', value: 'unrelated' }));
      db.writeMemoryEntry(makeMemoryEntry({ key: 'other-thing', namespace: 'context', value: 'unrelated' }));
      const results = db.searchMemory('auth');
      expect(results).toHaveLength(1);
      expect(results[0].key).toBe('auth-decision');
    });

    it('matches on value substring', () => {
      db.writeMemoryEntry(makeMemoryEntry({ key: 'k1', value: 'Use JWT tokens' }));
      const results = db.searchMemory('JWT');
      expect(results).toHaveLength(1);
      expect(results[0].value).toBe('Use JWT tokens');
    });

    it('returns empty array when nothing matches', () => {
      db.writeMemoryEntry(makeMemoryEntry());
      expect(db.searchMemory('zzz_nomatch')).toEqual([]);
    });
  });

  describe('close', () => {
    it('throws on subsequent operations after close', () => {
      db.close();
      expect(() => db.getRun('x')).toThrow();
    });
  });
});
