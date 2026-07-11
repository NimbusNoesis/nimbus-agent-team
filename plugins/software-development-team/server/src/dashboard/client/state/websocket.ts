import { allRuns, currentRun, messages, memoryEntries } from './store';
import { fetchRuns, fetchMemory } from './api';

// Single-flight guard: the socket currently connecting or connected. Each
// socket self-perpetuates via onclose → setTimeout(connectWebSocket, 2000),
// so if app init retries after a partial failure and calls connectWebSocket
// again, a second concurrent socket would otherwise be opened and both would
// reconnect forever. While this socket is CONNECTING or OPEN, further
// connectWebSocket calls are no-ops.
let currentSocket: WebSocket | null = null;

export function connectWebSocket(): void {
  if (
    currentSocket &&
    (currentSocket.readyState === WebSocket.CONNECTING ||
      currentSocket.readyState === WebSocket.OPEN)
  ) {
    return;
  }

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}`);
  currentSocket = ws;

  ws.onopen = async () => {
    try {
      const runs = await fetchRuns();
      allRuns.value = runs;
      if (currentRun.value) {
        const updated = runs.find(r => r.id === currentRun.value!.id);
        if (updated) currentRun.value = updated;
      }
      memoryEntries.value = await fetchMemory();
    } catch (e) {
      console.error('Failed to re-sync after WebSocket connect:', e);
    }
  };

  ws.onmessage = (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch (e) {
      console.error('Failed to parse WebSocket message:', e);
      return;
    }

    if (data.type === 'state_update') {
      const idx = allRuns.value.findIndex(r => r.id === data.run.id);
      const newRuns = [...allRuns.value];
      if (idx !== -1) newRuns[idx] = data.run;
      else newRuns.push(data.run);
      allRuns.value = newRuns;

      if (currentRun.value && currentRun.value.id === data.run.id) {
        currentRun.value = data.run;
      }
    } else if (data.type === 'new_message') {
      // Append live messages even while a run's history is loading; selectRun
      // dedupes against the fetched history by id so nothing is lost or doubled.
      if (!currentRun.value || data.message.runId === currentRun.value.id) {
        if (messages.value.some(m => m.id === data.message.id)) return;
        messages.value = [...messages.value, data.message];
      }
    } else if (data.type === 'memory_entry_update') {
      const idx = memoryEntries.value.findIndex(
        e => e.namespace === data.entry.namespace && e.key === data.entry.key
      );
      const newEntries = [...memoryEntries.value];
      if (idx !== -1) newEntries[idx] = data.entry;
      else newEntries.push(data.entry);
      memoryEntries.value = newEntries;
    } else if (data.type === 'memory_entry_delete') {
      memoryEntries.value = memoryEntries.value.filter(
        e => !(e.namespace === data.entry.namespace && e.key === data.entry.key)
      );
    }
  };

  ws.onerror = () => ws.close();
  ws.onclose = () => {
    // Release the guard before scheduling the reconnect (but only if a newer
    // socket hasn't already replaced this one), so the reconnect isn't a no-op.
    if (currentSocket === ws) currentSocket = null;
    setTimeout(connectWebSocket, 2000);
  };
}
