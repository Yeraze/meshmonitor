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
import { requireAuth, requirePermission, hasPermission } from '../auth/authMiddleware.js';
import { ok, fail } from '../utils/apiResponse.js';
import { ChannelReorderPlanError } from '../meshcoreChannelReorder.js';
import type { ResourceType } from '../../types/permission.js';
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
 * GET /api/sources/:id/meshcore/config/default-path-hash-size
 * The per-source default MeshCore path hash size (#4945): 1, 2, or 3 bytes.
 */
router.get(
  '/config/default-path-hash-size',
  requireAuth(),
  requirePermission('configuration', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const size = await managerFor(req, res).getDefaultPathHashSize();
      res.json({ success: true, size });
    } catch (error) {
      logger.error('[API] Error reading default path hash size:', error);
      res.status(500).json({ success: false, error: 'Failed to read setting' });
    }
  },
);

/**
 * Per-source MeshCore default path hash size (#4945) — 1/2/3 bytes. Persists the
 * setting and pushes it to the companion firmware's NodePrefs so it applies at
 * once (and re-asserts on every reconnect).
 */
router.post(
  '/config/default-path-hash-size',
  meshcoreDeviceLimiter,
  requireAuth(),
  requirePermission('configuration', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const size = Number(req.body?.size);
      if (![1, 2, 3].includes(size)) {
        return res.status(400).json({ success: false, error: 'size must be 1, 2, or 3' });
      }
      const applied = await managerFor(req, res).setDefaultPathHashSize(size);
      auditMeshcoreEvent(req, 'meshcore_set_path_hash_size', 'configuration', { size: applied });
      res.json({ success: true, size: applied });
    } catch (error) {
      logger.error('[API] Error setting default path hash size:', error);
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

/**
 * POST /api/sources/:id/meshcore/config/auto-add-contacts
 * Body: { enabled: boolean }
 *
 * Turn the companion's auto-add on or off (#5502): bit 0 of
 * NodePrefs.manual_add_contacts. Read-modify-write, so the per-type bits and
 * the telemetry / advert-location fields sharing SetOtherParams are kept.
 * Local serial write, no RF.
 */
router.post('/config/auto-add-contacts', meshcoreDeviceLimiter, requireAuth(), requirePermission('configuration', 'write', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const enabled = (req.body as { enabled?: unknown } | undefined)?.enabled;
    if (typeof enabled !== 'boolean') {
      return fail(res, 400, 'INVALID_ENABLED', 'enabled must be true or false');
    }
    const result = await managerFor(req, res).setAutoAddContacts(enabled);
    if (!result.ok) {
      return fail(res, 502, 'AUTO_ADD_UPDATE_FAILED', result.error);
    }
    auditMeshcoreEvent(req, 'meshcore_auto_add_contacts', 'configuration', {
      sourceId: req.params.id,
      enabled,
      manualAddContacts: result.manualAddContacts,
    });
    return ok(res, { autoAddEnabled: result.autoAddEnabled, manualAddContacts: result.manualAddContacts });
  } catch (error) {
    logger.error('[API] Error setting auto-add contacts:', error);
    return fail(res, 500, 'AUTO_ADD_UPDATE_FAILED', 'Config error');
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

/** HTTP status for each pre-write channel reorder refusal (#5379). */
const CHANNEL_REORDER_STATUS: Record<ChannelReorderPlanError['code'], number> = {
  ORDER_INVALID: 400,
  NOT_COMPANION: 400,
  ORDER_MISMATCH: 409,
  NO_FREE_SLOT: 409,
  REORDER_IN_PROGRESS: 409,
  NOT_CONNECTED: 503,
  TABLE_READ_FAILED: 502,
  PLAN_DID_NOT_CONVERGE: 500,
};

/**
 * POST /api/sources/:id/meshcore/channels/reorder
 *
 * Rewrite the companion's channel slots into a new order (#5379). Body:
 * `{ order: number[] }`, the CURRENT slot of every configured channel in
 * slots 1+, in the wanted order. Channels land in slots 1..n; slot 0 (Public)
 * never moves. Message history, read markers, channel permissions, scopes and
 * the MeshCore auto-ack / auto-announce / auto-responder / timer settings
 * follow their channel.
 *
 * Responses:
 *  - 200 `{ success, data: { status: 'applied' | 'unchanged', ... } }`
 *  - 502 CHANNEL_REORDER_ROLLED_BACK: a write failed; the original layout was
 *    written back and confirmed. `result` has the details.
 *  - 500 CHANNEL_REORDER_INCONSISTENT: the rollback could not be confirmed.
 *    `result.deviceSlots` is the best view of the device.
 *  - 4xx/5xx with a plan code (ORDER_MISMATCH, NO_FREE_SLOT, ...) when it
 *    refused before writing anything.
 *
 * Serial-link config only: no packet goes over the air, so receive-only mode
 * does not block it.
 */
router.post(
  '/channels/reorder',
  meshcoreDeviceLimiter,
  requireAuth(),
  requirePermission('configuration', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    const sourceId = (req.params as { id: string }).id;
    const order: unknown = req.body?.order;
    if (!Array.isArray(order) || order.length === 0 || order.length > 255
      || !order.every((n: unknown) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 255)) {
      return fail(res, 400, 'ORDER_INVALID', 'order must be a non-empty array of channel slot indexes (1-255)');
    }
    const slots = order as number[];

    // MM-SEC-4, same rule as the Meshtastic reorder: rewriting a slot needs
    // write on that slot's channel. Only slots 1-7 have a channel_N resource;
    // 8+ are governed by configuration:write, checked above.
    if (!req.user?.isAdmin) {
      const affected = new Set<number>();
      slots.forEach((fromSlot, k) => {
        if (fromSlot !== k + 1) {
          affected.add(fromSlot);
          affected.add(k + 1);
        }
      });
      for (const slot of [...affected].sort((a, b) => a - b)) {
        if (slot > 7) continue;
        const resource = `channel_${slot}` as ResourceType;
        if (!(req.user && await hasPermission(req.user, resource, 'write', sourceId))) {
          return fail(res, 403, 'FORBIDDEN',
            `Reordering needs write permission on every channel it moves (missing: ${resource})`,
            { required: { resource, action: 'write' } });
        }
      }
    }

    const manager = managerFor(req, res);
    try {
      const result = await manager.reorderChannels(slots);
      auditMeshcoreEvent(req, 'meshcore_channels_reorder', 'configuration', {
        sourceId,
        order: slots,
        status: result.status,
        ...(result.status === 'applied'
          ? {
            moves: result.moves,
            writes: result.writes,
            remap: {
              messages: result.remap.messages,
              channels: result.remap.channels,
              readMarkers: result.remap.readMarkers,
              permissionsMoved: result.remap.permissionsMoved,
              permissionsDropped: result.remap.permissionsDropped,
              settingsUpdated: result.remap.settingsUpdated,
            },
          }
          : {}),
        ...(result.status === 'rolled_back' ? { error: result.error } : {}),
        ...(result.status === 'inconsistent' ? { error: result.error, rollbackError: result.rollbackError } : {}),
      });
      if (result.status === 'rolled_back') {
        return fail(res, 502, 'CHANNEL_REORDER_ROLLED_BACK',
          `Channel reorder failed and was undone; the device is back in its original order. ${result.error}`,
          { result });
      }
      if (result.status === 'inconsistent') {
        return fail(res, 500, 'CHANNEL_REORDER_INCONSISTENT',
          `Channel reorder failed and the undo could not be confirmed (${result.rollbackError}). ` +
          'No channel was removed, but one may be in the wrong slot or listed twice.',
          { result });
      }
      return ok(res, result);
    } catch (error) {
      if (error instanceof ChannelReorderPlanError) {
        auditMeshcoreEvent(req, 'meshcore_channels_reorder', 'configuration', {
          sourceId, order: slots, status: 'refused', code: error.code,
        });
        return fail(res, CHANNEL_REORDER_STATUS[error.code] ?? 400, error.code, error.message);
      }
      logger.error('[API] Error reordering MeshCore channels:', error);
      return fail(res, 500, 'INTERNAL_ERROR', 'Channel reorder failed');
    }
  },
);

export default router;
