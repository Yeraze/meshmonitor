/**
 * Embed Public Routes
 *
 * GET /:profileId/config — returns the public embed configuration
 *
 * These routes are mounted outside the API router (no CSRF, no rate limiter).
 * The embed CSP middleware must run before these routes to populate req.embedProfile.
 */

import { Router, Request, Response } from 'express';

const router = Router();

// GET /:profileId/config — return public config for the embed profile
router.get('/:profileId/config', (req: Request, res: Response) => {
  const profile = (req as any).embedProfile;

  if (!profile) {
    return res.status(404).json({ error: 'Embed profile not found' });
  }

  // Return only public-facing configuration (exclude admin-only fields like name, allowedOrigins)
  res.json({
    id: profile.id,
    channels: profile.channels,
    tileset: profile.tileset,
    defaultLat: profile.defaultLat,
    defaultLng: profile.defaultLng,
    defaultZoom: profile.defaultZoom,
    showTooltips: profile.showTooltips,
    showPopups: profile.showPopups,
    showLegend: profile.showLegend,
    showPaths: profile.showPaths,
    showNeighborInfo: profile.showNeighborInfo,
    showMqttNodes: profile.showMqttNodes,
    pollIntervalSeconds: profile.pollIntervalSeconds,
  });
});

export default router;
