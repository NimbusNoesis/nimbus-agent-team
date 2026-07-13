import { useRef, useState } from 'preact/hooks';
import { executeControl } from '../../state/api';
import { currentRun, getControlAvailability, getControlOperation } from '../../state/store';
import type { StepState } from '../../state/store';
import { ControlConfirmationDialog } from './ControlConfirmationDialog';
import type { ControlIntent } from './ControlConfirmationDialog';
import { ControlStatus } from './ControlStatus';

interface Props { stepState: StepState; }

export function StepControls({ stepState }: Props) {
  const run = currentRun.value;
  const [intent, setIntent] = useState<ControlIntent | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  if (!run || run.lifecycle?.version !== 2) return null;

  const target = { kind: 'step' as const, stepId: stepState.step.id };
  const operation = getControlOperation(run.id, target);
  const pending = operation.status === 'pending' || operation.status === 'recovering';
  const candidates: ControlIntent[] = [
    {
      action: 'retry_step', target,
      title: `Retry step ${stepState.step.id}`,
      submitLabel: 'Retry escalated step',
      consequence: `Starts manual attempt ${(stepState.manualAttempt ?? 0) + 1} in the persisted worktree after dependencies and file claims are rechecked. Prior result history is preserved.`,
    },
    {
      action: 'cancel_step', target,
      title: `Cancel step ${stepState.step.id}`,
      submitLabel: 'Cancel this step', destructive: true,
      confirmation: `cancel step ${run.id}/${stepState.step.id}`,
      consequence: 'Cancels this exact step. An active worker drains without force-kill and retains claims until acknowledgement. Dependent steps remain pending with a cancelled-dependency blocker; independent work can continue.',
    },
  ];

  const open = (next: ControlIntent, event: MouseEvent) => {
    opener.current = event.currentTarget as HTMLElement;
    setIntent(next);
  };

  const submit = async (reason?: string, confirmation?: string) => {
    if (!intent) return;
    await executeControl(run.id, { action: intent.action, target, reason, confirmation });
    setIntent(null);
  };

  return (
    <section class="execution-controls step-controls" aria-label={`Controls for step ${stepState.step.id}`} data-control-scope="step">
      <div class="control-button-row">
        {candidates.map(candidate => {
          if (run.lifecycle!.capabilities[candidate.action] !== true) return null;
          const availability = getControlAvailability(candidate.action, target, run);
          return (
            <div class="control-action" key={candidate.action}>
              <button
                type="button"
                data-control-action={candidate.action}
                class={candidate.destructive ? 'control-danger' : ''}
                disabled={!availability.available}
                aria-describedby={!availability.available ? `${candidate.action}-${stepState.step.id}-reason` : undefined}
                onClick={event => open(candidate, event)}
              >
                {candidate.action === 'retry_step' ? 'Retry step' : 'Cancel step'}
              </button>
              {!availability.available && (
                <span id={`${candidate.action}-${stepState.step.id}-reason`} class="control-disabled-reason">{availability.reason}</span>
              )}
            </div>
          );
        })}
      </div>
      <ControlStatus runId={run.id} target={target} />
      {intent && (
        <ControlConfirmationDialog
          intent={intent}
          pending={pending}
          opener={opener.current}
          onCancel={() => setIntent(null)}
          onConfirm={(reason, confirmation) => void submit(reason, confirmation)}
        />
      )}
    </section>
  );
}
