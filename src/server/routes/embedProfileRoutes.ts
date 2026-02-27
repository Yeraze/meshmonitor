/**
 * Embed Profile Admin Routes
 *
 * GET    /embed-profiles       — list all embed profiles (admin only)
 * POST   /embed-profiles       — create embed profile (admin only)
 * PUT    /embed-profiles/:id   — update embed profile (admin only)
 * DELETE /embed-profiles/:id   — delete embed profile (admin only)
 */

import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { requireAdmin } from '../auth/authMiddleware.js';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';

const router = Router();

// All embed profile routes require admin access
router.use(requireAdmin());

// GET / — list all embed profiles
router.get('/', async (_req: Request, res: Response) => {
  try {
    const profiles = await databaseService.getEmbedProfilesAsync();
    res.json(profiles);
  } catch (error) {
    logger.error('Error fetching embed profiles:', error);
    res.status(500).json({ error: 'Failed to fetch embed profiles' });
  }
});

// POST / — create embed profile
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: 'Name is required' });
    }

    const id = randomUUID();
    const channels = Array.isArray(req.body.channels) ? req.body.channels : [];
    const tileset = typeof req.body.tileset === 'string' ? req.body.tileset : 'osm';
    const defaultLat = typeof req.body.defaultLat === 'number' ? req.body.defaultLat : 0;
    const defaultLng = typeof req.body.defaultLng === 'number' ? req.body.defaultLng : 0;
    const defaultZoom = typeof req.body.defaultZoom === 'number' ? req.body.defaultZoom : 10;
    const showTooltips = req.body.showTooltips !== false;
    const showPopups = req.body.showPopups !== false;
    const showLegend = req.body.showLegend !== false;
    const showPaths = req.body.showPaths === true;
    const showNeighborInfo = req.body.showNeighborInfo === true;
    const showMqttNodes = req.body.showMqttNodes !== false;
    const pollIntervalSeconds = typeof req.body.pollIntervalSeconds === 'number' ? req.body.pollIntervalSeconds : 30;
    const allowedOrigins = Array.isArray(req.body.allowedOrigins) ? req.body.allowedOrigins : [];
    const enabled = req.body.enabled !== false;

    const profile = await databaseService.createEmbedProfileAsync({
      id,
      name: name.trim(),
      enabled,
      channels,
      tileset,
      defaultLat,
      defaultLng,
      defaultZoom,
      showTooltips,
      showPopups,
      showLegend,
      showPaths,
      showNeighborInfo,
      showMqttNodes,
      pollIntervalSeconds,
      allowedOrigins,
    });

    databaseService.auditLog(
      req.user!.id,
      'embed_profile_created',
      'embed_profile',
      JSON.stringify({ id: profile.id, name: profile.name }),
      req.ip || null
    );

    res.status(201).json(profile);
  } catch (error) {
    logger.error('Error creating embed profile:', error);
    res.status(500).json({ error: 'Failed to create embed profile' });
  }
});

// PUT /:id — update embed profile
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const updates: Record<string, unknown> = {};

    // Only include fields that are present in the body
    if (req.body.name !== undefined) updates.name = req.body.name;
    if (req.body.enabled !== undefined) updates.enabled = req.body.enabled;
    if (req.body.channels !== undefined) updates.channels = req.body.channels;
    if (req.body.tileset !== undefined) updates.tileset = req.body.tileset;
    if (req.body.defaultLat !== undefined) updates.defaultLat = req.body.defaultLat;
    if (req.body.defaultLng !== undefined) updates.defaultLng = req.body.defaultLng;
    if (req.body.defaultZoom !== undefined) updates.defaultZoom = req.body.defaultZoom;
    if (req.body.showTooltips !== undefined) updates.showTooltips = req.body.showTooltips;
    if (req.body.showPopups !== undefined) updates.showPopups = req.body.showPopups;
    if (req.body.showLegend !== undefined) updates.showLegend = req.body.showLegend;
    if (req.body.showPaths !== undefined) updates.showPaths = req.body.showPaths;
    if (req.body.showNeighborInfo !== undefined) updates.showNeighborInfo = req.body.showNeighborInfo;
    if (req.body.showMqttNodes !== undefined) updates.showMqttNodes = req.body.showMqttNodes;
    if (req.body.pollIntervalSeconds !== undefined) updates.pollIntervalSeconds = req.body.pollIntervalSeconds;
    if (req.body.allowedOrigins !== undefined) updates.allowedOrigins = req.body.allowedOrigins;

    const profile = await databaseService.updateEmbedProfileAsync(id, updates);

    if (!profile) {
      return res.status(404).json({ error: 'Embed profile not found' });
    }

    databaseService.auditLog(
      req.user!.id,
      'embed_profile_updated',
      'embed_profile',
      JSON.stringify({ id: profile.id, name: profile.name }),
      req.ip || null
    );

    res.json(profile);
  } catch (error) {
    logger.error('Error updating embed profile:', error);
    res.status(500).json({ error: 'Failed to update embed profile' });
  }
});

// DELETE /:id — delete embed profile
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const deleted = await databaseService.deleteEmbedProfileAsync(id);

    if (!deleted) {
      return res.status(404).json({ error: 'Embed profile not found' });
    }

    databaseService.auditLog(
      req.user!.id,
      'embed_profile_deleted',
      'embed_profile',
      JSON.stringify({ id }),
      req.ip || null
    );

    res.status(204).send();
  } catch (error) {
    logger.error('Error deleting embed profile:', error);
    res.status(500).json({ error: 'Failed to delete embed profile' });
  }
});

export default router;
