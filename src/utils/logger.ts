/**
 * Centralized logging utility for MeshMonitor
 *
 * Log level can be controlled via the LOG_LEVEL environment variable.
 * Valid values: debug, info, warn, error
 *
 * If LOG_LEVEL is not set, falls back to NODE_ENV behavior:
 * - development/test → debug
 * - production → info
 *
 * Use appropriate log levels:
 * - debug: Development-only verbose logging
 * - info: Important runtime information
 * - warn: Warnings that don't prevent operation
 * - error: Errors that need attention
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LOG_LEVEL_ORDER: LogLevel[] = ['debug', 'info', 'warn', 'error'];

function getLogLevel(): LogLevel {
  const envLevel = process.env.LOG_LEVEL?.toLowerCase();
  if (envLevel && LOG_LEVEL_ORDER.includes(envLevel as LogLevel)) {
    return envLevel as LogLevel;
  }
  // Fall back to NODE_ENV behavior
  const isDev = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
  return isDev ? 'debug' : 'info';
}

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
   * Debug logging - only shown when log level is debug
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
