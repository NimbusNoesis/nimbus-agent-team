export const AGENT_COLORS: Record<string, string> = {
  coordinator: 'coordinator',
  planner: 'planner',
  coder: 'coder',
  reviewer: 'reviewer',
  user: 'user',
  researcher: 'researcher',
  documentation: 'documentation',
};

export const VALID_STATUSES = new Set([
  'pending', 'coding', 'reviewing', 'complete', 'escalated', 'ready', 'in_progress', 'running',
]);

export const NAMESPACE_COLORS: Record<string, { color: string; bg: string; border: string }> = {
  decisions:   { color: '#fbbf24', bg: 'rgba(251,191,36,0.15)', border: 'rgba(251,191,36,0.3)' },
  context:     { color: '#60a5fa', bg: 'rgba(96,165,250,0.15)', border: 'rgba(96,165,250,0.3)' },
  learnings:   { color: '#34d399', bg: 'rgba(52,211,153,0.15)', border: 'rgba(52,211,153,0.3)' },
  reviews:     { color: '#f87171', bg: 'rgba(248,113,113,0.15)', border: 'rgba(248,113,113,0.3)' },
  reflections: { color: '#a78bfa', bg: 'rgba(167,139,250,0.15)', border: 'rgba(167,139,250,0.3)' },
};

export const NAMESPACE_ORDER = ['decisions', 'context', 'learnings', 'reviews', 'reflections'];

export const FILTER_TYPES = ['all', 'info', 'review', 'escalation', 'guidance', 'result'];

export const AGENTS = ['coordinator', 'planner', 'coder', 'reviewer', 'researcher', 'documentation'];

export const STEP_ICONS: Record<string, string> = {
  pending: '\u25CB',
  coding: '\u27F3',
  reviewing: '\u27F3',
  complete: '\u2713',
  escalated: '\u26A0',
};

export const STATUS_COLOR_MAP: Record<string, string> = {
  complete: 'complete',
  escalated: 'reviewer',
  pending: 'text-muted',
};
