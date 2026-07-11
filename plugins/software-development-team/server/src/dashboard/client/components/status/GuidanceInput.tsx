import { useRef, useState } from 'preact/hooks';
import { currentRun } from '../../state/store';
import { sendGuidance } from '../../state/api';

export function GuidanceInput() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [sendFailed, setSendFailed] = useState(false);

  const send = async () => {
    const body = inputRef.current?.value.trim();
    const run = currentRun.value;
    if (!body || !run) return;
    const ok = await sendGuidance(run.id, body);
    if (ok) {
      setSendFailed(false);
      // Only clear on success — on failure the user keeps their text to retry.
      if (inputRef.current) inputRef.current.value = '';
    } else {
      setSendFailed(true);
    }
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
          onInput={() => { if (sendFailed) setSendFailed(false); }}
        />
        <button onClick={send}>Send</button>
      </div>
      {sendFailed && (
        <div class="guidance-error">Failed to send guidance. Check the server and try again.</div>
      )}
    </div>
  );
}
