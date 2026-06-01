import { allRuns, currentRun } from '../../state/store';
import { selectRun } from '../../state/api';
import { getRunLabel } from '../../utils/format';

export function RunSelector() {
  const runs = allRuns.value;
  const run = currentRun.value;

  if (runs.length <= 1) return null;

  const handleChange = (e: Event) => {
    const target = e.target as HTMLSelectElement;
    const selected = runs.find(r => r.id === target.value);
    if (selected) selectRun(selected);
  };

  return (
    <select
      id="run-selector"
      style="background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:2px 6px;font-size:11px;margin-left:8px;"
      onChange={handleChange}
    >
      {runs.map((r, i) => (
        <option key={r.id} value={r.id} selected={run?.id === r.id}>
          {getRunLabel(r, i)} ({r.status})
        </option>
      ))}
    </select>
  );
}
