import { useRef, useState } from 'preact/hooks';
import { executeControl } from '../../state/api';
import {
  currentRun,
  getControlAvailability,
  getControlOperation,
} from '../../state/store';
import type { ExecutionControlAction, ExecutionControlTarget } from '../../state/store';
import { ControlConfirmationDialog } from './ControlConfirmationDialog';
import type { ControlIntent } from './ControlConfirmationDialog';
import { ControlStatus } from './ControlStatus';

const RUN_TARGET: ExecutionControlTarget = { kind: 'run' };

export function RunControls() {
  const run = currentRun.value;
  const [intent, setIntent] = useState<ControlIntent | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  if (!run || run.lifecycle?.version !== 2) return null;

  const phase = run.lifecycle.controlPhase;
  const active = run.steps.filter(step => ['coding', 'reviewing', 'cancelling'].includes(step.status));
  const claims = new Set(active.flatMap(step => step.claimedFiles));
  const terminal = run.status === 'complete' || run.status === 'cancelled' || phase === 'cancelled';
  const operation = getControlOperation(run.id, RUN_TARGET);
  const pending = operation.status === 'pending' || operation.status === 'recovering';

  const truthfulStatus = terminal
    ? run.status === 'complete'
      ? 'Complete. This run is terminal and immutable.'
      : 'Cancelled. This run is terminal and immutable.'
    : phase === 'pausing'
      ? `Pausing admissions. ${active.length} active worker${active.length === 1 ? '' : 's'} draining; ${claims.size} file claim${claims.size === 1 ? '' : 's'} remain held. Workers are not force-stopped.`
      : phase === 'paused'
        ? 'Paused. No new workers are admitted; retained work can resume from persisted state.'
        : phase === 'cancelling'
          ? `Cancelling. ${active.length} active worker${active.length === 1 ? '' : 's'} draining; claims remain held until coordinator acknowledgement. Workers are not force-stopped.`
          : `${active.length} active worker${active.length === 1 ? '' : 's'}; ${claims.size} claimed file${claims.size === 1 ? '' : 's'}.`;

  const intents: Array<ControlIntent & { action: ExecutionControlAction }> = [
    {
      action: 'pause_run', target: RUN_TARGET, title: `Pause run ${run.id}`,
      submitLabel: 'Pause admissions',
      consequence: 'Stops new admissions. Current workers continue until they drain; their file claims remain held.',
    },
    {
      action: 'resume_run', target: RUN_TARGET, title: `Resume run ${run.id}`,
      submitLabel: 'Resume run',
      consequence: 'Allows the coordinator to recompute runnable work and admit new workers from current persisted state.',
    },
    {
      action: 'cancel_run', target: RUN_TARGET, title: `Cancel run ${run.id}`,
      submitLabel: 'Cancel this run', destructive: true,
      confirmation: `cancel run ${run.id}`,
      consequence: 'Cancels this exact run. Active workers drain without force-kill, claims remain held until acknowledgement, and the final cancelled run is immutable.',
    },
  ];

  const open = (next: ControlIntent, event: MouseEvent) => {
    opener.current = event.currentTarget as HTMLElement;
    setIntent(next);
  };

  const submit = async (reason?: string, confirmation?: string) => {
    if (!intent) return;
    const result = await executeControl(run.id, {
      action: intent.action,
      target: intent.target,
      reason,
      confirmation,
    });
    setIntent(null);
    if (!result.ok && result.requiresReconfirmation) {
      // Closing clears the prior confirmation. A new deliberate open is required.
      opener.current?.focus();
    }
  };

  return (
    <section class="execution-controls run-controls" aria-labelledby={`run-controls-${run.id}`} data-control-scope="run">
      <h3 id={`run-controls-${run.id}`}>Execution controls</h3>
      <p class="control-lifecycle-summary" data-control-phase={phase}>{truthfulStatus}</p>
      <div class="control-button-row">
        {intents.map(candidate => {
          if (run.lifecycle!.capabilities[candidate.action] !== true) return null;
          const availability = getControlAvailability(candidate.action, RUN_TARGET, run);
          return (
            <div class="control-action" key={candidate.action}>
              <button
                type="button"
                data-control-action={candidate.action}
                class={candidate.destructive ? 'control-danger' : ''}
                disabled={!availability.available}
                aria-describedby={!availability.available ? `${candidate.action}-reason` : undefined}
                onClick={event => open(candidate, event)}
              >
                {candidate.action === 'pause_run' ? 'Pause' : candidate.action === 'resume_run' ? 'Resume' : 'Cancel run'}
              </button>
              {!availability.available && (
                <span id={`${candidate.action}-reason`} class="control-disabled-reason">{availability.reason}</span>
              )}
            </div>
          );
        })}
      </div>
      <ControlStatus runId={run.id} target={RUN_TARGET} />
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
