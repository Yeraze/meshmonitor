/**
 * MeshCore Analyzer Observer — key-management routes (#4457 Phase 1 WP4)
 *
 * Mounted at `/api/sources/:id/observer` from `sourceRoutes.ts` (`Router({
 * mergeParams: true })` so `req.params.id` is visible to `requirePermission`'s
 * `sourceIdFrom: 'params.id'`). Modeled on the `/:id/pki-dm/*` routes in
 * `sourceRoutes.ts` (same feature class: per-source encrypted key, status +
 * extract-from-manager + clear) rather than the `meshcoreRoutes` barrel,
 * because `meshcoreRouteGuard` 404s any source without a *registered*
 * manager — three of these four routes (GET/PUT/DELETE key) must work on a
 * source that has never connected or whose device is unplugged. Only the
 * device-import route legitimately needs a live manager, and it resolves one
 * itself via `sourceManagerRegistry` + `isMeshCoreManager` (never
 * `instanceof`, per CLAUDE.md).
 *
 * Phase 1 scope only: key status / import / manual paste / clear. No
 * publisher, no MQTT connection — see MESHCORE_OBSERVER_PHASE1_SPEC.md §6.3, §7.
 *
 * Secrets hygiene: no handler ever returns the private key or a minted token.
 * `ObserverKeyStatus` (from `meshcoreObserverKeyStore.ts`) is the only shape
 * returned, and it never carries `storedKid` either (fingerprinting risk).
 */
import { Router, Request, Response } from 'express';
import databaseService from '../../services/database.js';
import { requirePermission } from '../auth/authMiddleware.js';
import { logger } from '../../utils/logger.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { isMeshCoreManager } from '../sourceManagerTypes.js';
import { ok, fail } from '../utils/apiResponse.js';
import { meshcoreDeviceLimiter } from '../middleware/rateLimiters.js';
import { auditMeshcoreEvent } from './meshcoreRouteShared.js';
import { getMeshCoreObserverKeyStore } from '../services/meshcoreObserverKeyStore.js';
import { deriveObserverPublicKey, isValidObserverPrivateKey } from '../services/meshcoreObserverToken.js';
import type { Source } from '../../db/repositories/sources.js';

const router = Router({ mergeParams: true });

/** 128 lowercase/uppercase hex chars — the orlp private-key wire shape. */
const HEX_128 = /^[0-9a-fA-F]{128}$/;

/**
 * Shared preamble for every route: look up the source and reject anything
 * that isn't a `meshcore` source. Writes the error response itself and
 * returns `null` so callers can `if (!source) return;`.
 */
async function resolveMeshCoreSource(req: Request, res: Response): Promise<Source | null> {
  const source = await databaseService.sources.getSource(req.params.id);
  if (!source) {
    fail(res, 404, 'SOURCE_NOT_FOUND', 'Source not found');
    return null;
  }
  if (source.type !== 'meshcore') {
    fail(res, 400, 'INVALID_PARAMETER', 'Analyzer Observer applies to MeshCore sources only');
    return null;
  }
  return source;
}

// GET /api/sources/:id/observer/key — status only, never the key.
router.get(
  '/key',
  requirePermission('configuration', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const source = await resolveMeshCoreSource(req, res);
      if (!source) return;
      const status = await getMeshCoreObserverKeyStore().status(source.id);
      ok(res, status);
    } catch (error) {
      logger.error(`[API] Observer key status error for ${req.params.id}:`, error);
      fail(res, 500, 'INTERNAL_ERROR', 'Failed to get Analyzer Observer key status');
    }
  },
);

// POST /api/sources/:id/observer/key/import — pull the signing key from the
// connected companion. Overwrites any existing stored key silently (the
// device is authoritative — unlike POST /config/private-key this is not
// destructive to the device, so no confirm:true gate).
router.post(
  '/key/import',
  meshcoreDeviceLimiter,
  requirePermission('configuration', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const source = await resolveMeshCoreSource(req, res);
      if (!source) return;

      const store = getMeshCoreObserverKeyStore();
      if (!store.capability.canStore) {
        fail(
          res,
          400,
          'CREDENTIAL_PERSISTENCE_DISABLED',
          store.capability.reason ?? 'Cannot persist Analyzer Observer signing key',
        );
        return;
      }

      const mgr = sourceManagerRegistry.getManager(source.id);
      if (!mgr || !isMeshCoreManager(mgr)) {
        fail(res, 409, 'SOURCE_NOT_CONNECTED', 'Source is not connected to a MeshCore manager');
        return;
      }

      const hex = await mgr.exportPrivateKey();
      if (!hex) {
        // Disconnected mid-call, repeater firmware (no companion identity to
        // export), or export refused — all surface as null from the manager.
        fail(res, 409, 'EXPORT_FAILED', 'Export private key failed — source disconnected or not a Companion device');
        return;
      }
      if (!HEX_128.test(hex)) {
        // Malformed value from the device is an upstream fault, not caller error.
        fail(res, 502, 'INVALID_KEY_LENGTH', 'Device returned a malformed signing key');
        return;
      }

      let publicKey: string;
      try {
        publicKey = await deriveObserverPublicKey(hex);
      } catch {
        fail(res, 502, 'INVALID_KEY_MATERIAL', 'Device returned an invalid signing key');
        return;
      }

      await store.store(source.id, hex, publicKey, 'device');
      auditMeshcoreEvent(req, 'meshcore_observer_key_import', 'configuration', { sourceId: source.id });
      const status = await store.status(source.id);
      ok(res, status);
    } catch (error) {
      logger.error(`[API] Observer key import error for ${req.params.id}:`, error);
      fail(res, 500, 'INTERNAL_ERROR', 'Failed to import Analyzer Observer signing key');
    }
  },
);

// PUT /api/sources/:id/observer/key — manual paste. Body { privateKey }.
router.put(
  '/key',
  requirePermission('configuration', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const source = await resolveMeshCoreSource(req, res);
      if (!source) return;

      const store = getMeshCoreObserverKeyStore();
      if (!store.capability.canStore) {
        fail(
          res,
          400,
          'CREDENTIAL_PERSISTENCE_DISABLED',
          store.capability.reason ?? 'Cannot persist Analyzer Observer signing key',
        );
        return;
      }

      const raw = req.body?.privateKey;
      if (typeof raw !== 'string') {
        fail(res, 400, 'INVALID_PARAMETER_TYPE', 'privateKey must be a string');
        return;
      }

      const trimmed = raw.trim().replace(/^0x/i, '');
      if (!HEX_128.test(trimmed)) {
        // Malformed value from the user is caller error, not upstream.
        fail(res, 400, 'INVALID_KEY_LENGTH', 'privateKey must be a 128-character hex string');
        return;
      }
      if (!(await isValidObserverPrivateKey(trimmed))) {
        fail(res, 400, 'INVALID_KEY_MATERIAL', 'privateKey is not a valid Analyzer Observer signing key');
        return;
      }

      const publicKey = await deriveObserverPublicKey(trimmed);
      await store.store(source.id, trimmed, publicKey, 'manual');
      auditMeshcoreEvent(req, 'meshcore_observer_key_set', 'configuration', { sourceId: source.id });
      const status = await store.status(source.id);
      ok(res, status);
    } catch (error) {
      logger.error(`[API] Observer key set error for ${req.params.id}:`, error);
      fail(res, 500, 'INTERNAL_ERROR', 'Failed to set Analyzer Observer signing key');
    }
  },
);

// DELETE /api/sources/:id/observer/key — forget the stored key. Idempotent.
// Deliberately NOT gated on `capability.canStore`: deleting a stored (and,
// under an auto-generated SESSION_SECRET, unrecoverable) key must always be
// possible, even when persisting a new one is not.
router.delete(
  '/key',
  requirePermission('configuration', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const source = await resolveMeshCoreSource(req, res);
      if (!source) return;

      const store = getMeshCoreObserverKeyStore();
      await store.clear(source.id);
      auditMeshcoreEvent(req, 'meshcore_observer_key_clear', 'configuration', { sourceId: source.id });
      const status = await store.status(source.id);
      ok(res, status);
    } catch (error) {
      logger.error(`[API] Observer key clear error for ${req.params.id}:`, error);
      fail(res, 500, 'INTERNAL_ERROR', 'Failed to clear Analyzer Observer signing key');
    }
  },
);

export default router;
