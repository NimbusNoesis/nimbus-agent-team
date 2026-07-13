import { useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import {
  connectionStatus,
  currentRun,
  dataFreshness,
  loadingRunId,
} from '../../state/store';
import { sendGuidance } from '../../state/api';

type GuidanceOutcome = { kind: 'success' | 'error'; message: string };

export function GuidanceInput() {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [outcomes, setOutcomes] = useState<Record<string, GuidanceOutcome>>({});
  const [pendingRunId, setPendingRunId] = useState<string | null>(null);
  const pendingRunIdRef = useRef<string | null>(null);
  const draftsRef = useRef(drafts);
  const requestSequence = useRef(0);
  const run = currentRun.value;
  const runId = run?.id ?? null;
  const draft = runId ? drafts[runId] ?? '' : '';
  const outcome = runId ? outcomes[runId] : undefined;

  const unavailableReason = !run
    ? 'Select a run before sending guidance.'
    : connectionStatus.value === 'offline'
      ? 'Guidance is unavailable while the dashboard is offline.'
      : connectionStatus.value === 'connecting'
        ? 'Guidance is unavailable while the dashboard connects.'
        : loadingRunId.value === run.id || dataFreshness.value === 'loading'
          ? 'Guidance is unavailable while selected-run data loads.'
          : dataFreshness.value === 'stale'
            ? 'Refresh stale run data before sending guidance.'
            : null;
  const pendingReason = pendingRunId
    ? `Guidance is already being sent to run ${pendingRunId}.`
    : null;
  const inputDisabled = unavailableReason !== null;
  const sendDisabled = inputDisabled || pendingRunId !== null || draft.trim().length === 0;

  const updateDraft = (value: string) => {
    if (!runId) return;
    const next = { ...draftsRef.current, [runId]: value };
    draftsRef.current = next;
    setDrafts(next);
    if (outcomes[runId]?.kind === 'error') {
      setOutcomes(previous => {
        const updated = { ...previous };
        delete updated[runId];
        return updated;
      });
    }
  };

  const send = async (event?: JSX.TargetedEvent<HTMLFormElement, Event>) => {
    event?.preventDefault();
    const selectedRun = currentRun.value;
    const body = selectedRun ? (draftsRef.current[selectedRun.id] ?? '').trim() : '';
    if (!selectedRun || !body || pendingRunIdRef.current !== null || unavailableReason !== null) return;

    const targetRunId = selectedRun.id;
    const sequence = ++requestSequence.current;
    pendingRunIdRef.current = targetRunId;
    setPendingRunId(targetRunId);
    setOutcomes(previous => {
      const updated = { ...previous };
      delete updated[targetRunId];
      return updated;
    });

    let ok = false;
    try {
      ok = await sendGuidance(targetRunId, body);
    } catch {
      ok = false;
    }

    if (requestSequence.current !== sequence) return;
    pendingRunIdRef.current = null;
    setPendingRunId(null);
    if (ok) {
      if ((draftsRef.current[targetRunId] ?? '').trim() === body) {
        const next = { ...draftsRef.current, [targetRunId]: '' };
        draftsRef.current = next;
        setDrafts(next);
      }
      setOutcomes(previous => ({
        ...previous,
        [targetRunId]: { kind: 'success', message: `Guidance sent to run ${targetRunId}.` },
      }));
    } else {
      setOutcomes(previous => ({
        ...previous,
        [targetRunId]: {
          kind: 'error',
          message: `Guidance was not sent to run ${targetRunId}. Your draft is preserved; try again.`,
        },
      }));
    }
  };

  const disabledReason = unavailableReason ?? pendingReason;

  return (
    <section id="guidance-input" aria-labelledby="guidance-heading">
      <h3 id="guidance-heading">Send Guidance</h3>
      <p id="guidance-target" class="guidance-target">
        {run ? (
          <>Target: <strong>{run.task ?? 'Selected run'}</strong> <code>{run.id}</code></>
        ) : 'No run selected.'}
      </p>
      <form onSubmit={event => void send(event)} aria-describedby="guidance-target guidance-disabled-reason">
        <label for="guidance-body" class="visually-hidden">Guidance for the selected run</label>
        <div class="input-row">
          <input
            id="guidance-body"
            type="text"
            value={draft}
            placeholder="Type guidance for the team…"
            disabled={inputDisabled}
            aria-invalid={outcome?.kind === 'error' || undefined}
            onInput={event => updateDraft(event.currentTarget.value)}
          />
          <button type="submit" disabled={sendDisabled} aria-busy={pendingRunId !== null}>
            {pendingRunId ? 'Sending…' : outcome?.kind === 'error' ? 'Try again' : 'Send'}
          </button>
        </div>
      </form>
      <p id="guidance-disabled-reason" class="guidance-disabled-reason">
        {disabledReason ?? 'Guidance will be sent only to the selected run.'}
      </p>
      {outcome && (
        <p
          class={outcome.kind === 'error' ? 'guidance-error' : 'guidance-success'}
          role={outcome.kind === 'error' ? 'alert' : 'status'}
          aria-live={outcome.kind === 'error' ? 'assertive' : 'polite'}
        >
          {outcome.message}
        </p>
      )}
    </section>
  );
}
