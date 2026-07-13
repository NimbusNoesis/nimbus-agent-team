import { AsyncState } from '../common/AsyncState';
import {
  connectionStatus,
  currentRun,
  dataFreshness,
  loadingRunId,
  memoryEntries,
} from '../../state/store';
import { NAMESPACE_ORDER } from '../../utils/constants';
import { MemoryGroup } from './MemoryGroup';

export function MemoryPanel() {
  const entries = memoryEntries.value;
  const run = currentRun.value;
  const isLoading = dataFreshness.value === 'loading' || loadingRunId.value === run?.id;
  const state = isLoading
    ? 'loading'
    : entries.length === 0 && connectionStatus.value === 'offline'
      ? 'error'
      : entries.length === 0
        ? 'empty'
        : dataFreshness.value === 'stale'
          ? 'stale'
          : 'ready';

  const grouped: Record<string, typeof entries> = {};
  entries.forEach(entry => {
    if (!grouped[entry.namespace]) grouped[entry.namespace] = [];
    grouped[entry.namespace].push(entry);
  });

  const namespaces = NAMESPACE_ORDER.filter(namespace => grouped[namespace]);
  Object.keys(grouped).sort().forEach(namespace => {
    if (!namespaces.includes(namespace)) namespaces.push(namespace);
  });

  return (
    <AsyncState
      state={state}
      label="Shared memory"
      message={state === 'empty'
        ? 'No shared memory entries yet.'
        : state === 'stale'
          ? 'Showing last-known shared memory while the connection recovers.'
          : undefined}
      preserveContent={entries.length > 0}
    >
      <div id="memory-summary" aria-labelledby="shared-memory-heading">
        <p class="memory-summary-count">
          {entries.length} {entries.length === 1 ? 'entry' : 'entries'} across {namespaces.length}{' '}
          {namespaces.length === 1 ? 'namespace' : 'namespaces'}
        </p>
        {namespaces.map(namespace => (
          <MemoryGroup key={namespace} namespace={namespace} entries={grouped[namespace]} />
        ))}
      </div>
    </AsyncState>
  );
}
