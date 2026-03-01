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

/** Validate that a value is a valid URL origin or CSP wildcard pattern.
 *  Accepts:
 *   - Standard origins: https://example.com, http://example.com:8080
 *   - CSP wildcard hosts: https://*.example.com, http://*.example.com:8080
 */
function isValidOrigin(origin: unknown): origin is string {
  if (typeof origin !== 'string') return false;

  // Handle CSP wildcard host patterns like https://*.example.com
  const wildcardMatch = origin.match(/^(https?:\/\/)\*\.(.+)$/);
  if (wildcardMatch) {
    try {
      // Validate by replacing the wildcard with a concrete subdomain
      const testUrl = new URL(`${wildcardMatch[1]}wildcard.${wildcardMatch[2]}`);
      const reconstructed = `${testUrl.protocol}//*.${testUrl.host.replace(/^wildcard\./, '')}`;
      return reconstructed === origin;
    } catch {
      return false;
    }
  }

  try {
    const url = new URL(origin);
    return (url.protocol === 'https:' || url.protocol === 'http:') &&
           !url.hostname.includes('*') &&
           origin === url.origin;
  } catch {
    return false;
  }
}

/** Filter and validate channel numbers (must be integers 0-7) */
function validateChannels(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((ch): ch is number => typeof ch === 'number' && Number.isInteger(ch) && ch >= 0 && ch <= 7);
}

/** Clamp poll interval to safe bounds (10-300 seconds) */
function clampPollInterval(val: unknown): number {
  if (typeof val !== 'number') return 30;
  return Math.max(10, Math.min(300, val));
}

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
    const channels = validateChannels(req.body.channels);
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
    const pollIntervalSeconds = clampPollInterval(req.body.pollIntervalSeconds);
    const allowedOrigins = Array.isArray(req.body.allowedOrigins)
      ? req.body.allowedOrigins.filter(isValidOrigin)
      : [];
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

    // Only include fields that are present in the body, with type validation
    if (req.body.name !== undefined && typeof req.body.name === 'string') updates.name = req.body.name.trim();
    if (req.body.enabled !== undefined) updates.enabled = Boolean(req.body.enabled);
    if (req.body.channels !== undefined) updates.channels = validateChannels(req.body.channels);
    if (req.body.tileset !== undefined && typeof req.body.tileset === 'string') updates.tileset = req.body.tileset;
    if (req.body.defaultLat !== undefined && typeof req.body.defaultLat === 'number') updates.defaultLat = req.body.defaultLat;
    if (req.body.defaultLng !== undefined && typeof req.body.defaultLng === 'number') updates.defaultLng = req.body.defaultLng;
    if (req.body.defaultZoom !== undefined && typeof req.body.defaultZoom === 'number') updates.defaultZoom = req.body.defaultZoom;
    if (req.body.showTooltips !== undefined) updates.showTooltips = Boolean(req.body.showTooltips);
    if (req.body.showPopups !== undefined) updates.showPopups = Boolean(req.body.showPopups);
    if (req.body.showLegend !== undefined) updates.showLegend = Boolean(req.body.showLegend);
    if (req.body.showPaths !== undefined) updates.showPaths = Boolean(req.body.showPaths);
    if (req.body.showNeighborInfo !== undefined) updates.showNeighborInfo = Boolean(req.body.showNeighborInfo);
    if (req.body.showMqttNodes !== undefined) updates.showMqttNodes = Boolean(req.body.showMqttNodes);
    if (req.body.pollIntervalSeconds !== undefined) updates.pollIntervalSeconds = clampPollInterval(req.body.pollIntervalSeconds);
    if (req.body.allowedOrigins !== undefined) updates.allowedOrigins = Array.isArray(req.body.allowedOrigins)
      ? req.body.allowedOrigins.filter(isValidOrigin) : [];

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
