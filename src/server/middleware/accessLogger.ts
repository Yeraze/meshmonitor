/**
 * Access Logger Middleware
 *
 * Provides Apache-style access logging for fail2ban integration.
 * Logs HTTP requests in standard Apache Combined Log Format:
 * IP - user [timestamp] "method path protocol" status size "referer" "user-agent"
 *
 * Features:
 * - Automatic log rotation (daily, keeps 14 days)
 * - Gzip compression of rotated logs
 * - Optional (disabled by default for performance)
 * - Configurable format (combined, common, tiny)
 */

import morgan from 'morgan';
import { createStream } from 'rotating-file-stream';
import path from 'path';
import fs from 'fs';
import { getEnvironmentConfig } from '../config/environment.js';
import { logger } from '../../utils/logger.js';
import type { RequestHandler } from 'express';

/**
 * Setup access logger middleware
 * Returns null if logging is disabled
 */
export function setupAccessLogger(): RequestHandler | null {
  const env = getEnvironmentConfig();

  if (!env.accessLogEnabled) {
    logger.debug('Access logging disabled (ACCESS_LOG_ENABLED=false)');
    return null;
  }

  try {
    // Ensure log directory exists
    const logDir = path.dirname(env.accessLogPath);
    if (!fs.existsSync(logDir)) {
      logger.info(`Creating log directory: ${logDir}`);
      fs.mkdirSync(logDir, { recursive: true });
    }

    // Create rotating write stream
    // Rotates daily, keeps 14 days, compresses old logs
    const accessLogStream = createStream(path.basename(env.accessLogPath), {
      interval: '1d',        // Rotate daily
      maxFiles: 14,          // Keep 14 days of logs
      path: logDir,
      compress: 'gzip'       // Compress rotated logs
    });

    // Add stream event handlers for monitoring
    accessLogStream.on('error', (err) => {
      logger.error('Access log stream error:', err);
    });

    accessLogStream.on('rotation', () => {
      logger.debug('Access log rotated');
    });

    // Create morgan middleware with configured format
    // Formats:
    // - combined: Apache Combined Log Format (includes referer and user-agent)
    // - common: Apache Common Log Format (basic request info)
    // - tiny: Minimal format for development
    const morganMiddleware = morgan(env.accessLogFormat, {
      stream: accessLogStream,
      // Skip logging for successful health checks to reduce noise
      skip: (req, res) => {
        return req.url === '/health' && res.statusCode === 200;
      }
    });

    logger.info(`✅ Access logging enabled: ${env.accessLogPath} (format: ${env.accessLogFormat})`);
    logger.info(`   Logs rotate daily, keeping 14 days (compressed with gzip)`);

    return morganMiddleware;
  } catch (err) {
    logger.error('Failed to setup access logger:', err);
    logger.error('Access logging will be disabled');
    return null;
  }
}
