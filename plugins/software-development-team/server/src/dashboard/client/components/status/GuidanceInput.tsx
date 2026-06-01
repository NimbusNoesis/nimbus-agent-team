import { useRef } from 'preact/hooks';
import { currentRun } from '../../state/store';
import { sendGuidance } from '../../state/api';

export function GuidanceInput() {
  const inputRef = useRef<HTMLInputElement>(null);

  const send = () => {
    const body = inputRef.current?.value.trim();
    const run = currentRun.value;
    if (!body || !run) return;
    sendGuidance(run.id, body);
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <div id="guidance-input">
      <h3>Send Guidance</h3>
      <div class="input-row">
        <input
          type="text"
          ref={inputRef}
          placeholder="Type guidance for the team..."
          onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
        />
        <button onClick={send}>Send</button>
      </div>
    </div>
  );
}
