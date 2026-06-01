import { expandedMemoryKeys, toggleMemoryKey } from '../../state/store';
import type { MemoryEntry } from '../../state/store';

interface Props {
  entry: MemoryEntry;
  namespace: string;
  borderColor: string;
}

export function MemoryEntryCard({ entry, namespace, borderColor }: Props) {
  const entryKey = `${namespace}:${entry.key}`;
  const isExpanded = expandedMemoryKeys.value.has(entryKey);
  const truncated = entry.value.length > 100 ? entry.value.slice(0, 100) + '\u2026' : entry.value;

  return (
    <div
      class={`memory-entry${isExpanded ? ' expanded' : ''}`}
      style={{ borderColor }}
      onClick={() => toggleMemoryKey(entryKey)}
    >
      <div class="memory-entry-header">
        <div class="memory-entry-key">{entry.key}</div>
        <div class="memory-entry-time">{new Date(entry.updatedAt).toLocaleTimeString()}</div>
      </div>
      <div class="memory-entry-value">{isExpanded ? entry.value : truncated}</div>
      {entry.value.length > 100 && (
        <div class="memory-entry-toggle">{isExpanded ? 'Show less' : 'Show more'}</div>
      )}
    </div>
  );
}
