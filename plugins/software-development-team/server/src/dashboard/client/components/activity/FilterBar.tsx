import { currentFilter, messageCounts, setFilter } from '../../state/store';
import { FILTER_TYPES } from '../../utils/constants';

export function FilterBar() {
  const counts = messageCounts.value;
  const active = currentFilter.value;

  return (
    <div id="filter-bar">
      {FILTER_TYPES.map(type => (
        <button
          key={type}
          class={`filter-btn${active === type ? ' active' : ''}`}
          onClick={() => setFilter(type)}
        >
          <span>{type}</span>
          <span class="filter-count">{counts[type] || 0}</span>
        </button>
      ))}
    </div>
  );
}
