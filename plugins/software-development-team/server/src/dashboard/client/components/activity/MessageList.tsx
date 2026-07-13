import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  controlHistory,
  currentFilter,
  currentRun,
  messages,
} from '../../state/store';
import type { LifecycleHistoryEntry, Message } from '../../state/store';
import { MessageCard } from './MessageCard';
import type { ActivityItem, ActivityType } from './MessageCard';

const PHASE_LABELS: Record<string, string> = {
  none: 'active',
  pausing: 'pausing',
  paused: 'paused',
  cancelling: 'cancelling',
  cancelled: 'cancelled',
};

function controlDescription(entry: LifecycleHistoryEntry): string {
  const target = entry.target.kind === 'step' ? `step ${entry.target.stepId}` : 'the run';
  const descriptions: Record<LifecycleHistoryEntry['action'], string> = {
    pause_run: 'Pause requested for the run.',
    resume_run: 'Execution resumed for the run.',
    cancel_run: 'Cancellation requested for the run.',
    cancel_step: `Cancellation requested for ${target}.`,
    retry_step: `Manual retry requested for ${target}.`,
    acknowledge_pause: 'The coordinator acknowledged that pause draining completed.',
    acknowledge_cancel: `The coordinator acknowledged that cancellation draining completed for ${target}.`,
  };
  const transition = entry.fromPhase === entry.toPhase
    ? `Execution remained ${PHASE_LABELS[entry.toPhase] ?? entry.toPhase}.`
    : `Execution changed from ${PHASE_LABELS[entry.fromPhase] ?? entry.fromPhase} to ${PHASE_LABELS[entry.toPhase] ?? entry.toPhase}.`;
  // Do not render entry.summary: it may contain an operator-supplied reason.
  return `${descriptions[entry.action]} ${transition}`;
}

function messageActivity(message: Message): ActivityItem {
  return {
    key: `message:${message.id}`,
    kind: 'message',
    runId: message.runId,
    actor: message.from,
    recipient: message.to,
    type: message.type,
    body: message.body,
    timestamp: message.timestamp,
  };
}

function controlActivity(runId: string, entry: LifecycleHistoryEntry): ActivityItem {
  return {
    key: `control:${entry.commandId}:${entry.revision}`,
    kind: 'control',
    runId,
    actor: 'coordinator',
    recipient: 'operators',
    type: 'control',
    body: controlDescription(entry),
    timestamp: entry.recordedAt,
    revision: entry.revision,
    status: PHASE_LABELS[entry.toPhase] ?? entry.toPhase,
  };
}

/** Builds the reconnect-safe view model without mutating store-owned history. */
export function buildActivityItems(
  messageList: Message[],
  history: LifecycleHistoryEntry[],
  runId: string,
): ActivityItem[] {
  const byKey = new Map<string, ActivityItem>();
  for (const message of messageList) {
    if (message.runId === runId) byKey.set(`message:${message.id}`, messageActivity(message));
  }
  for (const entry of history) {
    const item = controlActivity(runId, entry);
    byKey.set(item.key, item);
  }
  return [...byKey.values()].sort((left, right) => {
    const leftTime = Date.parse(left.timestamp);
    const rightTime = Date.parse(right.timestamp);
    const timeOrder = Number.isNaN(leftTime) || Number.isNaN(rightTime)
      ? left.timestamp.localeCompare(right.timestamp)
      : leftTime - rightTime;
    return timeOrder
      || (left.revision ?? -1) - (right.revision ?? -1)
      || left.key.localeCompare(right.key)
  });
}

export function selectedActivityItems(): ActivityItem[] {
  const runId = currentRun.value?.id ?? messages.value[0]?.runId;
  if (!runId) return [];
  return buildActivityItems(messages.value, controlHistory.value, runId);
}

interface Props {
  items?: ActivityItem[];
  runId?: string;
}

function selectedFilter(): ActivityType | 'all' {
  const filter = currentFilter.value;
  return ['info', 'review', 'escalation', 'guidance', 'result', 'control'].includes(filter)
    ? filter as ActivityType
    : 'all';
}

interface RunMessageListProps {
  items: ActivityItem[];
}

function RunMessageList({ items }: RunMessageListProps) {
  const feedRef = useRef<HTMLDivElement>(null);
  const isAtLiveEdgeRef = useRef(true);
  const previousKeysRef = useRef<Set<string>>(new Set());
  const previousFilterRef = useRef<string | null>(null);
  const initializedRef = useRef(false);
  const [unseenCount, setUnseenCount] = useState(0);
  const [isAtLiveEdge, setIsAtLiveEdge] = useState(true);
  const activeFilter = selectedFilter();
  const filtered = useMemo(
    () => activeFilter === 'all' ? items : items.filter(item => item.type === activeFilter),
    [items, activeFilter],
  );
  const keySignature = filtered.map(item => item.key).join('\u0000');

  const updateLiveEdge = (atEdge: boolean) => {
    isAtLiveEdgeRef.current = atEdge;
    setIsAtLiveEdge(atEdge);
    if (atEdge) setUnseenCount(0);
  };

  const handleScroll = () => {
    const element = feedRef.current;
    if (!element) return;
    const atEdge = element.scrollHeight - element.scrollTop - element.clientHeight <= 64;
    updateLiveEdge(atEdge);
  };

  const returnToLive = () => {
    const element = feedRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    updateLiveEdge(true);
  };

  useEffect(() => {
    const keys = new Set(filtered.map(item => item.key));
    const filterChanged = previousFilterRef.current !== activeFilter;
    const isInitial = !initializedRef.current;
    const added = isInitial || filterChanged
      ? 0
      : [...keys].filter(key => !previousKeysRef.current.has(key)).length;

    initializedRef.current = true;
    previousFilterRef.current = activeFilter;
    previousKeysRef.current = keys;

    const element = feedRef.current;
    if (filterChanged) setUnseenCount(0);
    if (element && isAtLiveEdgeRef.current) {
      element.scrollTop = element.scrollHeight;
    } else if (!filterChanged && added > 0) {
      setUnseenCount(count => count + added);
    }
  }, [keySignature, activeFilter]);

  const liveLabel = unseenCount > 0
    ? `${unseenCount} new ${unseenCount === 1 ? 'entry' : 'entries'} — return to live`
    : isAtLiveEdge ? 'Following live activity' : 'Return to live activity';

  return (
    <div class="activity-list-region">
      <div
        id="activity-feed"
        ref={feedRef}
        onScroll={handleScroll}
        role="log"
        aria-label="Run activity timeline"
        aria-live="polite"
        aria-relevant="additions"
      >
        {filtered.map(item => (
          <MessageCard key={item.key} item={item} />
        ))}
      </div>
      <button
        type="button"
        class="activity-return-live"
        onClick={returnToLive}
        disabled={isAtLiveEdge && unseenCount === 0}
        aria-label={liveLabel}
      >
        {liveLabel}
      </button>
    </div>
  );
}

/**
 * Run identity is deliberately a component key. Switching workspaces remounts
 * the timeline-local refs, unseen counter, live-edge state, and scroll node as
 * one atomic unit, so the new run's existing history is an initial snapshot.
 */
export function MessageList({ items = selectedActivityItems(), runId = currentRun.value?.id }: Props) {
  return <RunMessageList key={runId ?? 'no-selected-run'} items={items} />;
}
