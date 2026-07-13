import { useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { AsyncState } from '../common/AsyncState';
import { AgentCard } from './AgentCard';
import { MemoryPanel } from './MemoryPanel';
import { GuidanceInput } from './GuidanceInput';
import { AGENTS } from '../../utils/constants';
import {
  connectionStatus,
  currentRun,
  dataFreshness,
  loadingRunId,
} from '../../state/store';

const VIEWS = [
  { id: 'agents', label: 'Agents' },
  { id: 'memory', label: 'Memory' },
  { id: 'guidance', label: 'Guidance' },
] as const;

type ContextView = typeof VIEWS[number]['id'];

function runContextState() {
  const run = currentRun.value;
  if (loadingRunId.value === run?.id || dataFreshness.value === 'loading') return 'loading' as const;
  if (!run) return connectionStatus.value === 'offline' ? 'error' as const : 'empty' as const;
  if (dataFreshness.value === 'stale') return 'stale' as const;
  return 'ready' as const;
}

export function StatusPanel() {
  const [activeView, setActiveView] = useState<ContextView>('agents');

  const selectFromKeyboard = (
    event: JSX.TargetedKeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (index + 1) % VIEWS.length;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (index - 1 + VIEWS.length) % VIEWS.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = VIEWS.length - 1;
    if (nextIndex === null) return;

    event.preventDefault();
    const nextView = VIEWS[nextIndex];
    setActiveView(nextView.id);
    const tabs = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    tabs?.[nextIndex]?.focus();
  };

  const state = runContextState();
  const selectedRun = currentRun.value;

  return (
    <div class="run-context">
      <nav class="context-navigation" aria-label="Run context views">
        <div class="context-tabs" role="tablist" aria-label="Run context">
          {VIEWS.map((view, index) => (
            <button
              key={view.id}
              id={`context-tab-${view.id}`}
              class={`context-tab${activeView === view.id ? ' active' : ''}`}
              type="button"
              role="tab"
              aria-selected={activeView === view.id}
              aria-controls={`context-panel-${view.id}`}
              tabIndex={activeView === view.id ? 0 : -1}
              onClick={() => setActiveView(view.id)}
              onKeyDown={event => selectFromKeyboard(event, index)}
            >
              {view.label}
            </button>
          ))}
        </div>
      </nav>

      <section
        id="context-panel-agents"
        class="context-panel"
        role="tabpanel"
        aria-labelledby="context-tab-agents"
        hidden={activeView !== 'agents'}
      >
        <h3>Team roster</h3>
        <AsyncState
          state={state}
          label="Agent roster"
          message={state === 'empty'
            ? 'Select a run to inspect its team roster.'
            : state === 'stale'
              ? 'Roster status may be stale while the connection recovers.'
              : undefined}
          preserveContent
        >
          <div id="agent-status" role="list" aria-label="Fixed team roster">
            {AGENTS.map(name => <AgentCard key={name} agentName={name} />)}
          </div>
        </AsyncState>
      </section>

      <section
        id="context-panel-memory"
        class="context-panel"
        role="tabpanel"
        aria-labelledby="context-tab-memory"
        hidden={activeView !== 'memory'}
      >
        <h3 id="shared-memory-heading">Shared Memory</h3>
        <MemoryPanel />
      </section>

      <section
        id="context-panel-guidance"
        class="context-panel"
        role="tabpanel"
        aria-labelledby="context-tab-guidance"
        hidden={activeView !== 'guidance'}
      >
        <GuidanceInput />
      </section>

      <p class="context-run-summary visually-hidden" aria-live="polite">
        {selectedRun ? `Context for ${selectedRun.task ?? selectedRun.id}` : 'No run selected'}
      </p>
    </div>
  );
}
