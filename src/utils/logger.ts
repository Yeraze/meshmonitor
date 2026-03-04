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

export const logger = {
  /**
   * Debug logging - only shown when log level is debug
   * Use for verbose logging, state changes, data inspection
   */
  debug: (...args: any[]) => {
    if (shouldLog('debug')) {
      console.log('[DEBUG]', ...args);
    }
  },

  /**
   * Info logging - shown when log level is debug or info
   * Use for important operational messages
   */
  info: (...args: any[]) => {
    if (shouldLog('info')) {
      console.log('[INFO]', ...args);
    }
  },

  /**
   * Warning logging - shown when log level is debug, info, or warn
   * Use for non-critical issues
   */
  warn: (...args: any[]) => {
    if (shouldLog('warn')) {
      console.warn('[WARN]', ...args);
    }
  },

  /**
   * Error logging - always shown
   * Use for errors that need attention
   */
  error: (...args: any[]) => {
    if (shouldLog('error')) {
      console.error('[ERROR]', ...args);
    }
  }
};
