import type { Message } from '../../state/store';
import { AGENT_COLORS } from '../../utils/constants';

interface Props {
  message: Message;
}

export function MessageCard({ message: msg }: Props) {
  const colorName = AGENT_COLORS[msg.from] || 'text';
  const isEscalation = msg.type === 'escalation';
  const time = new Date(msg.timestamp).toLocaleTimeString();

  return (
    <div class={`message from-${AGENT_COLORS[msg.from] ? msg.from : 'unknown'}${isEscalation ? ' escalation' : ''}`}>
      <div class="msg-header">
        <span class="msg-from" style={{ color: `var(--${colorName})` }}>{msg.from}</span>
        <span class={`msg-type-badge msg-type-${msg.type || 'info'}`}>{msg.type || ''}</span>
        <span>{time}</span>
      </div>
      <div class="msg-body">{msg.body}</div>
    </div>
  );
}
