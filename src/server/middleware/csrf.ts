/**
 * CSRF Protection Middleware
 *
 * Implements modern CSRF protection using double-submit cookie pattern
 * This is a more modern approach than the deprecated csurf package
 */

import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { logger } from '../../utils/logger.js';

// Methods that require CSRF protection
const PROTECTED_METHODS = ['POST', 'PUT', 'DELETE', 'PATCH'];

/**
 * Generate a CSRF token
 */
export function generateCsrfToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Middleware to attach CSRF token to session/response
 */
export function csrfTokenMiddleware(req: Request, _res: Response, next: NextFunction) {
  // Generate token if not present in session
  if (!req.session.csrfToken) {
    req.session.csrfToken = generateCsrfToken();
  }

  // Make token available to the request
  (req as any).csrfToken = () => req.session.csrfToken;

  next();
}

/**
 * Middleware to validate CSRF token
 */
export function csrfProtection(req: Request, res: Response, next: NextFunction) {
  // Skip CSRF check for safe methods
  if (!PROTECTED_METHODS.includes(req.method)) {
    return next();
  }

  // Skip CSRF check for API token authenticated requests (Bearer token)
  // CSRF protection is for browser-based sessions using cookies
  // API tokens are not stored in cookies and must be explicitly provided,
  // so they are inherently protected against CSRF attacks
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return next();
  }

  // Skip CSRF check for endpoints that must be accessible without tokens
  // /csrf-token: Users need this to get a token before they have one
  // /auth/status: Public endpoint for checking auth state
  if (req.path === '/csrf-token' || req.path === '/auth/status' || req.method === 'GET') {
    return next();
  }

  // Get token from session
  const sessionToken = req.session.csrfToken;

  if (!sessionToken) {
    logger.warn(`CSRF validation failed: No session token for ${req.method} ${req.path}`);
    return res.status(403).json({
      error: 'CSRF token missing. Please refresh the page and try again.'
    });
  }

  // Get token from request (header or body)
  const requestToken = req.headers['x-csrf-token'] as string || req.body?._csrf;

  if (!requestToken) {
    logger.warn(`CSRF validation failed: No request token for ${req.method} ${req.path}`);
    return res.status(403).json({
      error: 'CSRF token required. Please refresh the page and try again.'
    });
  }

  // Ensure tokens are the same length before comparison (required for timingSafeEqual)
  const sessionBuffer = Buffer.from(sessionToken);
  const requestBuffer = Buffer.from(requestToken);

  if (sessionBuffer.length !== requestBuffer.length) {
    logger.warn(`CSRF validation failed: Token length mismatch for ${req.method} ${req.path} (session: ${sessionBuffer.length}, request: ${requestBuffer.length})`);
    return res.status(403).json({
      error: 'Invalid CSRF token. Please refresh the page and try again.'
    });
  }

  // Constant-time comparison to prevent timing attacks
  if (!crypto.timingSafeEqual(sessionBuffer, requestBuffer)) {
    logger.warn(`CSRF validation failed: Token mismatch for ${req.method} ${req.path}`);
    return res.status(403).json({
      error: 'Invalid CSRF token. Please refresh the page and try again.'
    });
  }

  // Token is valid
  next();
}

/**
 * Endpoint to get CSRF token for the frontend
 */
export function csrfTokenEndpoint(req: Request, res: Response) {
  const token = req.session.csrfToken || generateCsrfToken();
  req.session.csrfToken = token;

  res.json({ csrfToken: token });
}
