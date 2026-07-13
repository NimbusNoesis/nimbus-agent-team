import type { ComponentChildren } from 'preact';

export type AsyncStateKind = 'loading' | 'error' | 'empty' | 'stale' | 'ready';

interface AsyncStateProps {
  state: AsyncStateKind;
  children?: ComponentChildren;
  message?: string;
  onRetry?: () => void;
  label?: string;
  preserveContent?: boolean;
}

const DEFAULT_MESSAGES: Record<Exclude<AsyncStateKind, 'ready'>, string> = {
  loading: 'Loading dashboard data…',
  error: 'Dashboard data could not be loaded.',
  empty: 'No runs are available yet.',
  stale: 'Showing the last known data while the connection recovers.',
};

/**
 * Consistent async feedback for dashboard regions. Stale state deliberately
 * preserves its children so an operator does not lose useful context.
 */
export function AsyncState({
  state,
  children,
  message,
  onRetry,
  label = 'Dashboard',
  preserveContent = false,
}: AsyncStateProps) {
  if (state === 'ready') return <>{children}</>;

  const text = message ?? DEFAULT_MESSAGES[state];
  if (state === 'stale') {
    return (
      <div class="async-state async-state-stale" data-state="stale">
        <div class="async-state-message" role="status" aria-live="polite">
          <span aria-hidden="true">!</span> {text}
          {onRetry && <button type="button" onClick={onRetry}>Refresh</button>}
        </div>
        {children}
      </div>
    );
  }

  return (
    <div class={`async-state async-state-${state}`} data-state={state}>
      <div
        class="async-state-message"
        role={state === 'error' ? 'alert' : 'status'}
        aria-live={state === 'error' ? 'assertive' : 'polite'}
        aria-label={`${label}: ${state}`}
      >
        {state === 'loading' && <span class="async-state-spinner" aria-hidden="true" />}
        <p>{text}</p>
        {state === 'error' && onRetry && (
          <button type="button" onClick={onRetry}>Try again</button>
        )}
      </div>
      {preserveContent && children}
    </div>
  );
}
