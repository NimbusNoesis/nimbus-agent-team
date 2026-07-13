import { useEffect, useState } from 'preact/hooks';
import { currentRun, messages } from '../../state/store';
import { formatElapsed, formatRelativeTime } from '../../utils/format';

interface Props {
  agentName: string;
}

export function AgentCard({ agentName }: Props) {
  const run = currentRun.value;
  const [now, setNow] = useState(Date.now());

  // Assignment and lifecycle state are authoritative. Messages provide only
  // last-activity context; they never fabricate a native worker as active.
  const activeStep = agentName === 'reviewer'
    ? run?.steps.find(step => step.status === 'reviewing') ?? null
    : run?.steps.find(step => step.assignedAgent === agentName && step.status === 'coding') ?? null;
  const coordinatorActive = agentName === 'coordinator' && run?.status === 'in_progress';
  const isActive = activeStep !== null || coordinatorActive;

  const runMessages = run ? messages.value.filter(message => message.runId === run.id) : [];
  const lastMessage = [...runMessages].reverse().find(message => message.from === agentName) ?? null;
  const lastActivityTs = lastMessage?.timestamp ?? null;
  const statusLabel = activeStep ? activeStep.status.toUpperCase() : coordinatorActive ? 'ORCHESTRATING' : 'IDLE';

  useEffect(() => {
    if (!isActive) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isActive]);

  void now;

  return (
    <article
      class={`agent-card ${isActive ? 'active' : 'idle'}`}
      role="listitem"
      aria-label={`${agentName}, ${statusLabel.toLowerCase()}`}
    >
      <div class="agent-card-header">
        <span class={`agent-dot ${isActive ? 'active' : 'idle'}`} aria-hidden="true" />
        <h4 class="agent-name" style={{ color: `var(--${agentName})` }}>{agentName}</h4>
        <span class={`agent-status-badge ${isActive ? 'active' : 'idle'}`}>{statusLabel}</span>
      </div>

      {activeStep && (
        <p class="agent-step-info">
          Step {activeStep.step.id}: {(activeStep.step.description ?? '').slice(0, 60)}
          {(activeStep.step.description ?? '').length > 60 ? '\u2026' : ''}
        </p>
      )}
      {!activeStep && coordinatorActive && <p class="agent-step-info">Orchestrating selected run…</p>}

      {activeStep?.startedAt && (
        <p class="agent-timer-row">
          <span class="agent-timer-label">Elapsed:</span>{' '}
          <span class="agent-elapsed">{formatElapsed(activeStep.startedAt)}</span>
        </p>
      )}

      {lastActivityTs && (
        <p class="agent-last-active">Last recorded activity: {formatRelativeTime(lastActivityTs)}</p>
      )}
      <span class="agent-truth-source visually-hidden">Status inferred from the selected run lifecycle.</span>
    </article>
  );
}
