import { allRuns, currentRun, messages, memoryEntries } from './store';
import { fetchRuns, fetchMemory } from './api';

export function connectWebSocket(): void {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}`);

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
    }
  };

  ws.onerror = () => ws.close();
  ws.onclose = () => setTimeout(connectWebSocket, 2000);
}
