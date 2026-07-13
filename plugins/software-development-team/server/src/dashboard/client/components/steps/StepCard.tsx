import { expandedStepId, toggleStep } from '../../state/store';
import type { StepState } from '../../state/store';
import { VALID_STATUSES, STEP_ICONS, STATUS_COLOR_MAP } from '../../utils/constants';
import { StepDetail } from './StepDetail';

interface Props { stepState: StepState; }

export function StepCard({ stepState: s }: Props) {
  const safeStatus = VALID_STATUSES.has(s.status) ? s.status : 'pending';
  const isExpanded = expandedStepId.value === s.step.id;
  const icon = STEP_ICONS[s.status] || '\u25CB';
  const colorVar = STATUS_COLOR_MAP[s.status] || 'active';
  const detailId = `step-${s.step.id}-detail`;
  const statusLabel = s.status === 'cancelling'
    ? 'CANCELLING — DRAINING'
    : s.status === 'cancelled'
      ? 'CANCELLED — TERMINAL'
      : s.status.toUpperCase();

  return (
    <div class={`step ${safeStatus}${isExpanded ? ' expanded' : ''}`}>
      <button
        type="button"
        class="step-header"
        aria-expanded={isExpanded}
        aria-controls={detailId}
        onClick={() => toggleStep(s.step.id)}
      >
        <div class="step-label" style={{ color: `var(--${colorVar})` }}>
          <span aria-hidden="true">{icon}</span> Step {s.step.id} — {statusLabel}
        </div>
        <div class="step-desc">{s.step.description}</div>
        {s.retryCount > 0 && <div class="step-retry">Retry {s.retryCount}/3</div>}
        {(s.manualAttempt ?? 0) > 0 && <div class="step-manual-attempt">Manual attempt {s.manualAttempt}</div>}
      </button>
      {isExpanded && <StepDetail id={detailId} stepState={s} />}
    </div>
  );
}
