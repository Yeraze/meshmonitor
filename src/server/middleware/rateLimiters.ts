/**
 * Rate Limiting Middleware
 *
 * Provides rate limiting for API endpoints to prevent abuse
 */

import rateLimit from 'express-rate-limit';

// General API rate limiting
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
});

// Strict rate limiting for authentication endpoints
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 login attempts per windowMs
  skipSuccessfulRequests: true, // Don't count successful auth attempts
  message: 'Too many login attempts, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
});

// Moderate rate limiting for message sending
export const messageLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 10, // Limit each IP to 10 messages per minute
  message: 'Too many messages sent, please slow down',
  standardHeaders: true,
  legacyHeaders: false,
});
