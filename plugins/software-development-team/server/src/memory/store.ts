import { EventEmitter } from 'node:events';
import type { MemoryEntry, MemoryNamespace } from '../types.js';
import { Database } from '../db/database.js';

interface WriteInput {
  key: string;
  namespace: MemoryNamespace;
  value: string;
  runId?: string;
}

export class MemoryStore extends EventEmitter {
  private db: Database;

  constructor(db: Database) {
    super();
    this.db = db;
  }

  write(input: WriteInput): MemoryEntry {
    const entry: MemoryEntry = {
      key: input.key,
      namespace: input.namespace,
      value: input.value,
      runId: input.runId,
      updatedAt: new Date().toISOString(),
    };
    this.db.writeMemoryEntry(entry);
    this.emit('entry_change', { ...entry });
    return entry;
  }

  // Startup restore path: writes the entry exactly as persisted — preserving
  // its original updatedAt — and emits no event. Using write() here would
  // re-stamp every restored entry to boot time, diverging the DB from disk and
  // scrambling updated_at ordering after every restart.
  restore(entry: MemoryEntry): void {
    this.db.writeMemoryEntry(entry);
  }

  read(namespace: MemoryNamespace, key: string): MemoryEntry | undefined;
  read(namespace: MemoryNamespace): MemoryEntry[];
  read(namespace: MemoryNamespace, key?: string): MemoryEntry | MemoryEntry[] | undefined {
    if (key !== undefined) {
      return this.db.readMemoryEntry(namespace, key);
    }
    return this.db.listByNamespace(namespace);
  }

  list(namespace: MemoryNamespace): MemoryEntry[] {
    return this.db.listByNamespace(namespace);
  }

  search(query: string): MemoryEntry[] {
    return this.db.searchMemory(query);
  }

  delete(namespace: MemoryNamespace, key: string): boolean {
    const existing = this.db.readMemoryEntry(namespace, key);
    if (!existing) return false;
    this.db.deleteMemoryEntry(namespace, key);
    this.emit('entry_change', { ...existing, value: '', updatedAt: new Date().toISOString() });
    return true;
  }

  getAll(): MemoryEntry[] {
    return this.db.getAllMemory();
  }
}
