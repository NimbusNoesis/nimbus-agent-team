import type SqlJs from 'sql.js';
import type { RunState, Message, MemoryEntry, MemoryNamespace } from '../types.js';

type SqlJsDatabase = SqlJs.Database;

export class Database {
  private db: SqlJsDatabase;

  constructor(db: SqlJsDatabase) {
    this.db = db;
    this.initSchema();
  }

  /**
   * Static factory: initializes sql.js and returns a Database instance.
   * Used by index.ts and tests.
   */
  static async create(): Promise<Database> {
    const initSqlJs = (await import('sql.js')).default;
    const SQL = await initSqlJs();
    return new Database(new SQL.Database());
  }

  private initSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        task TEXT,
        status TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        type TEXT NOT NULL,
        body TEXT NOT NULL,
        timestamp TEXT NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS memory_entries (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        run_id TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (namespace, key)
      )
    `);
  }

  /**
   * Helper: execute a parameterized SELECT and return all rows as objects.
   */
  private selectAll<T extends Record<string, SqlJs.SqlValue>>(
    sql: string,
    params: SqlJs.BindParams = []
  ): T[] {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    try {
      const rows: T[] = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject() as T);
      }
      return rows;
    } finally {
      stmt.free();
    }
  }

  /**
   * Helper: execute a parameterized SELECT and return the first row or undefined.
   */
  private selectOne<T extends Record<string, SqlJs.SqlValue>>(
    sql: string,
    params: SqlJs.BindParams = []
  ): T | undefined {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    try {
      if (!stmt.step()) {
        return undefined;
      }
      return stmt.getAsObject() as T;
    } finally {
      stmt.free();
    }
  }

  // --- Run helpers ---

  insertRun(run: RunState): void {
    this.db.run(
      `INSERT INTO runs (id, task, status, data, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [run.id, run.task ?? null, run.status, JSON.stringify(run), run.createdAt, run.updatedAt]
    );
  }

  getRun(id: string): RunState | undefined {
    const row = this.selectOne<{ data: string }>('SELECT data FROM runs WHERE id = ?', [id]);
    if (!row) return undefined;
    return JSON.parse(row.data) as RunState;
  }

  getAllRuns(): RunState[] {
    const rows = this.selectAll<{ data: string }>('SELECT data FROM runs ORDER BY created_at ASC');
    return rows.map((r) => JSON.parse(r.data) as RunState);
  }

  updateRun(run: RunState): void {
    this.db.run(
      `UPDATE runs SET task = ?, status = ?, data = ?, updated_at = ? WHERE id = ?`,
      [run.task ?? null, run.status, JSON.stringify(run), run.updatedAt, run.id]
    );
  }

  // --- Message helpers ---

  insertMessage(message: Message): void {
    this.db.run(
      `INSERT INTO messages (id, run_id, from_agent, to_agent, type, body, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [message.id, message.runId, message.from, message.to, message.type, message.body, message.timestamp]
    );
  }

  getMessages(runId: string): Message[] {
    return this.getMessagesByRun(runId);
  }

  /** Latest message timestamp for a run, or undefined if the run has none. */
  getMaxMessageTimestamp(runId: string): string | undefined {
    const row = this.selectOne<{ ts: string | null }>(
      'SELECT MAX(timestamp) AS ts FROM messages WHERE run_id = ?',
      [runId]
    );
    return row && row.ts ? (row.ts as string) : undefined;
  }

  enforceMessageCap(runId: string, maxMessages: number): void {
    const row = this.selectOne<{ cnt: number }>(
      'SELECT COUNT(*) AS cnt FROM messages WHERE run_id = ?',
      [runId]
    );
    const count = row ? (row.cnt as number) : 0;
    if (count > maxMessages) {
      const overflow = count - maxMessages;
      this.db.run(
        `DELETE FROM messages WHERE id IN (
          SELECT id FROM messages WHERE run_id = ? ORDER BY timestamp ASC LIMIT ?
        )`,
        [runId, overflow]
      );
    }
  }

  getMessagesByRun(runId: string): Message[] {
    type MsgRow = {
      id: string;
      run_id: string;
      from_agent: string;
      to_agent: string;
      type: string;
      body: string;
      timestamp: string;
    };
    const rows = this.selectAll<MsgRow>(
      `SELECT id, run_id, from_agent, to_agent, type, body, timestamp
       FROM messages WHERE run_id = ? ORDER BY timestamp ASC`,
      [runId]
    );
    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      from: r.from_agent,
      to: r.to_agent,
      type: r.type as Message['type'],
      body: r.body,
      timestamp: r.timestamp,
    }));
  }

  // --- Memory helpers ---

  writeMemoryEntry(entry: MemoryEntry): void {
    this.db.run(
      `INSERT INTO memory_entries (namespace, key, value, run_id, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (namespace, key) DO UPDATE SET
         value = excluded.value,
         run_id = excluded.run_id,
         updated_at = excluded.updated_at`,
      [entry.namespace, entry.key, entry.value, entry.runId ?? null, entry.updatedAt]
    );
  }

  readMemoryEntry(namespace: MemoryNamespace, key: string): MemoryEntry | undefined {
    type MemRow = {
      namespace: string;
      key: string;
      value: string;
      run_id: string | null;
      updated_at: string;
    };
    const row = this.selectOne<MemRow>(
      'SELECT namespace, key, value, run_id, updated_at FROM memory_entries WHERE namespace = ? AND key = ?',
      [namespace, key]
    );
    if (!row) return undefined;
    return {
      namespace: row.namespace as MemoryNamespace,
      key: row.key,
      value: row.value,
      runId: (row.run_id as string | null) ?? undefined,
      updatedAt: row.updated_at,
    };
  }

  listByNamespace(namespace: MemoryNamespace): MemoryEntry[] {
    type MemRow = {
      namespace: string;
      key: string;
      value: string;
      run_id: string | null;
      updated_at: string;
    };
    const rows = this.selectAll<MemRow>(
      'SELECT namespace, key, value, run_id, updated_at FROM memory_entries WHERE namespace = ? ORDER BY updated_at ASC',
      [namespace]
    );
    return rows.map((r) => ({
      namespace: r.namespace as MemoryNamespace,
      key: r.key,
      value: r.value,
      runId: (r.run_id as string | null) ?? undefined,
      updatedAt: r.updated_at,
    }));
  }

  searchMemory(query: string): MemoryEntry[] {
    type MemRow = {
      namespace: string;
      key: string;
      value: string;
      run_id: string | null;
      updated_at: string;
    };
    // Escape LIKE wildcards (% and _) and the escape character itself so the
    // query matches literally instead of acting as a pattern.
    const escaped = query.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const pattern = `%${escaped}%`;
    const rows = this.selectAll<MemRow>(
      `SELECT namespace, key, value, run_id, updated_at
       FROM memory_entries
       WHERE key LIKE ? ESCAPE '\\' OR value LIKE ? ESCAPE '\\'
       ORDER BY updated_at ASC`,
      [pattern, pattern]
    );
    return rows.map((r) => ({
      namespace: r.namespace as MemoryNamespace,
      key: r.key,
      value: r.value,
      runId: (r.run_id as string | null) ?? undefined,
      updatedAt: r.updated_at,
    }));
  }

  deleteMemoryEntry(namespace: MemoryNamespace, key: string): void {
    this.db.run(
      'DELETE FROM memory_entries WHERE namespace = ? AND key = ?',
      [namespace, key]
    );
  }

  getAllMemory(): MemoryEntry[] {
    type MemRow = {
      namespace: string;
      key: string;
      value: string;
      run_id: string | null;
      updated_at: string;
    };
    const rows = this.selectAll<MemRow>(
      'SELECT namespace, key, value, run_id, updated_at FROM memory_entries ORDER BY namespace ASC, updated_at ASC'
    );
    return rows.map((r) => ({
      namespace: r.namespace as MemoryNamespace,
      key: r.key,
      value: r.value,
      runId: (r.run_id as string | null) ?? undefined,
      updatedAt: r.updated_at,
    }));
  }

  close(): void {
    this.db.close();
  }
}
