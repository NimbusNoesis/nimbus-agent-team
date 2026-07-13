import { currentRun } from '../../state/store';
import { RunControls } from '../controls/RunControls';
import { StepCard } from './StepCard';

export function StepsPanel() {
  const run = currentRun.value;
  if (!run) return <div id="steps-list">No active run</div>;

  return (
    <div id="steps-list">
      <RunControls />
      {run.steps.map(s => (
        <StepCard key={s.step.id} stepState={s} />
      ))}
    </div>
  );
}
