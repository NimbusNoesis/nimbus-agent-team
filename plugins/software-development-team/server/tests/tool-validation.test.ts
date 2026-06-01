import { describe, it, expect, beforeEach } from 'vitest';
import { ZodError } from 'zod';
import { handleTeamStart, handleTeamStatus, handleTeamAdvance } from '../src/tools/workflow.js';
import { handleTeamSubmitResult } from '../src/tools/results.js';
import { handleTeamSendMessage, handleTeamGetMessages } from '../src/tools/messages.js';
import { handleTeamMemoryWrite, handleTeamMemoryRead, handleTeamMemoryDelete } from '../src/tools/memory.js';
import { createTestStack } from './helpers.js';
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
    });

    it('accepts valid input with task provided', () => {
      const result = handleTeamStart(sm, {
        task: 'Build feature',
        steps: [{ id: 1, description: 'Do stuff', files: [], acceptanceCriteria: [], dependsOn: [] }],
      });
      expect(result.task).toBe('Build feature');
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
      const result = handleTeamAdvance(sm, {
        runId, stepId: 1, action: 'start_coding',
      });
      expect(result.success).toBe(true);
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
      handleTeamAdvance(sm, { runId, stepId: 1, action: 'start_coding' });
      const result = handleTeamSubmitResult(sm, {
        runId, stepId: 1, result: { status: 'done', summary: 'done', details: 'extra info' },
      });
      expect(result.success).toBe(true);
    });
  });

  describe('TeamSendMessageSchema', () => {
    it('rejects empty from', () => {
      expect(() => handleTeamSendMessage(bus, {
        runId: 'r1', from: '', to: 'all', type: 'info', body: 'hi',
      })).toThrow(ZodError);
    });

    it('rejects empty to', () => {
      expect(() => handleTeamSendMessage(bus, {
        runId: 'r1', from: 'coder', to: '', type: 'info', body: 'hi',
      })).toThrow(ZodError);
    });

    it('rejects empty body', () => {
      expect(() => handleTeamSendMessage(bus, {
        runId: 'r1', from: 'coder', to: 'all', type: 'info', body: '',
      })).toThrow(ZodError);
    });

    it('rejects invalid type enum', () => {
      expect(() => handleTeamSendMessage(bus, {
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

    it('accepts optional fields omitted', () => {
      const result = handleTeamGetMessages(bus, { runId: 'r1', to: 'all' });
      expect(result.messages).toEqual([]);
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
});
