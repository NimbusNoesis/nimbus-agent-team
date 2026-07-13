import { useEffect, useState } from 'preact/hooks';
import { currentRun, messages } from '../../state/store';
import { formatElapsed, formatRelativeTime } from '../../utils/format';
import type { RunState, StepState } from '../../state/store';

interface Props {
  agentName: string;
}

interface RosterState {
  active: boolean;
  detail?: string;
  label: string;
  step: StepState | null;
}

function coordinatorState(run: RunState | null): RosterState {
  if (!run) return { active: false, label: 'IDLE', step: null };

  const phase = run.lifecycle?.controlPhase ?? 'none';
  if (phase === 'pausing') {
    return {
      active: true,
      label: 'PAUSING',
      detail: 'Draining active workers before the pause is acknowledged…',
      step: null,
    };
  }
  if (phase === 'paused') {
    return {
      active: true,
      label: 'PAUSED',
      detail: 'Monitoring the paused selected run; no new work is being admitted.',
      step: null,
    };
  }
  if (phase === 'cancelling') {
    return {
      active: true,
      label: 'CANCELLING',
      detail: 'Draining active workers before cancellation is acknowledged…',
      step: null,
    };
  }
  if (phase === 'cancelled' || run.status === 'cancelled') {
    return {
      active: false,
      label: 'CANCELLED',
      detail: 'The selected run is terminally cancelled.',
      step: null,
    };
  }
  if (run.status === 'in_progress') {
    return {
      active: true,
      label: 'ORCHESTRATING',
      detail: 'Orchestrating selected run…',
      step: null,
    };
  }
  return { active: false, label: 'IDLE', step: null };
}

function workerState(run: RunState | null, agentName: string): RosterState {
  if (!run) return { active: false, label: 'IDLE', step: null };

  const directStep = agentName === 'reviewer'
    ? run.steps.find(step => step.status === 'reviewing')
    : run.steps.find(step => step.assignedAgent === agentName && step.status === 'coding');
  if (directStep) {
    return { active: true, label: directStep.status.toUpperCase(), step: directStep };
  }

  // Cancellation deliberately retains assignment and file claims while the
  // native worker drains. The former status is no longer stored, so a result
  // is the durable evidence that the step had reached review; otherwise the
  // assigned implementation role remains the best available authority.
  const drainingStep = agentName === 'reviewer'
    ? run.steps.find(step => step.status === 'cancelling' && step.result !== null)
    : run.steps.find(step => (
      step.status === 'cancelling'
      && step.assignedAgent === agentName
      && step.result === null
    ));
  if (drainingStep) {
    return {
      active: true,
      label: 'CANCELLING',
      detail: `Draining ${agentName} before cancellation acknowledgement; the step and its file claims remain assigned.`,
      step: drainingStep,
    };
  }

  return { active: false, label: 'IDLE', step: null };
}

export function AgentCard({ agentName }: Props) {
  const run = currentRun.value;
  const [now, setNow] = useState(Date.now());

  // Assignment and lifecycle state are authoritative. Messages provide only
  // last-activity context; they never fabricate a native worker as active.
  const rosterState = agentName === 'coordinator'
    ? coordinatorState(run)
    : workerState(run, agentName);
  const activeStep = rosterState.step;
  const isActive = rosterState.active;

  const runMessages = run ? messages.value.filter(message => message.runId === run.id) : [];
  const lastMessage = [...runMessages].reverse().find(message => message.from === agentName) ?? null;
  const lastActivityTs = lastMessage?.timestamp ?? null;
  const statusLabel = rosterState.label;

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
      {rosterState.detail && <p class="agent-step-info">{rosterState.detail}</p>}

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
