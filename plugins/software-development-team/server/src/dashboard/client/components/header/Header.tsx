import { currentRun, allRuns, completedSteps, totalSteps } from '../../state/store';
import { VALID_STATUSES } from '../../utils/constants';
import { getRunLabel } from '../../utils/format';
import { ProgressBar } from './ProgressBar';

export function Header() {
  const run = currentRun.value;
  const runs = allRuns.value;

  // Badge
  let badgeClass = 'badge hidden';
  let badgeText = '';
  if (run) {
    const statusClass = run.status === 'in_progress' ? 'running' : run.status;
    badgeClass = `badge ${VALID_STATUSES.has(statusClass) ? statusClass : 'ready'}`;
    badgeText = run.status.toUpperCase();
  }

  // Run info
  let runInfo = '';
  if (run) {
    const runIndex = runs.findIndex(r => r.id === run.id);
    const runLabel = runIndex !== -1 ? getRunLabel(run, runIndex) : `Run ${run.id.slice(0, 8)}`;
    const retries = run.steps.reduce((sum, s) => sum + s.retryCount, 0);
    runInfo = `${runLabel} · Step ${completedSteps.value}/${totalSteps.value}${retries > 0 ? ` · ${retries} retries` : ''}`;
  }

  return (
    <header>
      <div class="header-left">
        <span class="title">Claude Coding Team</span>
        <span class={badgeClass}>{badgeText}</span>
      </div>
      <div class="header-center">
        <ProgressBar />
      </div>
      <div class="header-right">
        <span>{runInfo}</span>
      </div>
    </header>
  );
}
