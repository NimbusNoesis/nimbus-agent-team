import { currentRun, messages, memoryEntries, loadingRunId, currentFilter } from './store';
import type { RunState, Message, MemoryEntry } from './store';

export async function fetchRuns(): Promise<RunState[]> {
  const r = await fetch('/api/runs');
  if (!r.ok) throw new Error(`Server error: ${r.status}`);
  return r.json();
}

export async function fetchMessages(runId: string): Promise<Message[]> {
  const r = await fetch(`/api/runs/${encodeURIComponent(runId)}/messages`);
  if (!r.ok) {
    console.warn(`Failed to fetch messages for run ${runId}: server responded ${r.status}`);
    return [];
  }
  return r.json();
}

export async function fetchMemory(): Promise<MemoryEntry[]> {
  const r = await fetch('/api/memory');
  if (!r.ok) {
    console.warn(`Failed to fetch memory: server responded ${r.status}`);
    return [];
  }
  return r.json();
}

/** Returns true when the guidance was accepted by the server, false otherwise. */
export async function sendGuidance(runId: string, body: string): Promise<boolean> {
  try {
    const r = await fetch('/api/guidance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId, body }),
    });
    if (!r.ok) {
      console.warn(`Failed to send guidance: server responded ${r.status}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn('Failed to send guidance:', e);
    return false;
  }
}

export async function selectRun(run: RunState): Promise<void> {
  currentRun.value = run;
  loadingRunId.value = run.id;
  messages.value = [];
  currentFilter.value = 'all';

  try {
    const msgs = await fetchMessages(run.id);
    if (loadingRunId.value !== run.id) return; // Another selectRun was called
    // Merge fetched history with any live messages that arrived during the
    // fetch (appended by the WebSocket handler), deduped by id.
    const seen = new Set(msgs.map(m => m.id));
    const live = messages.value.filter(m => !seen.has(m.id));
    messages.value = [...msgs, ...live];
  } finally {
    if (loadingRunId.value === run.id) loadingRunId.value = null;
  }

  // Also refresh memory
  try {
    memoryEntries.value = await fetchMemory();
  } catch (e) {
    console.error('Failed to fetch memory:', e);
  }
}
