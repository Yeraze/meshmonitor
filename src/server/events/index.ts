/**
 * Barrel export for the in-process event bus layer.
 *
 * - `EventBus`          — typed multi-plexer over dataEventEmitter
 * - `AuditLogger`       — first subscriber (writes audit lines)
 * - `createAuditLogger` — production factory (wires rotating-file-stream)
 */
export { EventBus } from './EventBus.js';
export type { DataEventPayloadMap } from './EventBus.js';
export { AuditLogger, formatAuditLine } from './AuditLogger.js';
export type { AuditWriteFn } from './AuditLogger.js';

import { createStream } from 'rotating-file-stream';
import fs from 'fs';
import path from 'path';
import { logger } from '../../utils/logger.js';
import { getEnvironmentConfig } from '../config/environment.js';
import { dataEventEmitter } from '../services/dataEventEmitter.js';
import { EventBus } from './EventBus.js';
import { AuditLogger, type AuditWriteFn } from './AuditLogger.js';

/**
 * Create the production AuditLogger wired to a rotating file stream.
 *
 * Returns `null` if event audit logging is disabled
 * (`EVENT_AUDIT_LOG_ENABLED=false`).
 *
 * Rotation: daily, keep 14 days, gzip compress — same policy as
 * the access logger (`middleware/accessLogger.ts`).
 */
export function createAuditLogger(): AuditLogger | null {
  const env = getEnvironmentConfig();

  if (!env.eventAuditLogEnabled) {
    logger.debug('[AuditLogger] disabled (EVENT_AUDIT_LOG_ENABLED=false)');
    return null;
  }

  try {
    const logDir = path.dirname(env.eventAuditLogPath);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    const stream = createStream(path.basename(env.eventAuditLogPath), {
      interval: '1d',
      maxFiles: 14,
      path: logDir,
      compress: 'gzip',
    });

    stream.on('error', (err: Error) => {
      logger.error('[AuditLogger] stream error:', err);
    });
    stream.on('rotation', () => {
      logger.debug('[AuditLogger] log rotated');
    });

    const write: AuditWriteFn = (line: string) => {
      stream.write(`${line}\n`);
    };

    // DataEventEmitter extends EventEmitter — structurally compatible.
    const bus = new EventBus(dataEventEmitter);
    const auditLogger = new AuditLogger(bus, write);
    auditLogger.start();

    logger.info(
      `✅ Event audit logging enabled: ${env.eventAuditLogPath} (daily rotation, 14 days, gzip)`,
    );
    return auditLogger;
  } catch (err) {
    logger.error('Failed to create event audit logger:', err);
    logger.error('Event audit logging will be disabled');
    return null;
  }
}
