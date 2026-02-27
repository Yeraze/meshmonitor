/**
 * Embed Public Routes
 *
 * GET /:profileId/config — returns the public embed configuration
 * GET /:profileId/nodes  — returns nodes filtered by the profile's channels
 *
 * These routes are mounted outside the API router (no CSRF, no rate limiter).
 * The embed CSP middleware validates the profile and attaches it to the request.
 * The profile ID itself acts as the authorization token — no session required.
 */

import { Router, Request, Response } from 'express';
import { createEmbedCspMiddleware } from '../middleware/embedMiddleware.js';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';

const router = Router();

// GET /:profileId/config — return public config for the embed profile
// The CSP middleware is applied per-route so it can access req.params.profileId
router.get('/:profileId/config', createEmbedCspMiddleware(), (req: Request, res: Response) => {
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

// GET /:profileId/nodes — return nodes filtered by the profile's channel list
// The profile ID acts as the auth token — no session/login required.
// Only returns the minimal fields needed for map display (no sensitive data).
router.get('/:profileId/nodes', createEmbedCspMiddleware(), (req: Request, res: Response) => {
  const profile = (req as any).embedProfile;

  if (!profile) {
    return res.status(404).json({ error: 'Embed profile not found' });
  }

  try {
    const allNodes = databaseService.getActiveNodes(7);

    // Filter by the profile's configured channels
    const profileChannels = new Set(profile.channels as number[]);
    const filtered = allNodes.filter(node => {
      // Must have a position
      if (!node.latitude || !node.longitude) return false;
      if (node.latitude === 0 && node.longitude === 0) return false;

      // Filter by channels
      if (profileChannels.size > 0) {
        const ch = node.channel ?? 0;
        if (!profileChannels.has(ch)) return false;
      }

      // Filter out MQTT nodes if configured
      if (!profile.showMqttNodes && node.viaMqtt) return false;

      return true;
    });

    // Return only public-safe fields for map display
    const nodes = filtered.map(node => ({
      nodeNum: node.nodeNum,
      user: {
        longName: node.longName,
        shortName: node.shortName,
        hwModel: node.hwModel,
      },
      position: {
        latitude: node.latitude,
        longitude: node.longitude,
      },
      lastHeard: node.lastHeard,
      snr: node.snr,
      viaMqtt: node.viaMqtt || false,
      channel: node.channel ?? 0,
    }));

    res.json(nodes);
  } catch (error) {
    logger.error('Error fetching embed nodes:', error);
    res.status(500).json({ error: 'Failed to fetch nodes' });
  }
});

export default router;
