import { connectionStatus, currentRun, dataFreshness, lastSyncedAt } from '../../state/store';
import { CONNECTION_LABELS, FRESHNESS_LABELS } from '../../utils/constants';

export function ConnectionStatus() {
  const connection = connectionStatus.value;
  const freshness = dataFreshness.value;
  const syncedAt = lastSyncedAt.value;
  const supportsControls = currentRun.value?.lifecycle?.version === 2;

  return (
    <div class="connection-status" role="status" aria-live="polite" aria-atomic="true">
      <span class={`connection-indicator connection-${connection}`} data-status={connection}>
        <span aria-hidden="true" class="connection-dot" />
        Connection: {CONNECTION_LABELS[connection]}
      </span>
      <span class={`freshness-indicator freshness-${freshness}`} data-freshness={freshness}>
        Data: {FRESHNESS_LABELS[freshness]}
      </span>
      {syncedAt && (
        <span class="last-synced">
          Synced <time dateTime={syncedAt}>{new Date(syncedAt).toLocaleTimeString()}</time>
        </span>
      )}
      {currentRun.value && !supportsControls && (
        <span class="capability-fallback">Controls unavailable: read-only server</span>
      )}
    </div>
  );
}
