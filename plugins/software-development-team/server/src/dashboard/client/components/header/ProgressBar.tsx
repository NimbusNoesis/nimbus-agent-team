import { currentRun, completedSteps, totalSteps } from '../../state/store';

export function ProgressBar() {
  const run = currentRun.value;
  const total = totalSteps.value;
  const completed = completedSteps.value;

  if (!run || total === 0) {
    return <div class="progress-bar-container hidden" />;
  }

  const pct = Math.round((completed / total) * 100);
  const cancelled = run.steps.filter(step => step.status === 'cancelled').length;
  const progressText = `${completed} of ${total} steps complete${cancelled ? `; ${cancelled} cancelled` : ''}`;

  return (
    <div
      class="progress-bar-container"
      role="progressbar"
      aria-label="Run progress"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={completed}
      aria-valuetext={progressText}
    >
      <div class="progress-bar-fill" style={{ width: `${pct}%` }} />
      <span class="progress-bar-label" aria-hidden="true">{completed}/{total}</span>
      <span class="visually-hidden">{progressText}</span>
    </div>
  );
}
