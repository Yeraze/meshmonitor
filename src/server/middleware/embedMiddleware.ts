/**
 * Embed CSP Middleware
 *
 * Middleware factory for public embed endpoints. It:
 * 1. Looks up the embed profile by ID
 * 2. Validates the profile exists and is enabled
 * 3. Removes X-Frame-Options to allow embedding
 * 4. Sets Content-Security-Policy with frame-ancestors from allowedOrigins
 * 5. Attaches the profile to the request for downstream handlers
 */

import { Request, Response, NextFunction } from 'express';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';

export function createEmbedCspMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const profileId = req.params.profileId || req.params.id;

      if (!profileId) {
        return res.status(404).json({ error: 'Embed profile not found' });
      }

      const profile = await databaseService.embedProfiles.getByIdAsync(profileId);

      if (!profile || !profile.enabled) {
        return res.status(404).json({ error: 'Embed profile not found' });
      }

      // Store profile on request for downstream handlers
      (req as any).embedProfile = profile;

      // Remove X-Frame-Options to allow embedding in iframes
      res.removeHeader('X-Frame-Options');

      // Build frame-ancestors directive
      // Empty allowedOrigins means allow any origin (wildcard)
      const frameAncestors = profile.allowedOrigins.length === 0
        ? '*'
        : ['\'self\'', ...profile.allowedOrigins].join(' ');

      // Build a minimal embed-specific CSP.
      //
      // script-src drops 'unsafe-inline' in favour of the per-request nonce set
      // by dynamicCspMiddleware (MISC-09 / #6085). The embed HTML's own scripts
      // are all external `src=` files (covered by 'self'); the only inline
      // script is the optional analytics snippet, which carries the nonce
      // placeholder that staticServing substitutes at serve time. If no nonce
      // is present (unexpected — the global middleware always sets one), fall
      // back to 'unsafe-inline' so the page keeps working.
      const nonce = res.locals.cspNonce as string | undefined;
      const scriptSrc = nonce ? `script-src 'self' 'nonce-${nonce}'` : "script-src 'self' 'unsafe-inline'";
      const cspDirectives = [
        "default-src 'self'",
        scriptSrc,
        // style-src keeps 'unsafe-inline': the embedded Leaflet/MapLibre map
        // sets per-element style attributes that a nonce cannot cover.
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https://*.tile.openstreetmap.org https://*.basemaps.cartocdn.com https://basemaps.cartocdn.com https://server.arcgisonline.com",
        "connect-src 'self' ws: wss: https://*.tile.openstreetmap.org https://*.basemaps.cartocdn.com https://basemaps.cartocdn.com https://server.arcgisonline.com",
        "worker-src 'self' blob:",
        `frame-ancestors ${frameAncestors}`,
      ];

      res.setHeader('Content-Security-Policy', cspDirectives.join('; '));

      next();
    } catch (error) {
      logger.error('Error in embed CSP middleware:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  };
}
