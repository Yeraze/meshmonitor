/**
 * CSRF Protection Middleware
 *
 * Implements modern CSRF protection using double-submit cookie pattern
 * This is a more modern approach than the deprecated csurf package
 */

import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';

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
export async function csrfProtection(req: Request, res: Response, next: NextFunction) {
  // Skip CSRF check for safe methods
  if (!PROTECTED_METHODS.includes(req.method)) {
    return next();
  }

  // Skip CSRF only for requests authenticated by a VALID API token.
  //
  // CSRF attacks rely on the browser attaching an ambient credential (the
  // session cookie) to a cross-site request automatically. An API token is NOT
  // ambient: a browser never attaches it on its own, so the caller must set it
  // explicitly. A request proven to be authenticated by a valid token therefore
  // cannot be forged cross-site and does not need a CSRF token.
  //
  // We MUST validate the token, not merely detect a `Bearer ` prefix. The old
  // code skipped CSRF whenever any `Authorization: Bearer <anything>` header was
  // present. Because `requireAuth`/`optionalAuth` resolve the session cookie
  // BEFORE the Bearer token, a request carrying a real session cookie plus a
  // bogus Bearer value was still authenticated by the (CSRF-able) cookie, yet
  // skipped CSRF entirely. An attacker able to trigger a cross-site request (the
  // cookie rides along automatically) only had to add `Authorization: Bearer x`
  // to defeat CSRF on every state-mutating route (#6050).
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7); // Remove 'Bearer ' prefix
    try {
      const tokenUser = await databaseService.validateApiTokenAsync(token);
      if (tokenUser && tokenUser.isActive) {
        return next();
      }
    } catch (error) {
      // Fail closed: a validation error must never grant the exemption.
      logger.error('CSRF: error validating API token; enforcing CSRF check', error);
    }
    // No valid token — fall through to normal CSRF enforcement. A bogus Bearer
    // header no longer bypasses protection for a cookie-authenticated request.
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
      error: 'CSRF token missing. Please refresh the page and try again.',
      code: 'CSRF_SESSION_MISSING'
    });
  }

  // Get token from request (header or body)
  const requestToken = req.headers['x-csrf-token'] as string || req.body?._csrf;

  if (!requestToken) {
    logger.warn(`CSRF validation failed: No request token for ${req.method} ${req.path}`);
    return res.status(403).json({
      error: 'CSRF token required. Please refresh the page and try again.',
      code: 'CSRF_TOKEN_REQUIRED'
    });
  }

  // Ensure tokens are the same length before comparison (required for timingSafeEqual)
  const sessionBuffer = Buffer.from(sessionToken);
  const requestBuffer = Buffer.from(requestToken);

  if (sessionBuffer.length !== requestBuffer.length) {
    logger.warn(`CSRF validation failed: Token length mismatch for ${req.method} ${req.path} (session: ${sessionBuffer.length}, request: ${requestBuffer.length})`);
    return res.status(403).json({
      error: 'Invalid CSRF token. Please refresh the page and try again.',
      code: 'CSRF_TOKEN_INVALID'
    });
  }

  // Constant-time comparison to prevent timing attacks
  if (!crypto.timingSafeEqual(sessionBuffer, requestBuffer)) {
    logger.warn(`CSRF validation failed: Token mismatch for ${req.method} ${req.path}`);
    return res.status(403).json({
      error: 'Invalid CSRF token. Please refresh the page and try again.',
      code: 'CSRF_TOKEN_INVALID'
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
