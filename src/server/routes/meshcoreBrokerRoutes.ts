/**
 * Routes for the embedded MeshCore MQTT broker source (#6197), mounted at
 * `/api/sources/:id/meshcore-broker` (Router with `mergeParams`).
 *
 * - `GET /diagnostics`: listener state, per-connection counters, last topic
 *   and last reject reason, forwarding target state. Same per-source read as
 *   the ingest overview card (`nodes:read` on this source). Observer IP
 *   addresses and upstream URLs need the endpoint view (`sources:read`).
 * - `GET /key`, `PUT /key`, `DELETE /key`: MeshMonitor's own observer key, used
 *   by own-identity forwarding targets. Sealed in the observer key store (the
 *   same AES-GCM envelope as the Analyzer Observer key), never returned.
 *   Changing it needs `sources:write`.
 *
 * Mounted outside the `/meshcore` router on purpose: that router's guard
 * needs a running manager, and an admin must be able to set the key before
 * the broker is started.
 */
import { Router, type Request, type Response } from 'express';
import databaseService from '../../services/database.js';
import { optionalAuth, requirePermission } from '../auth/authMiddleware.js';
import { logger } from '../../utils/logger.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { isMeshCoreMqttBrokerManager } from '../sourceManagerTypes.js';
import { ok, fail } from '../utils/apiResponse.js';
import { auditMeshcoreEvent } from './meshcoreRouteShared.js';
import { getMeshCoreObserverKeyStore } from '../services/meshcoreObserverKeyStore.js';
import {
  deriveObserverPublicKey,
  generateObserverPrivateKey,
  isValidObserverPrivateKey,
} from '../services/meshcoreObserverToken.js';
import { mayViewSourceEndpoint } from '../utils/sourceConfigRedaction.js';
import { restartMeshCoreMqttBrokerManager } from '../meshcoreMqttBrokerSource.js';
import type { Source } from '../../db/repositories/sources.js';

const router = Router({ mergeParams: true });

const HEX_128 = /^[0-9a-fA-F]{128}$/;

async function resolveBrokerSource(req: Request, res: Response): Promise<Source | null> {
  const source = await databaseService.sources.getSource((req.params as { id?: string }).id ?? '');
  if (!source || source.type !== 'meshcore_mqtt_broker') {
    fail(res, 404, 'NOT_A_BROKER_SOURCE', 'Not a MeshCore MQTT broker source');
    return null;
  }
  return source;
}

/** Restart a running broker so its forwarder picks up a key change. */
async function refreshRunningBroker(source: Source): Promise<void> {
  const mgr = sourceManagerRegistry.getManager(source.id);
  if (!mgr || !isMeshCoreMqttBrokerManager(mgr)) return;
  try {
    await restartMeshCoreMqttBrokerManager(source);
  } catch (err) {
    logger.warn(`[API] Could not restart MeshCore broker ${source.id} after a key change:`, err);
  }
}

router.get(
  '/diagnostics',
  optionalAuth(),
  requirePermission('nodes', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const source = await resolveBrokerSource(req, res);
      if (!source) return;
      const mgr = sourceManagerRegistry.getManager(source.id);
      if (!mgr || !isMeshCoreMqttBrokerManager(mgr)) {
        return ok(res, { running: false });
      }
      const diag = mgr.getDiagnostics();
      if (!(await mayViewSourceEndpoint(req))) {
        diag.lastError = null;
        diag.connections = diag.connections.map((c) => ({ ...c, remoteAddress: null }));
        diag.recent = diag.recent.map((r) => ({ ...r, remoteAddress: null }));
        diag.forwarding = diag.forwarding.map((f) => ({ ...f, url: '', lastError: null }));
      }
      return ok(res, { running: true, ...diag });
    } catch (error) {
      logger.error(`[API] MeshCore broker diagnostics failed for ${req.params.id}:`, error);
      return fail(res, 500, 'BROKER_DIAGNOSTICS_FAILED', 'Failed to read broker diagnostics');
    }
  },
);

router.get('/key', requirePermission('sources', 'read'), async (req: Request, res: Response) => {
  try {
    const source = await resolveBrokerSource(req, res);
    if (!source) return;
    return ok(res, await getMeshCoreObserverKeyStore().status(source.id));
  } catch (error) {
    logger.error(`[API] MeshCore broker key status failed for ${req.params.id}:`, error);
    return fail(res, 500, 'INTERNAL_ERROR', 'Failed to read the broker observer key status');
  }
});

router.put('/key', requirePermission('sources', 'write'), async (req: Request, res: Response) => {
  try {
    const source = await resolveBrokerSource(req, res);
    if (!source) return;
    const store = getMeshCoreObserverKeyStore();
    if (!store.capability.canStore) {
      return fail(res, 400, 'CREDENTIAL_PERSISTENCE_DISABLED', store.capability.reason ?? 'Cannot persist the key');
    }

    let privateKey: string;
    if (req.body?.generate === true) {
      privateKey = generateObserverPrivateKey();
    } else {
      const raw = req.body?.privateKey;
      if (typeof raw !== 'string') {
        return fail(res, 400, 'INVALID_PARAMETER_TYPE', 'Send privateKey (128 hex characters) or generate: true');
      }
      privateKey = raw.trim().replace(/^0x/i, '');
      if (!HEX_128.test(privateKey)) {
        return fail(res, 400, 'INVALID_KEY_LENGTH', 'privateKey must be a 128-character hex string');
      }
    }
    if (!(await isValidObserverPrivateKey(privateKey))) {
      return fail(res, 400, 'INVALID_KEY_MATERIAL', 'privateKey is not a valid observer signing key');
    }
    const publicKey = await deriveObserverPublicKey(privateKey);
    await store.store(source.id, privateKey, publicKey, 'manual');
    auditMeshcoreEvent(req, 'meshcore_broker_key_set', 'configuration', { sourceId: source.id });
    await refreshRunningBroker(source);
    return ok(res, await store.status(source.id));
  } catch (error) {
    logger.error(`[API] MeshCore broker key set failed for ${req.params.id}:`, error);
    return fail(res, 500, 'INTERNAL_ERROR', 'Failed to store the broker observer key');
  }
});

router.delete('/key', requirePermission('sources', 'write'), async (req: Request, res: Response) => {
  try {
    const source = await resolveBrokerSource(req, res);
    if (!source) return;
    const store = getMeshCoreObserverKeyStore();
    await store.clear(source.id);
    auditMeshcoreEvent(req, 'meshcore_broker_key_clear', 'configuration', { sourceId: source.id });
    await refreshRunningBroker(source);
    return ok(res, await store.status(source.id));
  } catch (error) {
    logger.error(`[API] MeshCore broker key clear failed for ${req.params.id}:`, error);
    return fail(res, 500, 'INTERNAL_ERROR', 'Failed to clear the broker observer key');
  }
});

export default router;
