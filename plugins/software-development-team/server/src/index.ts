import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { StateMachine } from './state/machine.js';
import { MessageBus } from './bus/message-bus.js';
import { MemoryStore } from './memory/store.js';
import { ToolRegistry } from './tools/registry.js';
import { startDashboard } from './dashboard/server.js';
import { Persistence } from './state/persistence.js';
import { Database } from './db/database.js';
import { resolve } from 'node:path';
import { logger } from './logger.js';
import type { RunState } from './types.js';

const teamDir = resolve(process.env.TEAM_DIR ?? '.team');
logger.info('Server', `Team directory: ${teamDir}`);

const server = new McpServer({
  name: 'software-development-team',
  version: '0.1.0',
});

const positiveInt = z.number().int().positive();
const memoryKey = z.string().regex(/^[a-zA-Z0-9_\-]+$/, 'Key must be alphanumeric with hyphens/underscores only');

// --- Startup ---

async function main() {
  logger.info('Server', 'Starting software-development-team MCP server...');

  const db = await Database.create();
  const sm = new StateMachine(db);
  const bus = new MessageBus(db);
  const memory = new MemoryStore(db);
  const persistence = new Persistence(teamDir);
  const registry = new ToolRegistry(sm, bus, memory);

  // --- Tool Definitions ---

  server.tool(
    'team_start',
    'Initialize a new task run with plan steps. Returns run ID.',
    {
      task: z.string().optional().describe('Human-readable task description shown in the dashboard'),
      steps: z.array(z.object({
        id: positiveInt,
        description: z.string().min(1),
        files: z.array(z.string()),
        acceptanceCriteria: z.array(z.string()),
        dependsOn: z.array(positiveInt),
      })).min(1),
    },
    async (args) => {
      const result = await registry.handle('team_start', args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    'team_status',
    'Get current run state: steps, statuses, retry counts.',
    { runId: z.string().min(1) },
    async (args) => {
      const result = await registry.handle('team_status', args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    'team_advance',
    'Advance a step: start_coding, approve, request_revision, resolve_escalation, or mark_reviewed (close a read-only review step that has no code result to submit). Pass an optional summary with mark_reviewed.',
    {
      runId: z.string().min(1),
      stepId: positiveInt,
      action: z.enum(['start_coding', 'approve', 'request_revision', 'resolve_escalation', 'mark_reviewed']),
      agent: z.string().optional(),
      summary: z.string().optional(),
    },
    async (args) => {
      const result = await registry.handle('team_advance', args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    'team_submit_result',
    'Submit work result for a step: done, done_with_concerns, needs_revision, or blocked.',
    {
      runId: z.string().min(1),
      stepId: positiveInt,
      result: z.object({
        status: z.enum(['done', 'done_with_concerns', 'needs_revision', 'blocked']),
        summary: z.string().min(1),
        details: z.string().optional(),
      }),
    },
    async (args) => {
      const result = await registry.handle('team_submit_result', args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    'team_send_message',
    'Post a message to the team bus.',
    {
      runId: z.string().min(1),
      from: z.string().min(1),
      to: z.string().min(1),
      type: z.enum(['info', 'review', 'escalation', 'guidance', 'result']),
      body: z.string().min(1),
    },
    async (args) => {
      const result = await registry.handle('team_send_message', args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    'team_get_messages',
    'Read messages for an agent. Supports filtering by type and since timestamp.',
    {
      runId: z.string().min(1),
      to: z.string().min(1),
      type: z.enum(['info', 'review', 'escalation', 'guidance', 'result']).optional(),
      since: z.string().optional(),
    },
    async (args) => {
      const result = await registry.handle('team_get_messages', args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    'team_memory_write',
    'Store a key-value entry in shared memory.',
    {
      key: memoryKey,
      namespace: z.enum(['decisions', 'context', 'learnings', 'reviews', 'reflections']),
      value: z.string().min(1),
      runId: z.string().optional(),
    },
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
    {
      namespace: z.enum(['decisions', 'context', 'learnings', 'reviews', 'reflections']).optional(),
      key: z.string().optional(),
      search: z.string().optional(),
    },
    async (args) => {
      const result = await registry.handle('team_memory_read', args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    'team_memory_delete',
    'Delete a memory entry by namespace and key.',
    {
      namespace: z.enum(['decisions', 'context', 'learnings', 'reviews', 'reflections']),
      key: memoryKey,
    },
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
    memory.write(entry);
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

  // Serialized persistence — ensures SIGTERM waits for any in-flight write
  let pendingPersist: Promise<void> = Promise.resolve();

  function persistRunState(run: RunState) {
    pendingPersist = pendingPersist
      .then(() => persistence.saveRunState(run))
      .catch((err) => {
        logger.error('Server', 'Failed to save run state', { runId: run.id, error: String(err) });
      });
  }

  // Event-driven persistence — state saved on every transition
  sm.on('state_update', (run) => {
    persistRunState(run);
  });

  bus.on('message', (msg) => {
    persistence.appendMessage(msg.runId, msg).catch((err) => {
      logger.error('Server', 'Failed to append message', { runId: msg.runId, error: String(err) });
    });
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('Server', 'MCP stdio transport connected — ready for tool calls');

  // Graceful shutdown — save all state before exit
  async function shutdown() {
    await pendingPersist;
    for (const run of sm.getAllRuns()) {
      await persistence.saveRunState(run).catch((err) => {
        logger.error('Server', 'Failed to save run state during shutdown', { runId: run.id, error: String(err) });
      });
    }
    process.exit(0);
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('Failed to start MCP server:', err);
  process.exit(1);
});
