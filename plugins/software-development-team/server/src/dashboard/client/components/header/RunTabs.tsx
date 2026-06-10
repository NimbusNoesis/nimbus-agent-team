import { useRef, useEffect } from 'preact/hooks';
import { allRuns, currentRun } from '../../state/store';
import { selectRun } from '../../state/api';

// Human-readable label per run status, shown in each tab's tooltip.
const STATUS_LABEL: Record<string, string> = {
  planning: 'Planning',
  ready: 'Ready',
  in_progress: 'Running',
  escalated: 'Escalated',
  complete: 'Complete',
};

export function RunTabs() {
  const runs = allRuns.value;
  const current = currentRun.value;
  const activeRef = useRef<HTMLButtonElement>(null);

  // Keep the selected run's tab in view as runs come and go or selection changes.
  useEffect(() => {
    const el = activeRef.current;
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, [current?.id, runs.length]);

  if (runs.length === 0) return null;

  return (
    <nav class="run-tabs" aria-label="Runs">
      {runs.map((r, i) => {
        const isActive = current?.id === r.id;
        const total = r.steps.length;
        const done = r.steps.filter(s => s.status === 'complete').length;
        const task = r.task
          ? (r.task.length > 36 ? r.task.slice(0, 36) + '…' : r.task)
          : r.id.slice(0, 8);
        const statusLabel = STATUS_LABEL[r.status] ?? r.status;
        return (
          <button
            key={r.id}
            ref={isActive ? activeRef : undefined}
            type="button"
            class={`run-tab${isActive ? ' active' : ''}`}
            data-status={r.status}
            aria-current={isActive ? 'true' : undefined}
            title={`${r.task ?? r.id} — ${statusLabel}`}
            onClick={() => { if (!isActive) selectRun(r); }}
          >
            <span class="run-tab-dot" />
            <span class="run-tab-num">#{i + 1}</span>
            <span class="run-tab-task">{task}</span>
            <span class="run-tab-progress">{done}/{total}</span>
          </button>
        );
      })}
    </nav>
  );
}
