import { useEffect, useRef, useState } from 'preact/hooks';

const WORKSPACE_ITEMS = [
  { id: 'steps-panel', label: 'Plan' },
  { id: 'activity-panel', label: 'Activity' },
  { id: 'status-panel', label: 'Context' },
] as const;

export function WorkspaceNavigation() {
  const [activeId, setActiveId] = useState<string>(WORKSPACE_ITEMS[0].id);
  const navigation = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(max-width: 900px)');
    const retainNavigationFocus = () => {
      const focused = document.activeElement as HTMLElement | null;
      if (!focused?.dataset.workspaceTarget || !navigation.current?.contains(focused)) return;

      queueMicrotask(() => {
        if (document.activeElement !== focused && document.activeElement !== document.body) return;
        if (focused.isConnected) focused.focus();
      });
    };
    query.addEventListener?.('change', retainNavigationFocus);
    return () => query.removeEventListener?.('change', retainNavigationFocus);
  }, []);

  function activate(event: MouseEvent, id: string) {
    event.preventDefault();
    setActiveId(id);
    const panel = document.getElementById(id);
    panel?.focus({ preventScroll: true });
    panel?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }

  return (
    <nav ref={navigation} class="workspace-navigation" aria-label="Workspace views">
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
