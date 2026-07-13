import { useEffect, useRef, useState } from 'preact/hooks';

const WORKSPACE_ITEMS = [
  { id: 'steps-panel', label: 'Plan' },
  { id: 'activity-panel', label: 'Activity' },
  { id: 'status-panel', label: 'Context' },
] as const;

export function WorkspaceNavigation() {
  const [activeId, setActiveId] = useState<string>(WORKSPACE_ITEMS[0].id);
  const lastTarget = useRef(activeId);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(max-width: 900px)');
    const retainFocus = () => {
      const focused = document.activeElement as HTMLElement | null;
      const targetId = focused?.dataset.workspaceTarget ?? lastTarget.current;
      queueMicrotask(() => {
        document.querySelector<HTMLElement>(`[data-workspace-target="${targetId}"]`)?.focus();
      });
    };
    query.addEventListener?.('change', retainFocus);
    return () => query.removeEventListener?.('change', retainFocus);
  }, []);

  function activate(event: MouseEvent, id: string) {
    event.preventDefault();
    setActiveId(id);
    lastTarget.current = id;
    const panel = document.getElementById(id);
    panel?.focus({ preventScroll: true });
    panel?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }

  return (
    <nav class="workspace-navigation" aria-label="Workspace views">
      {WORKSPACE_ITEMS.map(item => (
        <a
          key={item.id}
          href={`#${item.id}`}
          class={activeId === item.id ? 'active' : undefined}
          aria-current={activeId === item.id ? 'location' : undefined}
          data-workspace-target={item.id}
          onClick={event => activate(event, item.id)}
        >
          {item.label}
        </a>
      ))}
    </nav>
  );
}
