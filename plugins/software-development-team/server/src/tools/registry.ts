import type { StateMachine } from '../state/machine.js';
import type { MessageBus } from '../bus/message-bus.js';
import type { MemoryStore } from '../memory/store.js';
import { handleTeamStart, handleTeamStatus, handleTeamAdvance } from './workflow.js';
import { handleTeamSubmitResult } from './results.js';
import { handleTeamSendMessage, handleTeamGetMessages } from './messages.js';
import { handleTeamMemoryWrite, handleTeamMemoryRead, handleTeamMemoryDelete } from './memory.js';
import { logger } from '../logger.js';

// Small identifying fields that are safe to include in failure logs. Free-text
// payloads (value, body, summary, details, memory values, message bodies) must
// NEVER be logged — they would land verbatim in server.log on every failure.
const SAFE_LOG_FIELDS = ['runId', 'stepId', 'key', 'namespace', 'action', 'from', 'to'] as const;

function safeLogContext(args: Record<string, unknown>): Record<string, unknown> {
  const context: Record<string, unknown> = { argKeys: Object.keys(args) };
  for (const field of SAFE_LOG_FIELDS) {
    if (field in args) context[field] = args[field];
  }
  return context;
}

export class ToolRegistry {
  private dashboardUrl = 'http://localhost:0';

  constructor(
    private sm: StateMachine,
    private bus: MessageBus,
    private memory: MemoryStore,
  ) {}

  setDashboardUrl(url: string): void {
    this.dashboardUrl = url;
  }

  async handle(tool: string, args: Record<string, unknown>): Promise<any> {
    logger.debug('ToolRegistry', `→ ${tool}`, { keys: Object.keys(args) });
    try {
      const result = await this.dispatch(tool, args);
      logger.debug('ToolRegistry', `← ${tool} OK`);
      return result;
    } catch (err: any) {
      logger.error('ToolRegistry', `← ${tool} FAILED: ${err.message}`, { tool, ...safeLogContext(args) });
      throw err;
    }
  }

  private async dispatch(tool: string, args: Record<string, unknown>): Promise<any> {
    switch (tool) {
      case 'team_start':
        return handleTeamStart(this.sm, args);
      case 'team_status':
        return handleTeamStatus(this.sm, args);
      case 'team_advance':
        return handleTeamAdvance(this.sm, args);
      case 'team_submit_result':
        return handleTeamSubmitResult(this.sm, args);
      case 'team_send_message':
        return handleTeamSendMessage(this.bus, this.sm, args);
      case 'team_get_messages':
        return handleTeamGetMessages(this.bus, args);
      case 'team_memory_write':
        return handleTeamMemoryWrite(this.memory, args);
      case 'team_memory_read':
        return handleTeamMemoryRead(this.memory, args);
      case 'team_memory_delete':
        return handleTeamMemoryDelete(this.memory, args);
      case 'team_dashboard_url':
        return { url: this.dashboardUrl };
      default:
        throw new Error(`Unknown tool: ${tool}`);
    }
  }
}
