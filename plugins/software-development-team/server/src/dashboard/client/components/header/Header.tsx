import { currentRun, allRuns, completedSteps, totalSteps } from '../../state/store';
import { CONTROL_PHASE_LABELS, VALID_STATUSES } from '../../utils/constants';
import { getRunLabel } from '../../utils/format';
import { ConnectionStatus } from './ConnectionStatus';
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
  let runLabel = '';
  if (run) {
    const runIndex = runs.findIndex(r => r.id === run.id);
    runLabel = runIndex !== -1 ? getRunLabel(run, runIndex) : `Run ${run.id.slice(0, 8)}`;
    const retries = run.steps.reduce((sum, s) => sum + s.retryCount, 0);
    const cancelled = run.steps.filter(step => step.status === 'cancelled').length;
    runInfo = `${runLabel} · Step ${completedSteps.value}/${totalSteps.value}${cancelled > 0 ? ` · ${cancelled} cancelled` : ''}${retries > 0 ? ` · ${retries} retries` : ''}`;
  }

  const activeWorkers = run?.steps.filter(step =>
    ['coding', 'reviewing', 'cancelling'].includes(step.status) && step.assignedAgent
  ).length ?? 0;
  const escalations = run?.steps.filter(step => step.status === 'escalated').length ?? 0;
  const blockers = run?.steps.filter(step => step.status === 'pending' && step.step.dependsOn.some(id =>
    run.steps.find(candidate => candidate.step.id === id)?.status !== 'complete'
  )).length ?? 0;
  const phase = run?.lifecycle?.version === 2 ? run.lifecycle.controlPhase : undefined;

  return (
    <header aria-label="Run overview">
      <div class="header-left">
        <span class="title">NimbusNoesis Agent Coding Team</span>
        <span class={badgeClass}>{badgeText}</span>
        {run && phase && phase !== 'none' && (
          <span class={`badge ${phase}`}>{CONTROL_PHASE_LABELS[phase] ?? phase}</span>
        )}
      </div>
      <div class="header-center">
        <ProgressBar />
      </div>
      <div class="header-right">
        {run && <span class="selected-run" title={run.task}>Selected {runLabel}</span>}
        <span>{runInfo}</span>
        {run && (
          <span class="run-health" aria-label="Run health">
            {activeWorkers} active workers · {blockers} blockers · {escalations} escalations
          </span>
        )}
        {run?.lifecycle?.version === 2 && (
          <span class="lifecycle-revision">Revision {run.lifecycle.revision}</span>
        )}
        <ConnectionStatus />
      </div>
    </header>
  );
}
