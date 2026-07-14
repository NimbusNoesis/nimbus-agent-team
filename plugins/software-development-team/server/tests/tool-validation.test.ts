import { describe, it, expect, beforeEach } from 'vitest';
import { z, ZodError } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  handleTeamStart,
  handleTeamStatus,
  handleTeamAdvance,
  handleTeamControl,
  teamStartShape,
  teamStartSchema,
  teamAdvanceShape,
  teamAdvanceSchema,
  teamControlSchema,
} from '../src/tools/workflow.js';
import { handleTeamSubmitResult } from '../src/tools/results.js';
import { handleTeamSendMessage, handleTeamGetMessages, teamGetMessagesShape } from '../src/tools/messages.js';
import { handleTeamMemoryWrite, handleTeamMemoryRead, handleTeamMemoryDelete } from '../src/tools/memory.js';
import { createTestStack, makeWorktree } from './helpers.js';
import type { StateMachine } from '../src/state/machine.js';
import type { MessageBus } from '../src/bus/message-bus.js';
import type { MemoryStore } from '../src/memory/store.js';

describe('Zod schema validation', () => {
  let sm: StateMachine;
  let bus: MessageBus;
  let memory: MemoryStore;

  beforeEach(async () => {
    const stack = await createTestStack();
    sm = stack.sm;
    bus = stack.bus;
    memory = stack.memory;
  });

  describe('TeamStartSchema', () => {
    it('rejects empty steps array', () => {
      expect(() => handleTeamStart(sm, { steps: [] })).toThrow(ZodError);
    });

    it('rejects step with id=0 (not positive)', () => {
      expect(() => handleTeamStart(sm, {
        steps: [{ id: 0, description: 'x', files: [], acceptanceCriteria: [], dependsOn: [] }],
      })).toThrow(ZodError);
    });

    it('rejects step with negative id', () => {
      expect(() => handleTeamStart(sm, {
        steps: [{ id: -1, description: 'x', files: [], acceptanceCriteria: [], dependsOn: [] }],
      })).toThrow(ZodError);
    });

    it('rejects step with non-integer id', () => {
      expect(() => handleTeamStart(sm, {
        steps: [{ id: 1.5, description: 'x', files: [], acceptanceCriteria: [], dependsOn: [] }],
      })).toThrow(ZodError);
    });

    it('rejects step with empty description', () => {
      expect(() => handleTeamStart(sm, {
        steps: [{ id: 1, description: '', files: [], acceptanceCriteria: [], dependsOn: [] }],
      })).toThrow(ZodError);
    });

    it('rejects step with dependsOn containing 0', () => {
      expect(() => handleTeamStart(sm, {
        steps: [{ id: 1, description: 'x', files: [], acceptanceCriteria: [], dependsOn: [0] }],
      })).toThrow(ZodError);
    });

    it('accepts valid input with task omitted', () => {
      const result = handleTeamStart(sm, {
        steps: [{ id: 1, description: 'Do stuff', files: [], acceptanceCriteria: [], dependsOn: [] }],
      });
      expect(result.runId).toBeDefined();
      expect(sm.getRun(result.runId)!.steps[0].step.executionMode).toBe('code');
    });

    it('accepts valid input with task provided', () => {
      const result = handleTeamStart(sm, {
        task: 'Build feature',
        steps: [{ id: 1, description: 'Do stuff', files: [], acceptanceCriteria: [], dependsOn: [] }],
      });
      expect(result.task).toBe('Build feature');
    });

    it.each(['code', 'read_only'] as const)('accepts and persists the %s execution mode', (executionMode) => {
      const result = handleTeamStart(sm, {
        steps: [{
          id: 1,
          description: 'Do stuff',
          files: [],
          acceptanceCriteria: [],
          dependsOn: [],
          executionMode,
        }],
      });
      expect(sm.getRun(result.runId)!.steps[0].step.executionMode).toBe(executionMode);
    });

    it('rejects unsupported execution modes before creating a run', () => {
      const before = sm.getAllRuns();
      expect(() => handleTeamStart(sm, {
        steps: [{
          id: 1,
          description: 'Do stuff',
          files: [],
          acceptanceCriteria: [],
          dependsOn: [],
          executionMode: 'documentation',
        }],
      })).toThrow(ZodError);
      expect(sm.getAllRuns()).toEqual(before);
    });

    it('preserves complete object-level validation before creating a run', () => {
      const before = sm.getAllRuns();
      expect(() => handleTeamStart(sm, {
        steps: [{
          id: 1,
          description: 'Do stuff',
          files: [],
          acceptanceCriteria: [],
          dependsOn: [],
          unexpected: true,
        }],
      })).toThrow(ZodError);
      expect(sm.getAllRuns()).toEqual(before);
    });
  });

  describe('TeamStatusSchema', () => {
    it('rejects empty runId string', () => {
      expect(() => handleTeamStatus(sm, { runId: '' })).toThrow(ZodError);
    });

    it('rejects missing runId', () => {
      expect(() => handleTeamStatus(sm, {})).toThrow(ZodError);
    });
  });

  describe('TeamAdvanceSchema', () => {
    it('rejects invalid action enum value', () => {
      expect(() => handleTeamAdvance(sm, {
        runId: 'r1', stepId: 1, action: 'invalid_action',
      })).toThrow(ZodError);
    });

    it('rejects stepId=0', () => {
      expect(() => handleTeamAdvance(sm, {
        runId: 'r1', stepId: 0, action: 'start_coding',
      })).toThrow(ZodError);
    });

    it('rejects empty runId', () => {
      expect(() => handleTeamAdvance(sm, {
        runId: '', stepId: 1, action: 'start_coding',
      })).toThrow(ZodError);
    });

    it('rejects empty agent string', () => {
      expect(() => handleTeamAdvance(sm, {
        runId: 'r1', stepId: 1, action: 'start_coding', agent: '',
      })).toThrow(ZodError);
    });

    it('accepts agent omitted', () => {
      // Will fail at state machine level (run not found), but schema should pass
      const { runId } = handleTeamStart(sm, {
        steps: [{ id: 1, description: 'x', files: [], acceptanceCriteria: [], dependsOn: [] }],
      });
      sm.setWorktree(runId, 1, makeWorktree(runId, 1));
      const result = handleTeamAdvance(sm, {
        runId, stepId: 1, action: 'start_coding',
      });
      expect(result.success).toBe(true);
    });

    it('requires worktree payload for set_worktree', () => {
      expect(() => handleTeamAdvance(sm, {
        runId: 'r1', stepId: 1, action: 'set_worktree',
      })).toThrow(ZodError);
    });

    it('rejects malformed worktree objects before mutating a step', () => {
      const { runId } = handleTeamStart(sm, {
        steps: [{ id: 1, description: 'x', files: [], acceptanceCriteria: [], dependsOn: [] }],
      });
      expect(() => handleTeamAdvance(sm, {
        runId,
        stepId: 1,
        action: 'set_worktree',
        worktree: { ...makeWorktree(runId, 1), unexpected: true },
      })).toThrow(ZodError);
      expect(sm.getRun(runId)!.steps[0].worktree).toBeUndefined();
    });

    it('rejects empty summary string', () => {
      expect(() => handleTeamAdvance(sm, {
        runId: 'r1', stepId: 1, action: 'mark_reviewed', summary: '',
      })).toThrow(ZodError);
    });
  });

  describe('TeamControlSchema', () => {
    const valid = {
      action: 'pause_run', target: { kind: 'run' }, commandId: 'pause-1', expectedRevision: 0,
    };

    it.each([
      ['invalid action', { ...valid, action: 'kill_run' }],
      ['empty commandId', { ...valid, commandId: '' }],
      ['negative revision', { ...valid, expectedRevision: -1 }],
      ['fractional revision', { ...valid, expectedRevision: 1.5 }],
      ['invalid target kind', { ...valid, target: { kind: 'worker' } }],
      ['invalid step id', { ...valid, action: 'cancel_step', target: { kind: 'step', stepId: 0 }, confirmation: true }],
      ['unknown field', { ...valid, unexpected: true }],
      ['long reason', { ...valid, reason: 'x'.repeat(501) }],
    ])('rejects %s', (_label, args) => {
      expect(() => handleTeamControl(sm, { runId: 'run', ...args })).toThrow(ZodError);
    });

    it('rejects action/target mismatches', () => {
      expect(() => handleTeamControl(sm, {
        runId: 'run', ...valid, target: { kind: 'step', stepId: 1 },
      })).toThrow(ZodError);
      expect(() => handleTeamControl(sm, {
        runId: 'run', ...valid, action: 'retry_step', target: { kind: 'run' },
      })).toThrow(ZodError);
    });

    it('requires confirmation=true for cancellation actions', () => {
      expect(() => handleTeamControl(sm, {
        runId: 'run', ...valid, action: 'cancel_run',
      })).toThrow(ZodError);
      expect(() => handleTeamControl(sm, {
        runId: 'run', ...valid, action: 'cancel_step', target: { kind: 'step', stepId: 1 },
      })).toThrow(ZodError);
    });

    it('enforces the complete schema at the MCP SDK boundary before dispatch', async () => {
      const dispatches: unknown[] = [];
      const server = new McpServer({ name: 'validation-test-server', version: '1.0.0' });
      server.registerTool('team_control', { inputSchema: teamControlSchema }, async (args) => {
        dispatches.push(args);
        return { content: [{ type: 'text' as const, text: 'ok' }] };
      });

      const client = new Client({ name: 'validation-test-client', version: '1.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const call = (args: Record<string, unknown>) => client.callTool({ name: 'team_control', arguments: args });
      await expect(call({ runId: 'r', ...valid, unexpected: true })).resolves.toMatchObject({
        isError: true,
        content: [{ text: expect.stringMatching(/Input validation error.*Unrecognized key/s) }],
      });
      await expect(call({
        runId: 'r', ...valid, action: 'retry_step', target: { kind: 'run' },
      })).resolves.toMatchObject({
        isError: true,
        content: [{ text: expect.stringMatching(/Input validation error.*requires a step target/s) }],
      });
      expect(dispatches).toEqual([]);

      await expect(call({ runId: 'r', ...valid })).resolves.toMatchObject({
        content: [{ type: 'text', text: 'ok' }],
      });
      expect(dispatches).toEqual([{ runId: 'r', ...valid }]);

      await client.close();
      await server.close();
    });
  });

  describe('TeamSubmitResultSchema', () => {
    it('rejects invalid result.status enum', () => {
      expect(() => handleTeamSubmitResult(sm, {
        runId: 'r1', stepId: 1, result: { status: 'invalid', summary: 'x' },
      })).toThrow(ZodError);
    });

    it('rejects empty result.summary', () => {
      expect(() => handleTeamSubmitResult(sm, {
        runId: 'r1', stepId: 1, result: { status: 'done', summary: '' },
      })).toThrow(ZodError);
    });

    it('rejects stepId=0', () => {
      expect(() => handleTeamSubmitResult(sm, {
        runId: 'r1', stepId: 0, result: { status: 'done', summary: 'x' },
      })).toThrow(ZodError);
    });

    it('accepts result with optional details', () => {
      const { runId } = handleTeamStart(sm, {
        steps: [{ id: 1, description: 'x', files: [], acceptanceCriteria: [], dependsOn: [] }],
      });
      sm.setWorktree(runId, 1, makeWorktree(runId, 1));
      handleTeamAdvance(sm, { runId, stepId: 1, action: 'start_coding' });
      const result = handleTeamSubmitResult(sm, {
        runId, stepId: 1, result: { status: 'done', summary: 'done', details: 'extra info' },
      });
      expect(result.success).toBe(true);
    });
  });

  describe('TeamSendMessageSchema', () => {
    it('rejects empty from', () => {
      expect(() => handleTeamSendMessage(bus, sm, {
        runId: 'r1', from: '', to: 'all', type: 'info', body: 'hi',
      })).toThrow(ZodError);
    });

    it('rejects empty to', () => {
      expect(() => handleTeamSendMessage(bus, sm, {
        runId: 'r1', from: 'coder', to: '', type: 'info', body: 'hi',
      })).toThrow(ZodError);
    });

    it('rejects empty body', () => {
      expect(() => handleTeamSendMessage(bus, sm, {
        runId: 'r1', from: 'coder', to: 'all', type: 'info', body: '',
      })).toThrow(ZodError);
    });

    it('rejects invalid type enum', () => {
      expect(() => handleTeamSendMessage(bus, sm, {
        runId: 'r1', from: 'coder', to: 'all', type: 'invalid_type', body: 'hi',
      })).toThrow(ZodError);
    });
  });

  describe('TeamGetMessagesSchema', () => {
    it('rejects empty runId', () => {
      expect(() => handleTeamGetMessages(bus, { runId: '', to: 'all' })).toThrow(ZodError);
    });

    it('rejects empty to', () => {
      expect(() => handleTeamGetMessages(bus, { runId: 'r1', to: '' })).toThrow(ZodError);
    });

    it('rejects invalid since (non-datetime string)', () => {
      expect(() => handleTeamGetMessages(bus, {
        runId: 'r1', to: 'all', since: 'not-a-date',
      })).toThrow(ZodError);
    });

    it('accepts since with a timezone offset', () => {
      const result = handleTeamGetMessages(bus, {
        runId: 'r1', to: 'all', since: '2026-07-10T12:00:00+02:00',
      });
      expect(result.messages).toEqual([]);
    });

    it('accepts server-generated toISOString since values', () => {
      const result = handleTeamGetMessages(bus, {
        runId: 'r1', to: 'all', since: new Date().toISOString(),
      });
      expect(result.messages).toEqual([]);
    });

    it('accepts optional fields omitted', () => {
      const result = handleTeamGetMessages(bus, { runId: 'r1', to: 'all' });
      expect(result.messages).toEqual([]);
    });

    it('accepts timezone offsets and rejects invalid since values at the MCP boundary', async () => {
      const dispatches: unknown[] = [];
      const server = new McpServer({ name: 'message-validation-server', version: '1.0.0' });
      server.tool(
        'team_get_messages',
        'Read messages for an agent.',
        { ...teamGetMessagesShape },
        async (args) => {
          dispatches.push(args);
          return { content: [{ type: 'text' as const, text: 'ok' }] };
        },
      );

      const client = new Client({ name: 'message-validation-client', version: '1.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      await expect(client.callTool({
        name: 'team_get_messages',
        arguments: { runId: 'r1', to: 'all', since: '2026-07-10T12:00:00+02:00' },
      })).resolves.toMatchObject({ content: [{ type: 'text', text: 'ok' }] });
      expect(dispatches).toEqual([{
        runId: 'r1',
        to: 'all',
        since: '2026-07-10T12:00:00+02:00',
      }]);

      await expect(client.callTool({
        name: 'team_get_messages',
        arguments: { runId: 'r1', to: 'all', since: 'not-a-date' },
      })).resolves.toMatchObject({ isError: true });
      expect(dispatches).toHaveLength(1);

      await client.close();
      await server.close();
    });
  });

  describe('TeamMemoryWriteSchema', () => {
    it('rejects key with spaces', () => {
      expect(() => handleTeamMemoryWrite(memory, {
        key: 'has space', namespace: 'decisions', value: 'x',
      })).toThrow(ZodError);
    });

    it('rejects key with special characters', () => {
      expect(() => handleTeamMemoryWrite(memory, {
        key: 'foo.bar', namespace: 'decisions', value: 'x',
      })).toThrow(ZodError);
    });

    it('rejects key with slash', () => {
      expect(() => handleTeamMemoryWrite(memory, {
        key: 'foo/bar', namespace: 'decisions', value: 'x',
      })).toThrow(ZodError);
    });

    it('rejects invalid namespace enum', () => {
      expect(() => handleTeamMemoryWrite(memory, {
        key: 'valid-key', namespace: 'invalid_ns', value: 'x',
      })).toThrow(ZodError);
    });

    it('rejects empty value', () => {
      expect(() => handleTeamMemoryWrite(memory, {
        key: 'valid-key', namespace: 'decisions', value: '',
      })).toThrow(ZodError);
    });

    it('accepts key with hyphens and underscores', () => {
      const result = handleTeamMemoryWrite(memory, {
        key: 'my_decision-key', namespace: 'decisions', value: 'accepted',
      });
      expect(result.success).toBe(true);
    });

    it('accepts runId omitted', () => {
      const result = handleTeamMemoryWrite(memory, {
        key: 'norun', namespace: 'decisions', value: 'x',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('TeamMemoryReadSchema', () => {
    it('accepts all fields omitted (returns all memory)', () => {
      const result = handleTeamMemoryRead(memory, {});
      expect(result.entries).toEqual([]);
    });

    it('rejects invalid namespace enum', () => {
      expect(() => handleTeamMemoryRead(memory, { namespace: 'bogus' })).toThrow(ZodError);
    });
  });

  describe('TeamMemoryDeleteSchema', () => {
    it('rejects missing namespace', () => {
      expect(() => handleTeamMemoryDelete(memory, { key: 'k' })).toThrow(ZodError);
    });

    it('rejects missing key', () => {
      expect(() => handleTeamMemoryDelete(memory, { namespace: 'decisions' })).toThrow(ZodError);
    });

    it('rejects key with invalid characters', () => {
      expect(() => handleTeamMemoryDelete(memory, {
        namespace: 'decisions', key: 'bad key!',
      })).toThrow(ZodError);
    });
  });

  describe('exported workflow schemas', () => {
    it('team_start shape applies the canonical default and rejects unsupported modes', () => {
      const omitted = z.object(teamStartShape).parse({
        steps: [{ id: 1, description: 'x', files: [], acceptanceCriteria: [], dependsOn: [] }],
      });
      expect(omitted.steps[0].executionMode).toBe('code');

      const invalid = z.object(teamStartShape).safeParse({
        steps: [{
          id: 1,
          description: 'x',
          files: [],
          acceptanceCriteria: [],
          dependsOn: [],
          executionMode: 'documentation',
        }],
      });
      expect(invalid.success).toBe(false);
    });

    it('team_advance shape rejects an empty summary at the MCP layer', () => {
      const result = z.object(teamAdvanceShape).safeParse({
        runId: 'r1', stepId: 1, action: 'mark_reviewed', summary: '',
      });
      expect(result.success).toBe(false);
    });

    it('team_get_messages shape accepts a timezone-offset since at the MCP layer', () => {
      const result = z.object(teamGetMessagesShape).safeParse({
        runId: 'r1', to: 'all', since: '2026-07-10T12:00:00+02:00',
      });
      expect(result.success).toBe(true);
    });

    it('team_get_messages shape rejects a non-datetime since at the MCP layer', () => {
      const result = z.object(teamGetMessagesShape).safeParse({
        runId: 'r1', to: 'all', since: 'not-a-date',
      });
      expect(result.success).toBe(false);
    });

    it('complete workflow schemas reject malformed input before registered MCP dispatch', async () => {
      const dispatches: string[] = [];
      const server = new McpServer({ name: 'workflow-validation-server', version: '1.0.0' });
      server.registerTool('team_start', { inputSchema: teamStartSchema }, async (args) => {
        dispatches.push('team_start');
        const result = handleTeamStart(sm, args);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      });
      server.registerTool('team_advance', { inputSchema: teamAdvanceSchema }, async (args) => {
        dispatches.push('team_advance');
        const result = handleTeamAdvance(sm, args);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      });

      const client = new Client({ name: 'workflow-validation-client', version: '1.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const planStep = {
        id: 1,
        description: 'x',
        files: [],
        acceptanceCriteria: [],
        dependsOn: [],
      };
      const before = sm.getAllRuns();
      await expect(client.callTool({
        name: 'team_start',
        arguments: { steps: [{ ...planStep, executionMode: 'documentation' }] },
      })).resolves.toMatchObject({ isError: true });
      await expect(client.callTool({
        name: 'team_start',
        arguments: { steps: [{ ...planStep, unexpected: true }] },
      })).resolves.toMatchObject({ isError: true });
      expect(sm.getAllRuns()).toEqual(before);

      const { runId } = handleTeamStart(sm, { steps: [planStep] });
      await expect(client.callTool({
        name: 'team_advance',
        arguments: {
          runId,
          stepId: 1,
          action: 'set_worktree',
          worktree: { ...makeWorktree(runId, 1), unexpected: true },
        },
      })).resolves.toMatchObject({ isError: true });
      await expect(client.callTool({
        name: 'team_advance',
        arguments: { runId, stepId: 1, action: 'set_worktree' },
      })).resolves.toMatchObject({ isError: true });
      expect(sm.getRun(runId)!.steps[0].worktree).toBeUndefined();
      expect(dispatches).toEqual([]);

      await client.close();
      await server.close();
    });
  });
});
