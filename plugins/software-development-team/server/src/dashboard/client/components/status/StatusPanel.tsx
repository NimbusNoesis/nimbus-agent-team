import { AgentCard } from './AgentCard';
import { MemoryPanel } from './MemoryPanel';
import { GuidanceInput } from './GuidanceInput';
import { AGENTS } from '../../utils/constants';

export function StatusPanel() {
  return (
    <>
      <div id="agent-status">
        {AGENTS.map(name => (
          <AgentCard key={name} agentName={name} />
        ))}
      </div>
      <h3>Shared Memory</h3>
      <MemoryPanel />
      <GuidanceInput />
    </>
  );
}
