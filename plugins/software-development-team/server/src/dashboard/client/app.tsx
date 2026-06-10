import { useEffect } from 'preact/hooks';
import { allRuns } from './state/store';
import { fetchRuns, fetchMemory, selectRun } from './state/api';
import { connectWebSocket } from './state/websocket';
import { Header } from './components/header/Header';
import { RunTabs } from './components/header/RunTabs';
import { StepsPanel } from './components/steps/StepsPanel';
import { ActivityPanel } from './components/activity/ActivityPanel';
import { StatusPanel } from './components/status/StatusPanel';

export function App() {
  useEffect(() => {
    let retryId: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    async function init() {
      try {
        const runs = await fetchRuns();
        allRuns.value = runs;
        if (runs.length > 0) {
          await selectRun(runs[runs.length - 1]);
        }
        connectWebSocket();
        await fetchMemory();
      } catch (e) {
        console.error('Init failed:', e);
        if (!cancelled) retryId = setTimeout(init, 5000);
      }
    }
    init();
    return () => {
      cancelled = true;
      if (retryId) clearTimeout(retryId);
    };
  }, []);

  return (
    <>
      <Header />
      <RunTabs />
      <main id="main">
        <aside id="steps-panel">
          <h3>Plan Steps</h3>
          <StepsPanel />
        </aside>
        <section id="activity-panel">
          <h3>Activity Feed</h3>
          <ActivityPanel />
        </section>
        <aside id="status-panel">
          <h3>Agent Status</h3>
          <StatusPanel />
        </aside>
      </main>
    </>
  );
}
