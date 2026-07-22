/**
 * MeshCore API Routes — config group
 *
 * Device configuration: discoverable/default-scope/saved-regions/sync-time/
 * reboot/private-key/name/tx-power/radio/coords/advert-loc-policy/telemetry
 * modes. Extracted verbatim from the former monolithic `meshcoreRoutes.ts`
 * (epic #3962 Task 4.3).
 */

import { Router, Request, Response } from 'express';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { isMeshCoreManager } from '../sourceManagerTypes.js';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { requireAuth, requirePermission } from '../auth/authMiddleware.js';
import { meshcoreDeviceLimiter } from '../middleware/rateLimiters.js';
import { managerFor, isValidName, isValidRadioParams, auditMeshcoreEvent } from './meshcoreRouteShared.js';

const router = Router({ mergeParams: true });

/**
 * GET /api/sources/:id/meshcore/config/discoverable
 *
 * Whether this node answers inbound discovery requests (is discoverable by
 * others). Reciprocal of the discovery feature — see MeshCore issue #1027.
 */
router.get(
  '/config/discoverable',
  requireAuth(),
  requirePermission('configuration', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const enabled = await managerFor(req, res).getRespondToDiscovery();
      res.json({ success: true, enabled });
    } catch (error) {
      logger.error('[API] Error reading discoverable setting:', error);
      res.status(500).json({ success: false, error: 'Failed to read setting' });
    }
  },
);

/**
 * POST /api/sources/:id/meshcore/config/discoverable
 *
 * Enable/disable answering inbound discovery requests. Body: { enabled: bool }.
 * When enabled, this companion replies to NODE_DISCOVER_REQ with a zero-hop
 * advert of its public key so nearby nodes can discover it.
 */
router.post(
  '/config/discoverable',
  meshcoreDeviceLimiter,
  requireAuth(),
  requirePermission('configuration', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const enabled = req.body?.enabled;
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ success: false, error: 'enabled must be a boolean' });
      }
      await managerFor(req, res).setRespondToDiscovery(enabled);
      res.json({ success: true, enabled });
    } catch (error) {
      logger.error('[API] Error setting discoverable:', error);
      res.status(500).json({ success: false, error: 'Failed to update setting' });
    }
  },
);

/**
 * GET /api/sources/:id/meshcore/config/default-scope
 *
 * The per-source default MeshCore region/scope (#3667). Empty = unscoped.
 */
router.get(
  '/config/default-scope',
  requireAuth(),
  requirePermission('configuration', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const scope = await managerFor(req, res).getDefaultScope();
      res.json({ success: true, scope });
    } catch (error) {
      logger.error('[API] Error reading default scope:', error);
      res.status(500).json({ success: false, error: 'Failed to read setting' });
    }
  },
);

/**
 * POST /api/sources/:id/meshcore/config/default-scope
 *
 * Set the per-source default region/scope. Body: { scope: string } — a plain
 * region name (alphanumeric + hyphen, optional leading '#' which is stripped),
 * or '' to clear (unscoped). Applied to all originated flood traffic that has
 * no channel-specific scope.
 */
router.post(
  '/config/default-scope',
  meshcoreDeviceLimiter,
  requireAuth(),
  requirePermission('configuration', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const raw = req.body?.scope;
      if (raw !== '' && typeof raw !== 'string') {
        return res.status(400).json({ success: false, error: 'scope must be a string' });
      }
      const stripped = (raw as string).trim().replace(/^#/, '');
      if (stripped !== '' && !/^[A-Za-z0-9-]{1,63}$/.test(stripped)) {
        return res.status(400).json({ success: false, error: 'Scope must be 1-63 chars: letters, digits, hyphen' });
      }
      const scope = await managerFor(req, res).setDefaultScope(stripped);
      res.json({ success: true, scope });
    } catch (error) {
      logger.error('[API] Error setting default scope:', error);
      res.status(500).json({ success: false, error: 'Failed to update setting' });
    }
  },
);

/**
 * Saved regions catalog (#3770) — a GLOBAL, user-maintained list of MeshCore
 * region names used to populate scope dropdowns (channel settings + per-message
 * override) so users don't have to type/remember scopes. The catalog is not
 * source-scoped (a scope is derived purely from a region name), but the routes
 * live under the source-scoped meshcore router and reuse its auth wiring.
 *
 * GET    .../saved-regions      → list all saved regions
 * POST   .../saved-regions      → { name, note? } add (idempotent)
 * DELETE .../saved-regions/:id  → delete one
 */
router.get(
  '/saved-regions',
  requireAuth(),
  requirePermission('configuration', 'read', { sourceIdFrom: 'params.id' }),
  async (_req: Request, res: Response) => {
    try {
      const regions = await databaseService.savedRegions.getAllAsync();
      res.json({ success: true, regions });
    } catch (error) {
      logger.error('[API] Error listing saved regions:', error);
      res.status(500).json({ success: false, error: 'Failed to list saved regions' });
    }
  },
);

router.post(
  '/saved-regions',
  requireAuth(),
  requirePermission('configuration', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const name = req.body?.name;
      const note = req.body?.note;
      if (typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ success: false, error: 'name is required' });
      }
      if (name.length > 64) {
        return res.status(400).json({ success: false, error: 'name must be 64 characters or fewer' });
      }
      if (note !== undefined && note !== null && typeof note !== 'string') {
        return res.status(400).json({ success: false, error: 'note must be a string' });
      }
      const region = await databaseService.savedRegions.addAsync(name, note ?? null);
      // Refresh the scope cache on every manager so the new region name is
      // available for resolving inbound messages immediately (#3829).
      for (const mgr of sourceManagerRegistry.getAllManagers().filter(isMeshCoreManager)) {
        mgr.notifySavedRegionsChanged();
      }
      res.json({ success: true, region });
    } catch (error: any) {
      // addAsync throws on an empty/invalid normalized name.
      if (error?.message?.includes('Invalid region name')) {
        return res.status(400).json({ success: false, error: error.message });
      }
      logger.error('[API] Error adding saved region:', error);
      res.status(500).json({ success: false, error: 'Failed to add saved region' });
    }
  },
);

router.delete(
  '/saved-regions/:regionId',
  requireAuth(),
  requirePermission('configuration', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.regionId);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ success: false, error: 'Invalid region id' });
      }
      await databaseService.savedRegions.deleteAsync(id);
      // Refresh the scope cache on every manager so the deleted region is
      // no longer matched against inbound messages (#3829).
      for (const mgr of sourceManagerRegistry.getAllManagers().filter(isMeshCoreManager)) {
        mgr.notifySavedRegionsChanged();
      }
      res.json({ success: true });
    } catch (error) {
      logger.error('[API] Error deleting saved region:', error);
      res.status(500).json({ success: false, error: 'Failed to delete saved region' });
    }
  },
);

/**
 * POST /api/sources/:id/meshcore/config/sync-time
 *
 * Sync the device's RTC to the server's current time. Companion only.
 */
router.post(
  '/config/sync-time',
  meshcoreDeviceLimiter,
  requireAuth(),
  requirePermission('configuration', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const result = await managerFor(req, res).syncDeviceTime();
      if (!result.ok) {
        if (result.reason === 'command-failed') {
          // The guards passed but the device rejected (or never acked) the
          // command — surface the real reason instead of the misleading
          // "disconnected or not a Companion device" (issue #3570).
          return res.status(502).json({
            success: false,
            error: result.error
              ? `Device rejected the time-sync command: ${result.error}`
              : 'Device rejected the time-sync command',
          });
        }
        return res.status(409).json({
          success: false,
          error: 'Sync time failed — source disconnected or not a Companion device',
        });
      }
      res.json({ success: true, message: 'Device time synced' });
    } catch (error) {
      logger.error('[API] Error syncing device time:', error);
      res.status(500).json({ success: false, error: 'Failed to sync time' });
    }
  },
);

/**
 * POST /api/sources/:id/meshcore/config/reboot
 *
 * Reboot the locally connected device. Destructive — requires confirm:true.
 * The device will disconnect and restart; the source will need to reconnect.
 */
router.post(
  '/config/reboot',
  meshcoreDeviceLimiter,
  requireAuth(),
  requirePermission('configuration', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const { confirm } = req.body as { confirm?: boolean };
      if (confirm !== true) {
        return res.status(400).json({
          success: false,
          error: 'Reboot requires confirm:true in the request body',
          code: 'DANGER_CONFIRM_REQUIRED',
        });
      }
      const ok = await managerFor(req, res).rebootDevice();
      if (!ok) {
        return res.status(409).json({
          success: false,
          error: 'Reboot failed — source disconnected or not a Companion device',
        });
      }
      auditMeshcoreEvent(req, 'meshcore_reboot', 'configuration', {
        sourceId: req.params.id,
      });
      res.json({ success: true, message: 'Reboot command sent' });
    } catch (error) {
      logger.error('[API] Error rebooting device:', error);
      res.status(500).json({ success: false, error: 'Failed to reboot' });
    }
  },
);

/**
 * GET /api/sources/:id/meshcore/config/private-key
 *
 * Export the device's Ed25519 private key for backup. Returns the hex
 * string. SECURITY-SENSITIVE — gated on configuration:write.
 */
router.get(
  '/config/private-key',
  requireAuth(),
  requirePermission('configuration', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const hex = await managerFor(req, res).exportPrivateKey();
      if (!hex) {
        return res.status(409).json({
          success: false,
          error: 'Export private key failed — source disconnected or not a Companion device',
        });
      }
      auditMeshcoreEvent(req, 'meshcore_export_private_key', 'configuration', {
        sourceId: req.params.id,
      });
      res.json({ success: true, data: { privateKey: hex } });
    } catch (error) {
      logger.error('[API] Error exporting private key:', error);
      res.status(500).json({ success: false, error: 'Failed to export private key' });
    }
  },
);

/**
 * POST /api/sources/:id/meshcore/config/private-key
 *
 * Import an Ed25519 private key onto the device. Replaces the device
 * identity. DESTRUCTIVE + SECURITY-SENSITIVE — requires confirm:true.
 * Body: { privateKey: string (128-char hex), confirm: true }
 */
router.post(
  '/config/private-key',
  meshcoreDeviceLimiter,
  requireAuth(),
  requirePermission('configuration', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const { privateKey, confirm } = req.body as { privateKey?: string; confirm?: boolean };
      if (confirm !== true) {
        return res.status(400).json({
          success: false,
          error: 'Import private key requires confirm:true — this replaces the device identity',
          code: 'DANGER_CONFIRM_REQUIRED',
        });
      }
      if (typeof privateKey !== 'string' || !/^[0-9a-fA-F]{128}$/.test(privateKey)) {
        return res.status(400).json({
          success: false,
          error: 'privateKey must be a 128-character hex string',
        });
      }
      const ok = await managerFor(req, res).importPrivateKey(privateKey);
      if (!ok) {
        return res.status(409).json({
          success: false,
          error: 'Import private key failed — source disconnected or not a Companion device',
        });
      }
      auditMeshcoreEvent(req, 'meshcore_import_private_key', 'configuration', {
        sourceId: req.params.id,
      });
      res.json({ success: true, message: 'Private key imported — device identity changed' });
    } catch (error) {
      logger.error('[API] Error importing private key:', error);
      res.status(500).json({ success: false, error: 'Failed to import private key' });
    }
  },
);

/**
 * POST /api/meshcore/config/name
 * Set device name
 * Requires authentication - modifies device configuration
 */
router.post('/config/name', meshcoreDeviceLimiter, requireAuth(), requirePermission('configuration', 'write', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const { name } = req.body;

    // Validate name
    const nameValidation = isValidName(name);
    if (!nameValidation.valid) {
      return res.status(400).json({ success: false, error: nameValidation.error });
    }

    const success = await managerFor(req, res).setName(name.trim());

    if (success) {
      res.json({ success: true, message: 'Name updated' });
    } else {
      res.status(400).json({ success: false, error: 'Failed to update name' });
    }
  } catch (error) {
    logger.error('[API] Error setting name:', error);
    res.status(500).json({ success: false, error: 'Config error' });
  }
});

/**
 * POST /api/meshcore/config/tx-power
 * Set TX power (dBm)
 * Requires authentication - modifies device radio configuration
 */
router.post('/config/tx-power', meshcoreDeviceLimiter, requireAuth(), requirePermission('configuration', 'write', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const { power } = req.body;

    if (power === undefined) {
      return res.status(400).json({ success: false, error: 'power is required' });
    }

    const parsedPower = parseInt(power, 10);

    if (isNaN(parsedPower) || parsedPower < 1 || parsedPower > 22) {
      return res.status(400).json({ success: false, error: 'TX power must be between 1 and 22 dBm' });
    }

    const success = await managerFor(req, res).setTxPower(parsedPower);

    if (success) {
      res.json({ success: true, message: 'TX power updated' });
    } else {
      res.status(400).json({ success: false, error: 'Failed to update TX power' });
    }
  } catch (error) {
    logger.error('[API] Error setting TX power:', error);
    res.status(500).json({ success: false, error: 'Config error' });
  }
});

/**
 * POST /api/meshcore/config/radio
 * Set radio parameters
 * Requires authentication - modifies device radio configuration
 */
router.post('/config/radio', meshcoreDeviceLimiter, requireAuth(), requirePermission('configuration', 'write', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const { freq, bw, sf, cr } = req.body;

    if (freq === undefined || bw === undefined || sf === undefined || cr === undefined) {
      return res.status(400).json({ success: false, error: 'All radio parameters required (freq, bw, sf, cr)' });
    }

    // Parse and validate radio parameters
    const parsedFreq = parseFloat(freq);
    const parsedBw = parseFloat(bw);
    const parsedSf = parseInt(sf, 10);
    const parsedCr = parseInt(cr, 10);

    if (isNaN(parsedFreq) || isNaN(parsedBw) || isNaN(parsedSf) || isNaN(parsedCr)) {
      return res.status(400).json({ success: false, error: 'Radio parameters must be valid numbers' });
    }

    const radioValidation = isValidRadioParams(parsedFreq, parsedBw, parsedSf, parsedCr);
    if (!radioValidation.valid) {
      return res.status(400).json({ success: false, error: radioValidation.error });
    }

    const success = await managerFor(req, res).setRadio(parsedFreq, parsedBw, parsedSf, parsedCr);

    if (success) {
      res.json({ success: true, message: 'Radio config updated' });
    } else {
      res.status(400).json({ success: false, error: 'Failed to update radio config' });
    }
  } catch (error) {
    logger.error('[API] Error setting radio config:', error);
    res.status(500).json({ success: false, error: 'Config error' });
  }
});

/**
 * POST /api/meshcore/config/coords
 * Set device GPS coordinates (companion only)
 * Requires authentication - modifies device configuration
 */
router.post('/config/coords', meshcoreDeviceLimiter, requireAuth(), requirePermission('configuration', 'write', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const { lat, lon } = req.body;

    if (lat === undefined || lon === undefined) {
      return res.status(400).json({ success: false, error: 'Both lat and lon are required' });
    }

    const parsedLat = parseFloat(lat);
    const parsedLon = parseFloat(lon);

    if (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLon)) {
      return res.status(400).json({ success: false, error: 'lat and lon must be valid numbers' });
    }

    if (parsedLat < -90 || parsedLat > 90) {
      return res.status(400).json({ success: false, error: 'lat must be between -90 and 90' });
    }
    if (parsedLon < -180 || parsedLon > 180) {
      return res.status(400).json({ success: false, error: 'lon must be between -180 and 180' });
    }

    const success = await managerFor(req, res).setCoords(parsedLat, parsedLon);

    if (success) {
      res.json({ success: true, message: 'Coordinates updated' });
    } else {
      res.status(400).json({ success: false, error: 'Failed to update coordinates' });
    }
  } catch (error) {
    logger.error('[API] Error setting coords:', error);
    res.status(500).json({ success: false, error: 'Config error' });
  }
});

/**
 * POST /api/meshcore/config/advert-loc-policy
 * Set advert location policy (companion only)
 * Requires authentication - modifies device configuration
 */
router.post('/config/advert-loc-policy', meshcoreDeviceLimiter, requireAuth(), requirePermission('configuration', 'write', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const { policy } = req.body;

    if (policy === undefined) {
      return res.status(400).json({ success: false, error: 'policy is required' });
    }

    const parsedPolicy = parseInt(policy, 10);

    if (parsedPolicy !== 0 && parsedPolicy !== 1) {
      return res.status(400).json({ success: false, error: 'policy must be 0 or 1' });
    }

    const success = await managerFor(req, res).setAdvertLocPolicy(parsedPolicy);

    if (success) {
      res.json({ success: true, message: 'Advert location policy updated' });
    } else {
      res.status(400).json({ success: false, error: 'Failed to update advert location policy' });
    }
  } catch (error) {
    logger.error('[API] Error setting advert loc policy:', error);
    res.status(500).json({ success: false, error: 'Config error' });
  }
});

const TELEMETRY_MODES = ['always', 'device', 'never'] as const;
type TelemetryModeReq = typeof TELEMETRY_MODES[number];

function isTelemetryMode(value: unknown): value is TelemetryModeReq {
  return typeof value === 'string' && (TELEMETRY_MODES as readonly string[]).includes(value);
}

/**
 * POST /api/meshcore/config/telemetry-mode-base
 * Set basic telemetry sharing mode (companion only).
 * Body: { mode: 'always' | 'device' | 'never' }
 */
router.post('/config/telemetry-mode-base', meshcoreDeviceLimiter, requireAuth(), requirePermission('configuration', 'write', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const { mode } = req.body;
    if (!isTelemetryMode(mode)) {
      return res.status(400).json({ success: false, error: 'mode must be always|device|never' });
    }
    const success = await managerFor(req, res).setTelemetryModeBase(mode);
    if (success) {
      res.json({ success: true, message: 'Basic telemetry mode updated' });
    } else {
      res.status(400).json({ success: false, error: 'Failed to update basic telemetry mode' });
    }
  } catch (error) {
    logger.error('[API] Error setting telemetry mode (base):', error);
    res.status(500).json({ success: false, error: 'Config error' });
  }
});

/**
 * POST /api/meshcore/config/telemetry-mode-loc
 * Set location telemetry sharing mode (companion only).
 * Body: { mode: 'always' | 'device' | 'never' }
 */
router.post('/config/telemetry-mode-loc', meshcoreDeviceLimiter, requireAuth(), requirePermission('configuration', 'write', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const { mode } = req.body;
    if (!isTelemetryMode(mode)) {
      return res.status(400).json({ success: false, error: 'mode must be always|device|never' });
    }
    const success = await managerFor(req, res).setTelemetryModeLoc(mode);
    if (success) {
      res.json({ success: true, message: 'Location telemetry mode updated' });
    } else {
      res.status(400).json({ success: false, error: 'Failed to update location telemetry mode' });
    }
  } catch (error) {
    logger.error('[API] Error setting telemetry mode (loc):', error);
    res.status(500).json({ success: false, error: 'Config error' });
  }
});

/**
 * POST /api/meshcore/config/telemetry-mode-env
 * Set environment telemetry sharing mode (companion only).
 * Body: { mode: 'always' | 'device' | 'never' }
 */
router.post('/config/telemetry-mode-env', meshcoreDeviceLimiter, requireAuth(), requirePermission('configuration', 'write', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const { mode } = req.body;
    if (!isTelemetryMode(mode)) {
      return res.status(400).json({ success: false, error: 'mode must be always|device|never' });
    }
    const success = await managerFor(req, res).setTelemetryModeEnv(mode);
    if (success) {
      res.json({ success: true, message: 'Environment telemetry mode updated' });
    } else {
      res.status(400).json({ success: false, error: 'Failed to update environment telemetry mode' });
    }
  } catch (error) {
    logger.error('[API] Error setting telemetry mode (env):', error);
    res.status(500).json({ success: false, error: 'Config error' });
  }
});

export default router;
