import { useEffect, useId, useRef, useState } from 'preact/hooks';
import type { ExecutionControlAction, ExecutionControlTarget } from '../../state/store';

export interface ControlIntent {
  action: ExecutionControlAction;
  target: ExecutionControlTarget;
  title: string;
  submitLabel: string;
  consequence: string;
  confirmation?: string;
  destructive?: boolean;
}

interface Props {
  intent: ControlIntent;
  pending: boolean;
  opener: HTMLElement | null;
  onCancel: () => void;
  onConfirm: (reason?: string, confirmation?: string) => void;
}

export function ControlConfirmationDialog({ intent, pending, opener, onCancel, onConfirm }: Props) {
  const titleId = useId();
  const descriptionId = useId();
  const reasonId = useId();
  const reasonHelpId = useId();
  const confirmationId = useId();
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState('');

  useEffect(() => {
    const background: HTMLElement[] = [];
    let foreground: HTMLElement | null = backdropRef.current;
    while (foreground?.parentElement) {
      for (const sibling of foreground.parentElement.children) {
        if (sibling !== foreground && sibling instanceof HTMLElement) background.push(sibling);
      }
      foreground = foreground.parentElement;
      if (foreground === document.body) break;
    }
    const previous = background.map(element => ({
      element,
      ariaHidden: element.getAttribute('aria-hidden'),
      inert: element.hasAttribute('inert'),
    }));
    for (const element of background) {
      element.setAttribute('aria-hidden', 'true');
      element.setAttribute('inert', '');
    }
    cancelRef.current?.focus();
    return () => {
      for (const item of previous) {
        if (item.ariaHidden === null) item.element.removeAttribute('aria-hidden');
        else item.element.setAttribute('aria-hidden', item.ariaHidden);
        if (!item.inert) item.element.removeAttribute('inert');
      }
      opener?.focus();
    };
  }, [opener]);

  const confirmationMatches = intent.confirmation === undefined || confirmation === intent.confirmation;

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && !pending) {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled])',
    ) ?? [])];
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const submit = (event: Event) => {
    event.preventDefault();
    if (pending || !confirmationMatches) return;
    onConfirm(reason.trim() || undefined, intent.confirmation === undefined ? undefined : confirmation);
  };

  return (
    <div ref={backdropRef} class="control-dialog-backdrop" data-control-overlay="true">
      <div
        ref={dialogRef}
        class={`control-dialog${intent.destructive ? ' destructive' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={handleKeyDown}
      >
        <form onSubmit={submit}>
          <h3 id={titleId}>{intent.title}</h3>
          <p id={descriptionId}>{intent.consequence}</p>

          <label for={reasonId}>Reason <span class="control-optional">(optional)</span></label>
          <textarea
            id={reasonId}
            name="reason"
            value={reason}
            maxLength={500}
            rows={3}
            aria-describedby={reasonHelpId}
            disabled={pending}
            onInput={event => setReason(event.currentTarget.value)}
          />
          <div id={reasonHelpId} class="control-field-help">{reason.length}/500 characters</div>

          {intent.confirmation !== undefined && (
            <>
              <label for={confirmationId}>
                Type <code>{intent.confirmation}</code> to confirm this exact target
              </label>
              <input
                id={confirmationId}
                name="confirmation"
                value={confirmation}
                autoComplete="off"
                disabled={pending}
                onInput={event => setConfirmation(event.currentTarget.value)}
              />
            </>
          )}

          <div class="control-dialog-actions">
            <button ref={cancelRef} type="button" disabled={pending} onClick={onCancel}>Keep working</button>
            <button
              type="submit"
              class={intent.destructive ? 'control-danger' : 'control-primary'}
              disabled={pending || !confirmationMatches}
            >
              {pending ? 'Sending…' : intent.submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
