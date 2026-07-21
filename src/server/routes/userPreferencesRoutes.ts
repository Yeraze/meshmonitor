/**
 * User Preferences Routes
 *
 * GET /user/map-preferences  — read the caller's saved map preferences (optionalAuth)
 * POST /user/map-preferences — save the caller's map preferences (requireAuth)
 *
 * Extracted verbatim from server.ts (was `apiRouter.get/post('/user/map-preferences', ...)`,
 * L4204/L4220) as part of #3502. Mounted at '/user' in server.ts. Distinct from
 * `/users` (userRoutes.ts, admin CRUD) — do NOT merge.
 */
import express from 'express';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { optionalAuth, requireAuth } from '../auth/authMiddleware.js';
import { getMapTilesetValidationError, normalizeMapTilesetPayload } from '../utils/mapTilesetPreferences.js';

const router = express.Router();

// Get user's map preferences
router.get('/map-preferences', optionalAuth(), async (req, res) => {
  try {
    // Anonymous users get null (will fall back to defaults in frontend)
    if (!req.user || req.user.username === 'anonymous') {
      return res.json({ preferences: null });
    }

    const preferences = await databaseService.getMapPreferencesAsync(req.user.id);
    res.json({ preferences });
  } catch (error) {
    logger.error('Error fetching user map preferences:', error);
    res.status(500).json({ error: 'Failed to fetch map preferences' });
  }
});

// Save user's map preferences
router.post('/map-preferences', requireAuth(), async (req, res) => {
  try {
    // Prevent saving preferences for anonymous user
    if (req.user!.username === 'anonymous') {
      return res.status(403).json({ error: 'Cannot save preferences for anonymous user' });
    }

    const { mapTileset, mapTilesetLight, mapTilesetDark, showPaths, showNeighborInfo, showRoute, showMotion, showMqttNodes, showUdpNodes, showRfNodes, showMeshCoreNodes, showWaypoints, showAnimations, showAccuracyRegions, showEstimatedPositions, positionHistoryPointsOnly, positionHistoryHours, mapMaxAgeHours } = req.body;

    // Validate boolean values
    const booleanFields = { showPaths, showNeighborInfo, showRoute, showMotion, showMqttNodes, showUdpNodes, showRfNodes, showMeshCoreNodes, showWaypoints, showAnimations, showAccuracyRegions, showEstimatedPositions, positionHistoryPointsOnly };
    for (const [key, value] of Object.entries(booleanFields)) {
      if (value !== undefined && typeof value !== 'boolean') {
        return res.status(400).json({ error: `${key} must be a boolean` });
      }
    }

    // Validate tileset IDs (optional strings). Custom IDs are valid here.
    const tilesetValidationError = getMapTilesetValidationError({ mapTileset, mapTilesetLight, mapTilesetDark });
    if (tilesetValidationError) {
      return res.status(400).json({ error: tilesetValidationError });
    }

    // Validate positionHistoryHours (optional number or null)
    if (positionHistoryHours !== undefined && positionHistoryHours !== null && typeof positionHistoryHours !== 'number') {
      return res.status(400).json({ error: 'positionHistoryHours must be a number or null' });
    }

    // Validate mapMaxAgeHours (optional number or null)
    if (mapMaxAgeHours !== undefined && mapMaxAgeHours !== null && typeof mapMaxAgeHours !== 'number') {
      return res.status(400).json({ error: 'mapMaxAgeHours must be a number or null' });
    }

    // Save preferences
    const normalizedTilesets = normalizeMapTilesetPayload({ mapTileset, mapTilesetLight, mapTilesetDark });
    await databaseService.saveMapPreferencesAsync(req.user!.id, {
      ...normalizedTilesets,
      showPaths,
      showNeighborInfo,
      showRoute,
      showMotion,
      showMqttNodes,
      showUdpNodes,
      showRfNodes,
      showMeshCoreNodes,
      showWaypoints,
      showAnimations,
      showAccuracyRegions,
      showEstimatedPositions,
      positionHistoryPointsOnly,
      positionHistoryHours,
      mapMaxAgeHours,
    });

    res.json({ success: true, message: 'Map preferences saved successfully' });
  } catch (error) {
    logger.error('Error saving user map preferences:', error);
    res.status(500).json({ error: 'Failed to save map preferences' });
  }
});

export default router;
