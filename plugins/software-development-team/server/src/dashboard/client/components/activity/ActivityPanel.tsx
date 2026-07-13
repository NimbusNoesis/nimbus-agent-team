import { useEffect, useRef, useState } from 'preact/hooks';
import {
  connectionStatus,
  currentFilter,
  currentRun,
  dataFreshness,
  lastSyncedAt,
  loadingRunId,
  messages,
} from '../../state/store';
import type { Message } from '../../state/store';
import { refreshRuns } from '../../state/api';
import { AsyncState } from '../common/AsyncState';
import { FilterBar, ACTIVITY_FILTER_TYPES } from './FilterBar';
import { MessageList, selectedActivityItems } from './MessageList';

function mergeMessagesForRun(history: typeof messages.value, live: typeof messages.value) {
  const byId = new Map([...history, ...live].map(message => [message.id, message]));
  return [...byId.values()].sort((left, right) =>
    left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id)
  );
}

function formattedSyncTime(value: string | null): string {
  if (!value) return 'not yet synchronized';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'sync time unavailable' : `updated ${date.toLocaleTimeString()}`;
}

async function refreshMessages(runId: string): Promise<Message[]> {
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/messages`);
  if (!response.ok) throw new Error(`Activity request failed with status ${response.status}`);
  return response.json();
}

export function ActivityPanel() {
  const selectedRunId = currentRun.value?.id ?? null;
  const selectedRunIdRef = useRef(selectedRunId);
  const requestSequenceRef = useRef(0);
  const [retryState, setRetryState] = useState<{
    runId: string | null;
    requestId: number;
    status: 'idle' | 'loading' | 'error';
  }>({ runId: selectedRunId, requestId: 0, status: 'idle' });

  // Signals can switch the selected run while a request is in flight. Update
  // the guard during render so even a promise settling before effects run is
  // unable to publish state into the newly selected workspace.
  if (selectedRunIdRef.current !== selectedRunId) {
    selectedRunIdRef.current = selectedRunId;
    requestSequenceRef.current += 1;
  }
  useEffect(() => {
    setRetryState(previous => previous.runId === selectedRunId
      ? previous
      : { runId: selectedRunId, requestId: requestSequenceRef.current, status: 'idle' });
  }, [selectedRunId]);

  const visibleRetryState = retryState.runId === selectedRunId ? retryState.status : 'idle';
  const items = selectedActivityItems();
  const activeFilter = ACTIVITY_FILTER_TYPES.includes(currentFilter.value as typeof ACTIVITY_FILTER_TYPES[number])
    ? currentFilter.value
    : 'all';
  const filteredCount = activeFilter === 'all'
    ? items.length
    : items.filter(item => item.type === activeFilter).length;
  const counts: Record<string, number> = Object.fromEntries(ACTIVITY_FILTER_TYPES.map(type => [type, 0]));
  for (const item of items) {
    counts.all += 1;
    counts[item.type] = (counts[item.type] ?? 0) + 1;
  }

  const retry = async () => {
    const run = currentRun.value;
    if (!run) return;
    const requestId = ++requestSequenceRef.current;
    setRetryState({ runId: run.id, requestId, status: 'loading' });
    const isCurrentRequest = () => selectedRunIdRef.current === run.id
      && currentRun.value?.id === run.id
      && requestSequenceRef.current === requestId;
    try {
      const [, history] = await Promise.all([refreshRuns(run.id), refreshMessages(run.id)]);
      if (isCurrentRequest()) {
        messages.value = mergeMessagesForRun(history, messages.value);
        setRetryState({ runId: run.id, requestId, status: 'idle' });
      }
    } catch (error) {
      console.warn('Failed to refresh activity:', error);
      if (isCurrentRequest()) {
        setRetryState({ runId: run.id, requestId, status: 'error' });
      }
    }
  };

  const isLoading = visibleRetryState === 'loading'
    || dataFreshness.value === 'loading'
    || loadingRunId.value === currentRun.value?.id;
  const asyncState = visibleRetryState === 'error'
    ? 'error'
    : isLoading
      ? 'loading'
      : dataFreshness.value === 'stale'
        ? items.length > 0 ? 'stale' : 'error'
        : filteredCount === 0
          ? 'empty'
          : 'ready';
  const emptyMessage = items.length === 0
    ? 'No activity has been recorded for this run.'
    : `No ${activeFilter} activity matches this filter.`;
  const activityFreshness = visibleRetryState === 'error' ? 'activity refresh failed' : dataFreshness.value;
  const statusText = `${connectionStatus.value}. ${activityFreshness}. ${formattedSyncTime(lastSyncedAt.value)}.`;

  return (
    <div class="activity-panel-content">
      <div class="activity-connection-status" role="status" aria-live="polite">
        <span class={`connection-cue connection-${connectionStatus.value}`} aria-hidden="true">
          {connectionStatus.value === 'online' ? '●' : connectionStatus.value === 'connecting' ? '◌' : '○'}
        </span>{' '}
        {statusText}
      </div>
      <FilterBar counts={counts} />
      <AsyncState
        state={asyncState}
        label="Run activity"
        message={asyncState === 'empty' ? emptyMessage : asyncState === 'error'
          ? 'Activity could not be refreshed. Existing entries may be out of date.'
          : undefined}
        onRetry={() => void retry()}
        preserveContent={items.length > 0}
      >
        <MessageList runId={selectedRunId ?? undefined} items={items} />
      </AsyncState>
    </div>
  );
}
