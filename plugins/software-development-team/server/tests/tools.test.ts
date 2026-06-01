import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRegistry } from '../src/tools/registry.js';
import { StateMachine } from '../src/state/machine.js';
import { MessageBus } from '../src/bus/message-bus.js';
import { MemoryStore } from '../src/memory/store.js';
import { Database } from '../src/db/database.js';

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(async () => {
    const db = await Database.create();
    registry = new ToolRegistry(
      new StateMachine(db),
      new MessageBus(db),
      new MemoryStore(db),
    );
  });

  it('team_start creates a run and returns run ID', async () => {
    const result = await registry.handle('team_start', {
      steps: [
        { id: 1, description: 'Step 1', files: ['a.ts'], acceptanceCriteria: ['works'], dependsOn: [] },
      ],
    });
    expect(result.runId).toBeDefined();
    expect(result.status).toBe('ready');
    expect(result.stepCount).toBe(1);
  });

  it('team_status returns current run state', async () => {
    const { runId } = await registry.handle('team_start', {
      steps: [{ id: 1, description: 'Step 1', files: [], acceptanceCriteria: [], dependsOn: [] }],
    });
    const status = await registry.handle('team_status', { runId });
    expect(status.status).toBe('ready');
    expect(status.steps).toHaveLength(1);
  });

  it('team_submit_result + team_advance complete a step', async () => {
    const { runId } = await registry.handle('team_start', {
      steps: [{ id: 1, description: 'S1', files: [], acceptanceCriteria: [], dependsOn: [] }],
    });
    await registry.handle('team_advance', { runId, stepId: 1, action: 'start_coding', agent: 'coder' });
    await registry.handle('team_submit_result', {
      runId, stepId: 1, result: { status: 'done', summary: 'implemented' },
    });
    await registry.handle('team_advance', { runId, stepId: 1, action: 'approve' });
    const status = await registry.handle('team_status', { runId });
    expect(status.steps[0].status).toBe('complete');
  });

  it('team_send_message + team_get_messages round trips', async () => {
    const { runId } = await registry.handle('team_start', {
      steps: [{ id: 1, description: 'S1', files: [], acceptanceCriteria: [], dependsOn: [] }],
    });
    await registry.handle('team_send_message', {
      runId, from: 'coder', to: 'coordinator', type: 'info', body: 'hello',
    });
    const result = await registry.handle('team_get_messages', { runId, to: 'coordinator' });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].body).toBe('hello');
  });

  it('team_memory_write + team_memory_read round trips', async () => {
    await registry.handle('team_memory_write', {
      key: 'auth', namespace: 'decisions', value: 'Use JWT',
    });
    const result = await registry.handle('team_memory_read', { namespace: 'decisions', key: 'auth' });
    expect(result.entry.value).toBe('Use JWT');
  });

  it('team_dashboard_url returns a URL', async () => {
    const result = await registry.handle('team_dashboard_url', {});
    expect(result.url).toMatch(/^http/);
  });

  it('handle rejects unknown tool name', async () => {
    await expect(registry.handle('nonexistent_tool', {})).rejects.toThrow('Unknown tool');
  });

  it('team_advance with resolve_escalation works on escalated step', async () => {
    const { runId } = await registry.handle('team_start', {
      steps: [{ id: 1, description: 'S1', files: [], acceptanceCriteria: [], dependsOn: [] }],
    });
    await registry.handle('team_advance', { runId, stepId: 1, action: 'start_coding' });
    await registry.handle('team_submit_result', {
      runId, stepId: 1, result: { status: 'blocked', summary: 'stuck' },
    });
    const result = await registry.handle('team_advance', {
      runId, stepId: 1, action: 'resolve_escalation',
    });
    expect(result.stepStatus).toBe('coding');
  });

  it('team_memory_delete removes an entry', async () => {
    await registry.handle('team_memory_write', {
      key: 'to-delete', namespace: 'decisions', value: 'temporary',
    });
    const deleteResult = await registry.handle('team_memory_delete', {
      namespace: 'decisions', key: 'to-delete',
    });
    expect(deleteResult.success).toBe(true);
    const readResult = await registry.handle('team_memory_read', {
      namespace: 'decisions', key: 'to-delete',
    });
    expect(readResult.entry).toBeNull();
  });

  it('team_memory_read with search returns matching entries', async () => {
    await registry.handle('team_memory_write', {
      key: 'auth-choice', namespace: 'decisions', value: 'Use JWT tokens',
    });
    await registry.handle('team_memory_write', {
      key: 'db-choice', namespace: 'decisions', value: 'Use PostgreSQL',
    });
    const result = await registry.handle('team_memory_read', { search: 'JWT' });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].key).toBe('auth-choice');
  });

  it('team_memory_read with namespace only returns entries for that namespace', async () => {
    await registry.handle('team_memory_write', {
      key: 'k1', namespace: 'decisions', value: 'v1',
    });
    await registry.handle('team_memory_write', {
      key: 'k2', namespace: 'context', value: 'v2',
    });
    const result = await registry.handle('team_memory_read', { namespace: 'decisions' });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].namespace).toBe('decisions');
  });
});
