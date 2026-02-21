/**
 * Rate Limiting Middleware
 *
 * Provides rate limiting for API endpoints to prevent abuse
 * Configurable via environment variables with sensible defaults
 * Logs all rate limit events for visibility
 */

import rateLimit from 'express-rate-limit';
import { getEnvironmentConfig } from '../config/environment.js';
import { logger } from '../../utils/logger.js';

const env = getEnvironmentConfig();

// When TRUST_PROXY is set, we need to skip express-rate-limit's validation
// We're relying on Express's trust proxy configuration which is set at the app level
const rateLimitConfig = {
  // Skip all validations - we trust Express's trust proxy handling
  validate: false,

  standardHeaders: true,
  legacyHeaders: false,
};

// Log rate limit configuration at startup
logger.info('⏱️  Rate limit configuration:');
logger.info(`   - API: ${env.rateLimitApi === 0 ? 'unlimited (disabled)' : `${env.rateLimitApi} requests per 15 minutes`}${env.rateLimitApiProvided ? ' (custom)' : ' (default)'}`);
logger.info(`   - Auth: ${env.rateLimitAuth === 0 ? 'unlimited (disabled)' : `${env.rateLimitAuth} attempts per 15 minutes`}${env.rateLimitAuthProvided ? ' (custom)' : ' (default)'}`);
logger.info(`   - Messages: ${env.rateLimitMessages === 0 ? 'unlimited (disabled)' : `${env.rateLimitMessages} messages per minute`}${env.rateLimitMessagesProvided ? ' (custom)' : ' (default)'}`);

// Log reverse proxy configuration warnings
if (!env.trustProxyProvided && env.isProduction) {
  logger.warn('⚠️  TRUST_PROXY not set - rate limiting will use proxy IP for all requests');
  logger.warn('   If behind a reverse proxy (nginx, Traefik, etc.), set TRUST_PROXY=1');
  logger.warn('   See: https://expressjs.com/en/guide/behind-proxies.html');
}
// General API rate limiting
// Configurable via RATE_LIMIT_API environment variable
// Default: 1000 requests per 15 minutes (~1 req/sec) in production, 10000 in development
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: env.rateLimitApi,
  message: 'Too many requests from this IP, please try again later',
  handler: (req, res) => {
    const ip = req.ip || 'unknown';
    logger.warn(`🚫 Rate limit exceeded for API - IP: ${ip}, Path: ${req.path}`);
    res.status(429).json({
      error: 'Too many requests from this IP, please try again later',
      retryAfter: '15 minutes'
    });
  },
  ...rateLimitConfig,
  ...(env.rateLimitApi === 0 ? { skip: () => true } : {}),
});

// Strict rate limiting for authentication endpoints
// Configurable via RATE_LIMIT_AUTH environment variable
// Default: 5 attempts per 15 minutes in production, 100 in development
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: env.rateLimitAuth,
  skipSuccessfulRequests: true, // Don't count successful auth attempts
  message: 'Too many login attempts, please try again later',
  handler: (req, res) => {
    const ip = req.ip || 'unknown';
    const username = req.body?.username || 'unknown';
    logger.warn(`🚫 Rate limit exceeded for AUTH - IP: ${ip}, Username: ${username}`);
    res.status(429).json({
      error: 'Too many login attempts, please try again later',
      retryAfter: '15 minutes'
    });
  },
  ...rateLimitConfig,
  ...(env.rateLimitAuth === 0 ? { skip: () => true } : {}),
});

// Moderate rate limiting for message sending
// Configurable via RATE_LIMIT_MESSAGES environment variable
// Default: 30 messages per minute in production, 100 in development
export const messageLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: env.rateLimitMessages,
  message: 'Too many messages sent, please slow down',
  handler: (req, res) => {
    const ip = req.ip || 'unknown';
    logger.warn(`🚫 Rate limit exceeded for MESSAGES - IP: ${ip}`);
    res.status(429).json({
      error: 'Too many messages sent, please slow down',
      retryAfter: '1 minute'
    });
  },
  ...rateLimitConfig,
  ...(env.rateLimitMessages === 0 ? { skip: () => true } : {}),
});

// Rate limiting for MeshCore device operations (connect, disconnect, config changes)
// More restrictive than general API to prevent device abuse
// Default: 10 operations per minute in production, 60 in development
export const meshcoreDeviceLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: env.isProduction ? 10 : 60,
  message: 'Too many device operations, please slow down',
  handler: (req, res) => {
    const ip = req.ip || 'unknown';
    logger.warn(`🚫 Rate limit exceeded for MESHCORE DEVICE - IP: ${ip}, Path: ${req.path}`);
    res.status(429).json({
      error: 'Too many device operations, please slow down',
      retryAfter: '1 minute'
    });
  },
  ...rateLimitConfig,
});
