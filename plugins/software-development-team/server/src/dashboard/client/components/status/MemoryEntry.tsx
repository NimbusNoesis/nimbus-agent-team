import { useState } from 'preact/hooks';
import { expandedMemoryKeys, toggleMemoryKey } from '../../state/store';
import type { MemoryEntry } from '../../state/store';

interface Props {
  entry: MemoryEntry;
  namespace: string;
  borderColor: string;
}

function contentId(key: string) {
  return `memory-entry-${encodeURIComponent(key).replace(/%/g, '-')}`;
}

export function MemoryEntryCard({ entry, namespace, borderColor }: Props) {
  const [copyStatus, setCopyStatus] = useState('');
  const entryKey = `${namespace}:${entry.key}`;
  const isExpanded = expandedMemoryKeys.value.has(entryKey);
  const isLong = entry.value.length > 100;
  const displayedValue = isLong && !isExpanded ? `${entry.value.slice(0, 100)}\u2026` : entry.value;
  const valueId = contentId(entryKey);
  const timestamp = new Date(entry.updatedAt);
  const formattedTimestamp = Number.isNaN(timestamp.getTime()) ? 'Unknown time' : timestamp.toLocaleString();

  const copyValue = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard is unavailable');
      await navigator.clipboard.writeText(entry.value);
      setCopyStatus(`Copied ${entry.key}.`);
    } catch {
      setCopyStatus(`Could not copy ${entry.key}.`);
    }
  };

  return (
    <article
      class={`memory-entry${isExpanded ? ' expanded' : ''}`}
      style={{ borderColor }}
      role="listitem"
    >
      <dl class="memory-entry-details">
        <div class="memory-entry-header">
          <dt class="visually-hidden">Key</dt>
          <dd class="memory-entry-key">{entry.key}</dd>
          <dt class="visually-hidden">Updated</dt>
          <dd class="memory-entry-time">
            <time dateTime={entry.updatedAt}>{formattedTimestamp}</time>
          </dd>
        </div>
        <div>
          <dt class="visually-hidden">Value</dt>
          <dd id={valueId} class="memory-entry-value">{displayedValue}</dd>
        </div>
      </dl>
      <div class="memory-entry-actions">
        {isLong && (
          <button
            class="memory-entry-toggle"
            type="button"
            aria-expanded={isExpanded}
            aria-controls={valueId}
            onClick={() => toggleMemoryKey(entryKey)}
          >
            {isExpanded ? 'Show less' : 'Show more'}
          </button>
        )}
        <button class="memory-entry-copy" type="button" onClick={() => void copyValue()}>
          Copy value
        </button>
      </div>
      <span class="visually-hidden" role="status" aria-live="polite">{copyStatus}</span>
    </article>
  );
}
