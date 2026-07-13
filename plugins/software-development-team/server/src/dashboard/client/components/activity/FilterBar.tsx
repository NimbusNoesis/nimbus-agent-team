import { currentFilter, messageCounts, setFilter } from '../../state/store';
import { FILTER_TYPES } from '../../utils/constants';

export const ACTIVITY_FILTER_TYPES = [...FILTER_TYPES, 'control'] as const;

interface Props {
  counts?: Record<string, number>;
}

export function FilterBar({ counts = messageCounts.value }: Props) {
  const active = ACTIVITY_FILTER_TYPES.includes(currentFilter.value as typeof ACTIVITY_FILTER_TYPES[number])
    ? currentFilter.value
    : 'all';

  return (
    <div id="filter-bar" role="group" aria-label="Filter run activity">
      {ACTIVITY_FILTER_TYPES.map(type => (
        <button
          key={type}
          type="button"
          class={`filter-btn${active === type ? ' active' : ''}`}
          aria-pressed={active === type}
          aria-label={`${type === 'all' ? 'All activity' : `${type} activity`}, ${counts[type] || 0}`}
          onClick={() => setFilter(type)}
        >
          <span>{type}</span>
          <span class="filter-count" aria-hidden="true">{counts[type] || 0}</span>
        </button>
      ))}
      {active !== 'all' && (
        <button type="button" class="filter-clear" onClick={() => setFilter('all')}>
          Clear filter
        </button>
      )}
    </div>
  );
}
