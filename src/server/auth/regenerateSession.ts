import type { Request } from 'express';

/**
 * Give the request a fresh session ID before writing an identity into it, so a
 * session ID planted before login (session fixation) is discarded.
 *
 * Keeps the CSRF token across the change: the frontend caches it, and a new
 * session ID should not invalidate it. Used by password, MFA, OIDC and passkey
 * login (#5841).
 */
export function regenerateSession(req: Request): Promise<void> {
  const csrfToken = req.session.csrfToken;
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) reject(err);
      else {
        if (csrfToken) {
          req.session.csrfToken = csrfToken;
        }
        resolve();
      }
    });
  });
}
