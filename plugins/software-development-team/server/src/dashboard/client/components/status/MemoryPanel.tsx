import { memoryEntries } from '../../state/store';
import { NAMESPACE_ORDER } from '../../utils/constants';
import { MemoryGroup } from './MemoryGroup';

export function MemoryPanel() {
  const entries = memoryEntries.value;

  if (!entries || entries.length === 0) {
    return (
      <div id="memory-summary">
        <div class="memory-empty">No shared memory entries yet</div>
      </div>
    );
  }

  // Group by namespace
  const grouped: Record<string, typeof entries> = {};
  entries.forEach(entry => {
    if (!grouped[entry.namespace]) grouped[entry.namespace] = [];
    grouped[entry.namespace].push(entry);
  });

  // Order: predefined first, then extras
  const namespaces = NAMESPACE_ORDER.filter(ns => grouped[ns]);
  Object.keys(grouped).forEach(ns => {
    if (!namespaces.includes(ns)) namespaces.push(ns);
  });

  return (
    <div id="memory-summary">
      {namespaces.map(ns => (
        <MemoryGroup key={ns} namespace={ns} entries={grouped[ns]} />
      ))}
    </div>
  );
}
