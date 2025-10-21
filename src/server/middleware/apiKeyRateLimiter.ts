/**
 * API Key Rate Limiter
 *
 * Rate limiting middleware specifically for API key authentication
 * Stricter limits than session-based authentication
 */

import rateLimit from 'express-rate-limit';
import { Request, Response } from 'express';
import { logger } from '../../utils/logger.js';

/**
 * Rate limiter for API key authenticated requests
 * 100 requests per 15 minutes per API key
 */
export const apiKeyRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per window
  message: {
    error: 'Rate limit exceeded. Please try again later.',
    message: 'Too many requests from this API key'
  },
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers

  // Key generator - use API key ID if available, otherwise fall back to IP
  keyGenerator: (req: Request): string => {
    // If authenticated via API key, use the user ID as the key
    if (req.apiKeyAuth && req.user) {
      return `api_key_${req.user.id}`;
    }
    // Fallback to IP address for session-based auth
    return req.ip || req.socket.remoteAddress || 'unknown';
  },

  // Custom handler for rate limit exceeded
  handler: (req: Request, res: Response) => {
    logger.warn(`Rate limit exceeded for ${req.apiKeyAuth ? 'API key' : 'session'} from ${req.ip}`);
    res.status(429).json({
      error: 'Rate limit exceeded',
      message: 'Too many requests. Please try again later.',
      retryAfter: res.getHeader('Retry-After')
    });
  },

  // Skip rate limiting for successful requests if needed
  skip: (req: Request): boolean => {
    // Don't rate limit health check endpoints
    return req.path === '/health' || req.path === '/api/v1/health';
  }
});

/**
 * More relaxed rate limiter for documentation endpoints
 * 30 requests per 15 minutes
 */
export const docsRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: {
    error: 'Rate limit exceeded. Please try again later.',
    message: 'Too many documentation requests'
  },
  standardHeaders: true,
  legacyHeaders: false
});
