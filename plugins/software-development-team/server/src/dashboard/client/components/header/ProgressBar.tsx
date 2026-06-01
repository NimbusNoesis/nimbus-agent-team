import { currentRun, completedSteps, totalSteps } from '../../state/store';

export function ProgressBar() {
  const run = currentRun.value;
  const total = totalSteps.value;
  const completed = completedSteps.value;

  if (!run || total === 0) {
    return <div class="progress-bar-container hidden" />;
  }

  const pct = Math.round((completed / total) * 100);

  return (
    <div class="progress-bar-container">
      <div class="progress-bar-fill" style={{ width: `${pct}%` }} />
      <span class="progress-bar-label">{completed}/{total}</span>
    </div>
  );
}
