import { useState, useEffect } from 'preact/hooks';
import { currentRun, messages } from '../../state/store';
import { formatElapsed, formatRelativeTime } from '../../utils/format';

interface Props {
  agentName: string;
}

export function AgentCard({ agentName }: Props) {
  const run = currentRun.value;
  const [now, setNow] = useState(Date.now());

  // Find active step for this agent
  // - Coder: assigned to a step in 'coding' status
  // - Reviewer: any step in 'reviewing' status (assignedAgent stays as 'coder')
  // - Coordinator: always active when run is in_progress
  // - Planner/researcher/documentation: operate outside steps, use message-based detection
  const activeStep = agentName === 'reviewer'
    ? run?.steps.find(s => s.status === 'reviewing') || null
    : run?.steps.find(
        s => s.assignedAgent === agentName && s.status === 'coding'
      ) || null;

  // Find last two messages from this agent to detect in-flight work
  const allMessages = messages.value;
  let lastMsg: typeof allMessages[0] | null = null;
  for (let i = allMessages.length - 1; i >= 0; i--) {
    if (allMessages[i].from === agentName) {
      lastMsg = allMessages[i];
      break;
    }
  }
  // Agent is "in-flight" if their last message is a start (info) not a completion
  // (result/review) — but only while that message is recent. Without a cutoff a
  // final info message would keep the card ACTIVE (and its 1s interval running)
  // forever. `now` is the ticking state below, so once the message crosses the
  // cutoff the interval's own re-render flips this to false and the interval
  // effect's cleanup stops the timer without any user interaction.
  const INFO_STALENESS_MS = 10 * 60 * 1000;
  const isInFlight = lastMsg !== null && lastMsg.type === 'info' &&
    now - new Date(lastMsg.timestamp).getTime() < INFO_STALENESS_MS;

  const isActive = activeStep !== null ||
    (agentName === 'coordinator' && run?.status === 'in_progress') ||
    isInFlight;

  const lastActivityTs = lastMsg?.timestamp ?? null;

  // Tick timer every second while active so both the elapsed timer and the
  // "Last active" relative time stay live (in-flight agents have no startedAt).
  useEffect(() => {
    if (!isActive) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isActive]);

  // Use now to ensure re-render, but formatElapsed reads Date.now() internally
  void now;

  return (
    <div class={`agent-card ${isActive ? 'active' : 'idle'}`}>
      <div class="agent-card-header">
        <div class={`agent-dot ${isActive ? 'active' : 'idle'}`} />
        <div class="agent-name" style={{ color: `var(--${agentName})` }}>{agentName}</div>
        <div class={`agent-status-badge ${isActive ? 'active' : 'idle'}`}>
          {isActive ? (activeStep ? activeStep.status.toUpperCase() : 'ACTIVE') : 'IDLE'}
        </div>
      </div>

      {activeStep && (
        <div class="agent-step-info">
          Step {activeStep.step.id}: {(activeStep.step.description ?? '').slice(0, 60)}{(activeStep.step.description ?? '').length > 60 ? '\u2026' : ''}
        </div>
      )}
      {!activeStep && agentName === 'coordinator' && run?.status === 'in_progress' && (
        <div class="agent-step-info">Orchestrating run{'\u2026'}</div>
      )}
      {!activeStep && isInFlight && agentName !== 'coordinator' && lastMsg && (
        <div class="agent-step-info">{(lastMsg.body ?? '').slice(0, 80)}{(lastMsg.body ?? '').length > 80 ? '\u2026' : ''}</div>
      )}

      {activeStep?.startedAt && (
        <div class="agent-timer-row">
          <span class="agent-timer-label">Elapsed:</span>
          <span class="agent-elapsed">{formatElapsed(activeStep.startedAt)}</span>
        </div>
      )}

      {lastActivityTs && (
        <div class="agent-last-active">Last active: {formatRelativeTime(lastActivityTs)}</div>
      )}
    </div>
  );
}
