import { useState, useEffect } from 'preact/hooks';
import { currentRun } from '../../state/store';
import type { StepState } from '../../state/store';
import { WIP_LIMIT } from '../../../../constants';

interface Props { stepState: StepState; }

export function StepDetail({ stepState: s }: Props) {
  const run = currentRun.value;
  const [now, setNow] = useState(Date.now());

  // Keep the "running" elapsed value live while the step is in progress.
  const isRunning = !!s.startedAt && !s.completedAt;
  useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isRunning]);
  void now;

  // Compute blocking reasons for pending steps
  const blockingReasons: string[] = [];
  if (s.status === 'pending' && run) {
    if (s.step.dependsOn?.length) {
      s.step.dependsOn.forEach(depId => {
        const depStep = run.steps.find(ds => ds.step.id === depId);
        if (!depStep || depStep.status !== 'complete') {
          const desc = depStep ? depStep.step.description : 'unknown step';
          blockingReasons.push(`Waiting on step ${depId}: ${desc}`);
        }
      });
    }
    const wipCount = run.steps.filter(ds => ds.status === 'coding' || ds.status === 'reviewing').length;
    if (wipCount >= WIP_LIMIT) blockingReasons.push(`WIP limit reached (max ${WIP_LIMIT} concurrent steps)`);
  }

  // Compute file conflicts for active steps
  const fileConflicts: string[] = [];
  if ((s.status === 'coding' || s.status === 'reviewing') && run) {
    run.steps.forEach(other => {
      if (other.step.id === s.step.id) return;
      if (other.status !== 'coding' && other.status !== 'reviewing') return;
      (s.step.files || []).forEach(file => {
        if (other.claimedFiles?.includes(file)) fileConflicts.push(file);
      });
    });
  }

  function formatTimingElapsed(startIso: string, endIso?: string): string {
    const elapsed = Math.round(((endIso ? new Date(endIso).getTime() : Date.now()) - new Date(startIso).getTime()) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    return `${mins > 0 ? `${mins}m ` : ''}${secs}s${!endIso ? ' (running)' : ''}`;
  }

  return (
    <div class="step-detail">
      {blockingReasons.length > 0 && (
        <div class="step-detail-section step-blocking">
          <div class="step-detail-title">{'\u26A0'} Blocking Reasons</div>
          {blockingReasons.map((reason, i) => (
            <div key={i} class="step-blocking-item">{reason}</div>
          ))}
        </div>
      )}

      {s.result && (
        <div class={`step-detail-section step-result step-result-${s.result.status || ''}`}>
          <div class="step-detail-title">Result</div>
          <div class="step-result-summary">{s.result.summary || (s.result.status || '').toUpperCase()}</div>
          {s.result.details && <div class="step-result-details">{s.result.details}</div>}
        </div>
      )}

      {s.step.acceptanceCriteria?.length > 0 && (
        <div class="step-detail-section">
          <div class="step-detail-title">Acceptance Criteria</div>
          <ul class="step-criteria-list">
            {s.step.acceptanceCriteria.map((criterion, i) => {
              const isComplete = s.status === 'complete';
              return (
                <li key={i} class="step-criteria-item">
                  <span class={`step-criteria-check${isComplete ? ' checked' : ''}`}>
                    {isComplete ? '\u2713' : '\u25CB'}
                  </span>
                  <span>{criterion}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {s.step.files?.length > 0 && (
        <div class="step-detail-section">
          <div class="step-detail-title">Files</div>
          <ul class="step-files-list">
            {s.step.files.map(file => {
              const hasConflict = fileConflicts.includes(file);
              return (
                <li key={file} class={`step-file-item${hasConflict ? ' conflict' : ''}`}>
                  {file}{hasConflict ? ' \u26A0 conflict' : ''}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {s.step.dependsOn?.length > 0 && (
        <div class="step-detail-section">
          <div class="step-detail-title">Dependencies</div>
          <ul class="step-deps-list">
            {s.step.dependsOn.map(depId => {
              const depStep = run?.steps.find(ds => ds.step.id === depId);
              const isMet = depStep?.status === 'complete';
              const desc = depStep?.step.description ?? '';
              const truncDesc = desc.length > 50 ? desc.slice(0, 50) + '\u2026' : desc;
              return (
                <li key={depId} class={`step-dep-item${isMet ? ' met' : ' unmet'}`}>
                  Step {depId}{depStep ? `: ${truncDesc}` : ''} — {isMet ? 'complete' : (depStep ? depStep.status : 'unknown')}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {(s.startedAt || s.completedAt) && (
        <div class="step-detail-section step-timing">
          <div class="step-detail-title">Timing</div>
          <div class="step-timing-grid">
            {s.startedAt && (
              <div class="step-timing-row">
                <span class="step-timing-label">Started</span>
                <span class="step-timing-value">{new Date(s.startedAt).toLocaleTimeString()}</span>
              </div>
            )}
            {s.completedAt && (
              <div class="step-timing-row">
                <span class="step-timing-label">Completed</span>
                <span class="step-timing-value">{new Date(s.completedAt).toLocaleTimeString()}</span>
              </div>
            )}
            {s.startedAt && (
              <div class="step-timing-row">
                <span class="step-timing-label">Elapsed</span>
                <span class="step-timing-value">{formatTimingElapsed(s.startedAt, s.completedAt)}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
