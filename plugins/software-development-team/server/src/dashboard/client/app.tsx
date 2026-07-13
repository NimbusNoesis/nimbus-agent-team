import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { allRuns, currentRun, dataFreshness } from './state/store';
import { fetchRuns, fetchMemory, selectRun } from './state/api';
import { connectWebSocket } from './state/websocket';
import { AsyncState } from './components/common/AsyncState';
import { Header } from './components/header/Header';
import { RunTabs } from './components/header/RunTabs';
import { WorkspaceNavigation } from './components/navigation/WorkspaceNavigation';
import { StepsPanel } from './components/steps/StepsPanel';
import { ActivityPanel } from './components/activity/ActivityPanel';
import { StatusPanel } from './components/status/StatusPanel';

export function App() {
  const [bootState, setBootState] = useState<'loading' | 'ready' | 'error'>('loading');
  const mounted = useRef(true);

  const loadDashboard = useCallback(async () => {
    setBootState('loading');
    try {
      const runs = await fetchRuns();
      if (!mounted.current) return;
      allRuns.value = runs;
      if (runs.length > 0) {
        const selected = runs.find(run => run.id === currentRun.value?.id) ?? runs[runs.length - 1];
        await selectRun(selected);
      }
      connectWebSocket();
      await fetchMemory();
      if (mounted.current) setBootState('ready');
    } catch (error) {
      console.error('Init failed:', error);
      if (mounted.current) setBootState('error');
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void loadDashboard();
    return () => {
      mounted.current = false;
    };
  }, [loadDashboard]);

  const shellState = bootState === 'error'
    ? 'error'
    : bootState === 'loading'
      ? 'loading'
      : allRuns.value.length === 0
        ? 'empty'
        : dataFreshness.value === 'stale'
          ? 'stale'
          : 'ready';

  const focusMain = (event: MouseEvent) => {
    event.preventDefault();
    document.getElementById('main')?.focus();
  };

  return (
    <div class="dashboard-shell">
      <a class="skip-link" href="#main" onClick={focusMain}>Skip to workspace</a>
      <Header />
      <RunTabs />
      <WorkspaceNavigation />
      <AsyncState
        state={shellState}
        onRetry={() => void loadDashboard()}
        label="Team dashboard"
        preserveContent
      >
        <main id="main" class="workspace-main" tabIndex={-1} aria-label="Selected run workspace">
          <section id="steps-panel" tabIndex={-1} aria-labelledby="steps-heading">
            <h2 id="steps-heading">Plan Steps</h2>
            <StepsPanel />
          </section>
          <section id="activity-panel" tabIndex={-1} aria-labelledby="activity-heading">
            <h2 id="activity-heading">Activity Feed</h2>
            <ActivityPanel />
          </section>
          <aside id="status-panel" tabIndex={-1} aria-labelledby="status-heading">
            <h2 id="status-heading">Run Context</h2>
            <StatusPanel />
          </aside>
        </main>
      </AsyncState>
      <div class="visually-hidden" aria-live="polite" aria-atomic="true">
        {currentRun.value ? `Selected run ${currentRun.value.task ?? currentRun.value.id}` : 'No run selected'}
      </div>
    </div>
  );
}
