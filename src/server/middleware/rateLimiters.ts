/**
 * Rate Limiting Middleware
 *
 * Provides rate limiting for API endpoints to prevent abuse
 * Uses relaxed limits in development, strict limits in production
 */

import rateLimit from 'express-rate-limit';

const isDevelopment = process.env.NODE_ENV !== 'production';

// When TRUST_PROXY is set, we need to skip express-rate-limit's validation
// We're relying on Express's trust proxy configuration which is set at the app level
const rateLimitConfig = {
  // Skip all validations - we trust Express's trust proxy handling
  validate: false,

  standardHeaders: true,
  legacyHeaders: false,
};

// General API rate limiting
// Development: Very high limit for real-time apps with SSE/polling
// Production: Reasonable limit that allows real-time monitoring (1000 req per 15min = ~1 req/sec)
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isDevelopment ? 10000 : 1000, // Dev: 10k requests, Prod: 1000 requests per window
  message: 'Too many requests from this IP, please try again later',
  ...rateLimitConfig,
});

// Strict rate limiting for authentication endpoints
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isDevelopment ? 100 : 5, // Dev: 100 attempts, Prod: 5 attempts per window
  skipSuccessfulRequests: true, // Don't count successful auth attempts
  message: 'Too many login attempts, please try again later',
  ...rateLimitConfig,
});

// Moderate rate limiting for message sending
export const messageLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: isDevelopment ? 100 : 30, // Dev: 100 messages, Prod: 30 messages per minute
  message: 'Too many messages sent, please slow down',
  ...rateLimitConfig,
});
