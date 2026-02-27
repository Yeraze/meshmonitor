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

      const profile = await databaseService.getEmbedProfileByIdAsync(profileId);

      if (!profile || !profile.enabled) {
        return res.status(404).json({ error: 'Embed profile not found' });
      }

      // Store profile on request for downstream handlers
      (req as any).embedProfile = profile;

      // Remove X-Frame-Options to allow embedding in iframes
      res.removeHeader('X-Frame-Options');

      // Build frame-ancestors directive
      const frameAncestors = ['\'self\'', ...profile.allowedOrigins].join(' ');

      // Build a minimal embed-specific CSP
      const cspDirectives = [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https://*.tile.openstreetmap.org https://*.basemaps.cartocdn.com https://server.arcgisonline.com",
        "connect-src 'self' https://*.tile.openstreetmap.org https://*.basemaps.cartocdn.com https://server.arcgisonline.com",
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
