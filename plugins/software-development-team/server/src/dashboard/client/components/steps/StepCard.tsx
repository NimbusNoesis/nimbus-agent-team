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

  return (
    <div class={`step ${safeStatus}${isExpanded ? ' expanded' : ''}`}>
      <div class="step-header" onClick={() => toggleStep(s.step.id)}>
        <div class="step-label" style={{ color: `var(--${colorVar})` }}>
          {icon} Step {s.step.id} — {s.status.toUpperCase()}
        </div>
        <div class="step-desc">{s.step.description}</div>
        {s.retryCount > 0 && <div class="step-retry">Retry {s.retryCount}/3</div>}
      </div>
      {isExpanded && <StepDetail stepState={s} />}
    </div>
  );
}
