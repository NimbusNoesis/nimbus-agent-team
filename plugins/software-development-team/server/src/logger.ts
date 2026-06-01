import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const DEBUG = process.env.TEAM_DEBUG === '1' || process.env.TEAM_DEBUG === 'true';

// Log file location: .team/logs/server.log (relative to cwd)
const LOG_FILE = resolve(process.env.TEAM_DIR ?? '.team', 'logs', 'server.log');

// Ensure log directory exists. If it fails, file logging is disabled for this session.
let logDir: string | null = null;
try {
  const dir = dirname(LOG_FILE);
  mkdirSync(dir, { recursive: true });
  logDir = dir;
} catch (err) {
  process.stderr.write(`[WARN] Failed to create log directory: ${err}\n`);
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m',  // gray
  info: '\x1b[36m',   // cyan
  warn: '\x1b[33m',   // yellow
  error: '\x1b[31m',  // red
};
const RESET = '\x1b[0m';

function timestamp(): string {
  return new Date().toISOString();
}

function safeStringify(data: Record<string, unknown>): string {
  try {
    return JSON.stringify(data);
  } catch {
    return '[unserializable]';
  }
}

function log(level: LogLevel, component: string, message: string, data?: Record<string, unknown>): void {
  if (level === 'debug' && !DEBUG) return;

  const ts = timestamp();

  // Colored stderr output — use full ISO timestamp for cross-correlation with file output
  const color = LEVEL_COLORS[level];
  const stderrLine = data
    ? `${color}[${ts}] [${level.toUpperCase()}] [${component}]${RESET} ${message} ${safeStringify(data)}`
    : `${color}[${ts}] [${level.toUpperCase()}] [${component}]${RESET} ${message}`;
  process.stderr.write(stderrLine + '\n');

  // Plain text file output (no ANSI colors); skip if log directory could not be created
  if (logDir !== null) {
    const fileLine = data
      ? `[${ts}] [${level.toUpperCase()}] [${component}] ${message} ${safeStringify(data)}`
      : `[${ts}] [${level.toUpperCase()}] [${component}] ${message}`;
    try { appendFileSync(LOG_FILE, fileLine + '\n'); } catch {}
  }
}

export const logger = {
  debug: (component: string, message: string, data?: Record<string, unknown>) =>
    log('debug', component, message, data),
  info: (component: string, message: string, data?: Record<string, unknown>) =>
    log('info', component, message, data),
  warn: (component: string, message: string, data?: Record<string, unknown>) =>
    log('warn', component, message, data),
  error: (component: string, message: string, data?: Record<string, unknown>) =>
    log('error', component, message, data),
  /** Path to the log file */
  logFile: LOG_FILE,
};
