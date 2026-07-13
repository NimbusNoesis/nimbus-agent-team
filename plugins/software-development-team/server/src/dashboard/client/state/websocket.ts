import {
  allRuns,
  applyRunSnapshot,
  applyRunSnapshots,
  connectionStatus,
  currentRun,
  dataFreshness,
  lastSyncedAt,
  messages,
  memoryEntries,
} from './store';
import type { Message, RunState } from './store';
import { fetchRuns, fetchMemory } from './api';

// The socket self-perpetuates via onclose. Guarding CONNECTING and OPEN avoids
// parallel reconnect loops when app initialization is retried.
let currentSocket: WebSocket | null = null;

function isCurrentSocket(socket: WebSocket): boolean {
  return currentSocket === socket;
}

function mergeMessages(current: Message[], incoming: Message): Message[] {
  const byId = new Map(current.map(message => [message.id, message]));
  byId.set(incoming.id, incoming);
  return [...byId.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
}

function isRunState(value: unknown): value is RunState {
  return typeof value === 'object' && value !== null
    && typeof (value as { id?: unknown }).id === 'string'
    && Array.isArray((value as { steps?: unknown }).steps);
}

export function connectWebSocket(): void {
  if (
    currentSocket
    && (currentSocket.readyState === WebSocket.CONNECTING || currentSocket.readyState === WebSocket.OPEN)
  ) return;

  connectionStatus.value = 'connecting';
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}`);
  currentSocket = ws;

  ws.onopen = async () => {
    if (!isCurrentSocket(ws)) return;
    const selectedRunIdAtOpen = currentRun.value?.id;
    connectionStatus.value = 'online';
    dataFreshness.value = 'loading';
    try {
      const runs = await fetchRuns();
      if (!isCurrentSocket(ws)) return;
      applyRunSnapshots(runs);
      const memory = await fetchMemory();
      if (!isCurrentSocket(ws)) return;
      memoryEntries.value = memory;

      // A reconnect that began for run A must not certify run B after the
      // operator changes selection. The collection GET is authoritative for
      // the selected run only when it actually contained that run.
      const selectionIsUnchanged = currentRun.value?.id === selectedRunIdAtOpen;
      const selectedRunWasSynced = selectedRunIdAtOpen === undefined
        || runs.some(run => run.id === selectedRunIdAtOpen);
      if (selectionIsUnchanged && selectedRunWasSynced) {
        dataFreshness.value = 'fresh';
        lastSyncedAt.value = new Date().toISOString();
      }
    } catch (e) {
      if (!isCurrentSocket(ws)) return;
      if (currentRun.value?.id === selectedRunIdAtOpen) dataFreshness.value = 'stale';
      console.error('Failed to re-sync after WebSocket connect:', e);
    }
  };

  ws.onmessage = (event) => {
    if (!isCurrentSocket(ws)) return;
    let data: unknown;
    try {
      data = JSON.parse(event.data);
    } catch (e) {
      console.error('Failed to parse WebSocket message:', e);
      return;
    }
    if (typeof data !== 'object' || data === null || typeof (data as { type?: unknown }).type !== 'string') return;
    const dashboardEvent = data as Record<string, any>;

    if (dashboardEvent.type === 'state_update' && isRunState(dashboardEvent.run)) {
      const selectedRunId = currentRun.value?.id;
      applyRunSnapshot(dashboardEvent.run);
      if (selectedRunId === dashboardEvent.run.id && currentRun.value?.id === selectedRunId) {
        dataFreshness.value = 'fresh';
        lastSyncedAt.value = new Date().toISOString();
      }
    } else if (dashboardEvent.type === 'new_message' && dashboardEvent.message) {
      const message = dashboardEvent.message as Message;
      // Buffer live messages during history loading. selectRun uses the same
      // stable id semantics when the HTTP history resolves.
      if (!currentRun.value || message.runId === currentRun.value.id) {
        messages.value = mergeMessages(messages.value, message);
      }
    } else if (dashboardEvent.type === 'memory_entry_update' && dashboardEvent.entry) {
      const idx = memoryEntries.value.findIndex(
        entry => entry.namespace === dashboardEvent.entry.namespace && entry.key === dashboardEvent.entry.key
      );
      const next = [...memoryEntries.value];
      if (idx !== -1) next[idx] = dashboardEvent.entry;
      else next.push(dashboardEvent.entry);
      memoryEntries.value = next;
    } else if (dashboardEvent.type === 'memory_entry_delete' && dashboardEvent.entry) {
      memoryEntries.value = memoryEntries.value.filter(
        entry => !(entry.namespace === dashboardEvent.entry.namespace && entry.key === dashboardEvent.entry.key)
      );
    }
  };

  ws.onerror = () => {
    if (!isCurrentSocket(ws)) return;
    ws.close();
  };
  ws.onclose = () => {
    if (!isCurrentSocket(ws)) return;
    currentSocket = null;
    connectionStatus.value = 'offline';
    dataFreshness.value = 'stale';
    setTimeout(connectWebSocket, 2000);
  };
}
