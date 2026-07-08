/**
 * Centralized logging utility for MeshMonitor
 *
 * Log level can be controlled via the LOG_LEVEL environment variable.
 * Valid values: trace, debug, info, warn, error
 *
 * If LOG_LEVEL is not set, falls back to NODE_ENV behavior:
 * - development/test → debug
 * - production → info
 *
 * Use appropriate log levels:
 * - trace: Firehose — per-packet / per-loop-iteration diagnostics. Off unless
 *          explicitly requested; never enable in production for more than a
 *          short capture window.
 * - debug: Verbose but bounded — routine per-event, periodic scheduler cycles,
 *          connection handshake steps, state inspection. Hidden by default.
 * - info:  Important, low-frequency runtime events a support engineer wants in
 *          a production log by default: startup/shutdown, source connect/
 *          disconnect, migrations/backups/restores, actions actually taken.
 *          Keep this tier sparse — an idle container should be near-silent.
 * - warn:  Warnings that don't prevent operation
 * - error: Errors that need attention
 */

type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';
const LOG_LEVEL_ORDER: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error'];

function getLogLevel(): LogLevel {
  const envLevel = process.env.LOG_LEVEL?.toLowerCase();
  if (envLevel && LOG_LEVEL_ORDER.includes(envLevel as LogLevel)) {
    return envLevel as LogLevel;
  }
  // Fall back to NODE_ENV behavior
  const isDev = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
  return isDev ? 'debug' : 'info';
}

// Evaluated once at module import. Changing process.env.LOG_LEVEL after import
// has no effect on the live logger; tests that vary the level must call
// vi.resetModules() (see logger.test.ts) to force a re-import.
const currentLevel = getLogLevel();

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_ORDER.indexOf(level) >= LOG_LEVEL_ORDER.indexOf(currentLevel);
}

// Match ASCII C0 controls (incl. \r and \n), DEL, and C1 controls.
// Used to defang untrusted strings before they reach console.log so an
// attacker can't inject new log lines (CWE-117). Built via new RegExp to
// avoid literal control characters in this source file.
const CONTROL_CHAR_RE = new RegExp('[\\x00-\\x1F\\x7F-\\x9F]+', 'g');

function sanitizeForLog(arg: unknown): unknown {
  if (typeof arg !== 'string') return arg;
  return arg.replace(CONTROL_CHAR_RE, ' ');
}

function sanitizeArgs(args: unknown[]): unknown[] {
  return args.map(sanitizeForLog);
}

export const logger = {
  /**
   * Trace logging - only shown when log level is trace
   * Use for per-packet / per-loop firehose diagnostics that are far too
   * verbose even for debug. Off by default at every other level.
   *
   * Note: `args` is typed `unknown[]` here (the peers below use `any[]`) on
   * purpose — `sanitizeArgs` already accepts `unknown[]`, and using `any`
   * would add a `@typescript-eslint/no-explicit-any` violation above the
   * lint-ratchet baseline. Leave as `unknown[]`.
   */
  trace: (...args: unknown[]) => {
    if (shouldLog('trace')) {
      console.log('[TRACE]', ...sanitizeArgs(args));
    }
  },

  /**
   * Debug logging - shown when log level is trace or debug
   * Use for verbose logging, state changes, data inspection
   */
  debug: (...args: any[]) => {
    if (shouldLog('debug')) {
      console.log('[DEBUG]', ...sanitizeArgs(args));
    }
  },

  /**
   * Info logging - shown when log level is debug or info
   * Use for important operational messages
   */
  info: (...args: any[]) => {
    if (shouldLog('info')) {
      console.log('[INFO]', ...sanitizeArgs(args));
    }
  },

  /**
   * Warning logging - shown when log level is debug, info, or warn
   * Use for non-critical issues
   */
  warn: (...args: any[]) => {
    if (shouldLog('warn')) {
      console.warn('[WARN]', ...sanitizeArgs(args));
    }
  },

  /**
   * Error logging - always shown
   * Use for errors that need attention
   */
  error: (...args: any[]) => {
    if (shouldLog('error')) {
      console.error('[ERROR]', ...sanitizeArgs(args));
    }
  }
};
