import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StateMachine } from './state/machine.js';
import { MessageBus } from './bus/message-bus.js';
import { MemoryStore } from './memory/store.js';
import { ToolRegistry } from './tools/registry.js';
import { teamStartSchema, teamStatusShape, teamAdvanceSchema, teamControlSchema } from './tools/workflow.js';
import { teamSubmitResultShape } from './tools/results.js';
import { teamSendMessageShape, teamGetMessagesShape } from './tools/messages.js';
import { teamMemoryWriteShape, teamMemoryReadShape, teamMemoryDeleteShape } from './tools/memory.js';
import { startDashboard } from './dashboard/server.js';
import { Persistence } from './state/persistence.js';
import { PersistQueue } from './state/persist-queue.js';
import { Database } from './db/database.js';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { logger } from './logger.js';
import type { RunState } from './types.js';
import { claimServerLock, releaseServerLock } from './state/server-lock.js';

const teamDir = resolve(process.env.TEAM_DIR ?? '.team');
logger.info('Server', `Team directory: ${teamDir}`);

// Keep the MCP handshake version in sync with the package version.
function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const server = new McpServer({
  name: 'software-development-team',
  version: packageVersion(),
});

// Best-effort concurrent-session detection. Two live servers on the same
// .team directory (a second Claude Code session, or Claude Code + Codex at
// once) each hold an independent in-memory DB and race on the same state
// files — last writer wins, and neither sees the other's runs. We warn loudly
// rather than refuse to start, since a second session may legitimately open
// the project without ever running the team.
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function checkAndClaimLock(): void {
  try {
    const liveOwners = claimServerLock(teamDir, process.pid, isProcessAlive);
    if (liveOwners.length > 0) {
      logger.warn(
        'Server',
        `Other team MCP servers (pids ${liveOwners.join(', ')}) appear to be running against ${teamDir}. ` +
        `Concurrent sessions on the same project race on run state and will not see each other's runs — ` +
        `finish or close the other sessions before starting team runs here.`
      );
    }
  } catch (err) {
    logger.warn('Server', `Could not claim server lock file`, { teamDir, error: String(err) });
  }
}

function releaseLock(): void {
  try {
    releaseServerLock(teamDir, process.pid, isProcessAlive);
  } catch {
    // Best effort only.
  }
}

// --- Startup ---

async function main() {
  logger.info('Server', 'Starting software-development-team MCP server...');
  checkAndClaimLock();

  const db = await Database.create();
  const sm = new StateMachine(db);
  const bus = new MessageBus(db);
  const memory = new MemoryStore(db);
  const persistence = new Persistence(teamDir);
  const registry = new ToolRegistry(sm, bus, memory);

  // --- Tool Definitions ---

  // Workflow schemas with object-level strictness or refinements use
  // registerTool so the SDK validates the complete schema before dispatch.
  server.registerTool(
    'team_start',
    {
      description: 'Initialize a new task run with plan steps. Returns run ID.',
      inputSchema: teamStartSchema,
    },
    async (args) => {
      const result = await registry.handle('team_start', args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    'team_status',
    'Get current run state: steps, statuses, retry counts.',
    { ...teamStatusShape },
    async (args) => {
      const result = await registry.handle('team_status', args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }
  );

  server.registerTool(
    'team_advance',
    {
      description: 'Persist a set-once worktree context or advance a step through its lifecycle.',
      inputSchema: teamAdvanceSchema,
    },
    async (args) => {
      const result = await registry.handle('team_advance', args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }
  );

  server.registerTool(
    'team_control',
    {
      description: 'Pause, resume, cancel, acknowledge, or retry execution using optimistic concurrency and idempotency.',
      inputSchema: teamControlSchema,
    },
    async (args) => {
      const result = await registry.handle('team_control', args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    'team_submit_result',
    'Submit work result for a step: done, done_with_concerns, needs_revision, or blocked.',
    { ...teamSubmitResultShape },
    async (args) => {
      const result = await registry.handle('team_submit_result', args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    'team_send_message',
    'Post a message to the team bus.',
    { ...teamSendMessageShape },
    async (args) => {
      const result = await registry.handle('team_send_message', args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    'team_get_messages',
    'Read messages for an agent. Supports filtering by type and since timestamp.',
    { ...teamGetMessagesShape },
    async (args) => {
      const result = await registry.handle('team_get_messages', args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    'team_memory_write',
    'Store a key-value entry in shared memory.',
    { ...teamMemoryWriteShape },
    async (args) => {
      const result = await registry.handle('team_memory_write', args);
      await persistence.saveMemoryEntry({
        key: args.key,
        namespace: args.namespace,
        value: args.value,
        runId: args.runId,
        updatedAt: result.updatedAt,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    'team_memory_read',
    'Read memory entries by key, namespace, or search query.',
    { ...teamMemoryReadShape },
    async (args) => {
      const result = await registry.handle('team_memory_read', args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    'team_memory_delete',
    'Delete a memory entry by namespace and key.',
    { ...teamMemoryDeleteShape },
    async (args) => {
      const result = await registry.handle('team_memory_delete', args);
      await persistence.deleteMemoryEntry(args.namespace, args.key);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    'team_dashboard_url',
    'Get the dashboard URL.',
    {},
    async () => {
      const result = await registry.handle('team_dashboard_url', {});
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }
  );

  const entries = await persistence.loadMemoryEntries();
  for (const entry of entries) {
    memory.restore(entry);
  }
  logger.info('Server', `Loaded ${entries.length} memory entries from disk`);

  const runStates = await persistence.loadAllRunStates();
  let restoredMessageCount = 0;
  for (const run of runStates) {
    sm.restoreRun(run);
    const messages = await persistence.loadMessages(run.id);
    for (const msg of messages) {
      try {
        db.insertMessage(msg);
        restoredMessageCount++;
      } catch (err) {
        logger.warn('Startup', 'Skipping malformed message during restore', { error: String(err) });
      }
    }
  }
  logger.info('Server', `Restored ${runStates.length} run states and ${restoredMessageCount} messages from disk`);

  const dashboardPort = await startDashboard(sm, bus, memory);
  registry.setDashboardUrl(`http://localhost:${dashboardPort}`);
  logger.info('Server', `Dashboard URL: http://localhost:${dashboardPort}`);

  // Serialized persistence — one queue for run states AND message appends, so
  // shutdown can await everything in flight (previously message appends were
  // fire-and-forget and could be lost on SIGTERM).
  const persistQueue = new PersistQueue();

  // Event-driven persistence — state saved on every transition
  sm.on('state_update', (run) => {
    persistQueue.enqueue(() => persistence.saveRunState(run), { kind: 'run_state', runId: run.id });
  });

  bus.on('message', (msg) => {
    persistQueue.enqueue(() => persistence.appendMessage(msg.runId, msg), { kind: 'message', runId: msg.runId });
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('Server', 'MCP stdio transport connected — ready for tool calls');

  // Graceful shutdown — save all state before exit. Final saves go through
  // the same serialized queue (a direct saveRunState could race a queued save
  // for the same run — both write state.json.tmp then rename), and drain()
  // loops until the tail settles so saves enqueued after shutdown begins are
  // awaited too.
  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const run of sm.getAllRuns()) {
      persistQueue.enqueue(() => persistence.saveRunState(run), { kind: 'shutdown_run_state', runId: run.id });
    }
    await persistQueue.drain();
    releaseLock();
    process.exit(0);
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  // When the host exits without signaling (stdin closes), shut down instead of
  // lingering as an orphan kept alive by the dashboard's open listener.
  server.server.onclose = () => {
    logger.info('Server', 'MCP transport closed — shutting down');
    void shutdown();
  };
}

main().catch((err) => {
  console.error('Failed to start MCP server:', err);
  process.exit(1);
});
