import { getControlOperation } from '../../state/store';
import type { ExecutionControlTarget } from '../../state/store';

interface Props {
  runId: string;
  target: ExecutionControlTarget;
}

export function ControlStatus({ runId, target }: Props) {
  const operation = getControlOperation(runId, target);
  if (operation.status === 'idle') return null;

  const text = operation.status === 'pending' || operation.status === 'recovering'
    ? 'Control request in progress. Do not submit another request for this target.'
    : operation.status === 'success'
      ? `Control applied at lifecycle revision ${operation.receipt?.revision ?? 'unknown'}.`
      : operation.status === 'conflict'
        ? 'The run changed before this control was applied. State was refreshed; reconsider the action and confirm again.'
        : operation.error?.message ?? 'The control request failed. Review the current run state before trying again.';

  return (
    <div
      class={`control-status control-status-${operation.status}`}
      role={operation.status === 'error' || operation.status === 'conflict' ? 'alert' : 'status'}
      aria-live={operation.status === 'error' || operation.status === 'conflict' ? 'assertive' : 'polite'}
      data-control-state={operation.status}
    >
      {text}
    </div>
  );
}
