/**
 * Centralized logging utility for MeshMonitor
 *
 * In production builds, debug logs are suppressed to reduce noise.
 * Use appropriate log levels:
 * - debug: Development-only verbose logging
 * - info: Important runtime information
 * - warn: Warnings that don't prevent operation
 * - error: Errors that need attention
 */

const isDev = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';

export const logger = {
  /**
   * Debug logging - only shown in development
   * Use for verbose logging, state changes, data inspection
   */
  debug: (...args: any[]) => {
    if (isDev) {
      console.log('[DEBUG]', ...args);
    }
  },

  /**
   * Info logging - shown in all environments
   * Use for important operational messages
   */
  info: (...args: any[]) => {
    console.log('[INFO]', ...args);
  },

  /**
   * Warning logging - shown in all environments
   * Use for non-critical issues
   */
  warn: (...args: any[]) => {
    console.warn('[WARN]', ...args);
  },

  /**
   * Error logging - shown in all environments
   * Use for errors that need attention
   */
  error: (...args: any[]) => {
    console.error('[ERROR]', ...args);
  }
};
