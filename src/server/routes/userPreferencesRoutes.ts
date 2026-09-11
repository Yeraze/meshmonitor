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
import { fail } from '../utils/apiResponse.js';

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
      return fail(res, 403, 'ANONYMOUS_USER', 'Cannot save preferences for anonymous user');
    }

    const { mapTileset, mapTilesetLight, mapTilesetDark, showPaths, showNeighborInfo, showRoute, showMotion, showMqttNodes, showUdpNodes, showRfNodes, showMeshCoreNodes, showWaypoints, showAnimations, showAccuracyRegions, showEstimatedPositions, showAtakContacts, positionHistoryPointsOnly, positionHistoryHours, mapMaxAgeHours, unreadIndicatorEnabled, spreadNodes } = req.body;

    // Validate boolean values
    const booleanFields = { showPaths, showNeighborInfo, showRoute, showMotion, showMqttNodes, showUdpNodes, showRfNodes, showMeshCoreNodes, showWaypoints, showAnimations, showAccuracyRegions, showEstimatedPositions, showAtakContacts, positionHistoryPointsOnly, unreadIndicatorEnabled, spreadNodes };
    for (const [key, value] of Object.entries(booleanFields)) {
      if (value !== undefined && typeof value !== 'boolean') {
        return fail(res, 400, 'INVALID_PREFERENCE', `${key} must be a boolean`);
      }
    }

    // Validate tileset IDs (optional strings). Custom IDs are valid here.
    const tilesetValidationError = getMapTilesetValidationError({ mapTileset, mapTilesetLight, mapTilesetDark });
    if (tilesetValidationError) {
      return fail(res, 400, 'INVALID_TILESET', tilesetValidationError);
    }

    // Validate positionHistoryHours (optional number or null)
    if (positionHistoryHours !== undefined && positionHistoryHours !== null && typeof positionHistoryHours !== 'number') {
      return fail(res, 400, 'INVALID_PREFERENCE', 'positionHistoryHours must be a number or null');
    }

    // Validate mapMaxAgeHours (optional number or null)
    if (mapMaxAgeHours !== undefined && mapMaxAgeHours !== null && typeof mapMaxAgeHours !== 'number') {
      return fail(res, 400, 'INVALID_PREFERENCE', 'mapMaxAgeHours must be a number or null');
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
      showAtakContacts,
      positionHistoryPointsOnly,
      positionHistoryHours,
      mapMaxAgeHours,
      unreadIndicatorEnabled,
      spreadNodes,
    });

    // Deliberately NOT `ok(res)`: that emits a bare `{ success: true }` and
    // drops `message`, which this route's own test asserts — i.e. the field is
    // a codified part of the contract, not incidental. Converting it is a
    // response-shape change that belongs in its own PR, not a drive-by here
    // (#5177). The error paths above DO use `fail()`, which is always safe.
    res.json({ success: true, message: 'Map preferences saved successfully' });
  } catch (error) {
    logger.error('Error saving user map preferences:', error);
    fail(res, 500, 'SAVE_FAILED', 'Failed to save map preferences');
  }
});

export default router;
