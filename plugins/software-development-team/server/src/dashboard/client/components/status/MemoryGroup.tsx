import { NAMESPACE_COLORS } from '../../utils/constants';
import { MemoryEntryCard } from './MemoryEntry';
import type { MemoryEntry } from '../../state/store';

interface Props {
  namespace: string;
  entries: MemoryEntry[];
}

export function MemoryGroup({ namespace, entries }: Props) {
  const nsStyle = NAMESPACE_COLORS[namespace] || { color: 'var(--text)', bg: 'rgba(255,255,255,0.05)', border: 'rgba(255,255,255,0.15)' };

  return (
    <div class="memory-group">
      <div class="memory-group-header">
        <span
          class="memory-ns-badge"
          style={{ color: nsStyle.color, background: nsStyle.bg, borderColor: nsStyle.border }}
        >
          {namespace}
        </span>
        <span class="memory-group-count">{entries.length}</span>
      </div>
      {entries.map(entry => (
        <MemoryEntryCard key={`${namespace}:${entry.key}`} entry={entry} namespace={namespace} borderColor={nsStyle.border} />
      ))}
    </div>
  );
}
