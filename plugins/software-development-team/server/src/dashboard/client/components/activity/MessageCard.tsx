import type { Message } from '../../state/store';
import { AGENT_COLORS } from '../../utils/constants';

export type ActivityType = Message['type'] | 'control';

export interface ActivityItem {
  key: string;
  kind: 'message' | 'control';
  runId: string;
  actor: string;
  recipient: string;
  type: ActivityType;
  body: string;
  timestamp: string;
  revision?: number;
  status?: string;
}

interface Props {
  /** Kept for direct callers while the feed uses the normalized activity item. */
  message?: Message;
  item?: ActivityItem;
}

function messageItem(message: Message): ActivityItem {
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

function displayTime(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? 'Time unavailable' : date.toLocaleTimeString();
}

export function MessageCard({ message, item }: Props) {
  const activity = item ?? (message ? messageItem(message) : null);
  if (!activity) return null;

  const colorName = AGENT_COLORS[activity.actor] || 'text';
  const knownActor = AGENT_COLORS[activity.actor] ? activity.actor : 'unknown';
  const isEscalation = activity.type === 'escalation';
  const classes = [
    'message',
    `from-${knownActor}`,
    isEscalation ? 'escalation' : '',
    activity.kind === 'control' ? 'control-event' : '',
  ].filter(Boolean).join(' ');

  return (
    <article
      class={classes}
      data-activity-key={activity.key}
      data-activity-kind={activity.kind}
      aria-label={`${activity.type} activity from ${activity.actor}`}
    >
      <div class="msg-header">
        <span class="msg-from" style={{ color: `var(--${colorName})` }}>
          {activity.actor}
        </span>
        <span class={`msg-type-badge msg-type-${activity.type}`}>
          {activity.type}
        </span>
        {activity.status && (
          <span class="msg-status-cue">
            <span aria-hidden="true">{activity.status === 'cancelled' ? '×' : '↳'}</span>{' '}
            {activity.status}
          </span>
        )}
        {activity.revision !== undefined && (
          <span class="msg-revision">revision {activity.revision}</span>
        )}
        <time dateTime={activity.timestamp}>{displayTime(activity.timestamp)}</time>
      </div>
      <div class="msg-body activity-text">{activity.body}</div>
    </article>
  );
}
