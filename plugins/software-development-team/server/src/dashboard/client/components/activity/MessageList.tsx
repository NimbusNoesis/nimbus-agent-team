import { useRef, useEffect } from 'preact/hooks';
import { filteredMessages } from '../../state/store';
import { MessageCard } from './MessageCard';

export function MessageList() {
  const feedRef = useRef<HTMLDivElement>(null);
  const wasAtBottomRef = useRef(true);

  const handleScroll = () => {
    const el = feedRef.current;
    if (el) {
      wasAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    }
  };

  useEffect(() => {
    const el = feedRef.current;
    if (el && wasAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  });

  const filtered = filteredMessages.value;

  return (
    <div id="activity-feed" ref={feedRef} onScroll={handleScroll}>
      {filtered.map(msg => (
        <MessageCard key={msg.id} message={msg} />
      ))}
    </div>
  );
}
