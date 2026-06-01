// Seconds elapsed since `iso`, clamped to >= 0. Returns null for invalid dates.
function elapsedSeconds(iso: string): number | null {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 1000));
}

export function formatElapsed(startIso: string): string {
  const secs = elapsedSeconds(startIso);
  if (secs === null) return '—';
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}

export function formatRelativeTime(isoTimestamp: string): string {
  const secs = elapsedSeconds(isoTimestamp);
  if (secs === null) return '—';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h ago`;
}

export function getRunLabel(run: { id: string; task?: string }, index: number): string {
  const num = `#${index + 1}`;
  if (run.task) {
    const short = run.task.length > 40 ? run.task.slice(0, 40) + '\u2026' : run.task;
    return `${num}: ${short}`;
  }
  return `${num} (${run.id.slice(0, 8)})`;
}
