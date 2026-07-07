import { logger } from '../utils/logger.js';

/** Serialize an unknown thrown/rejected value for a single log line. */
function serializeReason(reason: unknown): string {
  if (reason instanceof Error) return reason.stack ?? `${reason.name}: ${reason.message}`;
  try {
    return typeof reason === 'string' ? reason : JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

export interface SafetyNetDeps {
  /** Route through the existing gracefulShutdown; exitCode 1 on fatal. */
  shutdown: (reason: string, exitCode?: number) => void;
  log?: Pick<typeof logger, 'error'>;
}

let installed = false;

/**
 * Register process-level last-resort handlers that log full context and route
 * through gracefulShutdown with a non-zero exit code. Idempotent per process.
 */
export function installProcessSafetyNet({ shutdown, log = logger }: SafetyNetDeps): void {
  if (installed) return;
  installed = true;

  process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
    log.error('💥 Unhandled promise rejection — shutting down', {
      reason: serializeReason(reason),
      promise: String(promise),
    });
    shutdown('unhandledRejection', 1);
  });

  process.on('uncaughtException', (error: Error, origin) => {
    log.error('💥 Uncaught exception — shutting down', {
      error: serializeReason(error),
      origin,
    });
    shutdown('uncaughtException', 1);
  });
}

/** Test-only: reset the install guard between tests. */
export function __resetProcessSafetyNetForTests(): void {
  installed = false;
}
