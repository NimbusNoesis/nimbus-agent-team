import { NAMESPACE_COLORS } from '../../utils/constants';
import { MemoryEntryCard } from './MemoryEntry';
import type { MemoryEntry } from '../../state/store';

interface Props {
  namespace: string;
  entries: MemoryEntry[];
}

function headingId(namespace: string) {
  return `memory-group-${encodeURIComponent(namespace).replace(/%/g, '-')}`;
}

export function MemoryGroup({ namespace, entries }: Props) {
  const nsStyle = NAMESPACE_COLORS[namespace] || {
    color: 'var(--text)',
    bg: 'rgba(255,255,255,0.05)',
    border: 'rgba(255,255,255,0.15)',
  };
  const id = headingId(namespace);

  return (
    <section class="memory-group" aria-labelledby={id}>
      <div class="memory-group-header">
        <h4
          id={id}
          class="memory-ns-badge"
          style={{ color: nsStyle.color, background: nsStyle.bg, borderColor: nsStyle.border }}
        >
          {namespace}
        </h4>
        <span class="memory-group-count" aria-label={`${entries.length} entries`}>{entries.length}</span>
      </div>
      <div class="memory-entry-list" role="list">
        {entries.map(entry => (
          <MemoryEntryCard
            key={`${namespace}:${entry.key}`}
            entry={entry}
            namespace={namespace}
            borderColor={nsStyle.border}
          />
        ))}
      </div>
    </section>
  );
}
