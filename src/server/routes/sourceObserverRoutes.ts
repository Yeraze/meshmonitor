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
 * Phase 1 scope: key status / import / manual paste / clear. No publisher, no
 * MQTT connection — see MESHCORE_OBSERVER_PHASE1_SPEC.md §6.3, §7.
 *
 * Issue #4595 adds a parallel `/credentials` trio for the static-credential
 * auth mode (brokers that don't verify the signed token). Same shape, same
 * secrets rules, a separate encrypted store.
 *
 * Secrets hygiene: no handler ever returns the private key, a minted token,
 * or the broker password. `ObserverKeyStatus` / `ObserverCredentialStatus`
 * are the only shapes returned, and neither carries `storedKid` (fingerprinting
 * risk).
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
import {
  getMeshCoreObserverCredentialStore,
  OBSERVER_PASSWORD_MAX_LENGTH,
  OBSERVER_USERNAME_MAX_LENGTH,
} from '../services/meshcoreObserverCredentialStore.js';
import { deriveObserverPublicKey, isValidObserverPrivateKey } from '../services/meshcoreObserverToken.js';
import { observerConfigFromSource, type MeshCoreSourceConfig, type NormalizedObserverConfig } from '../meshcoreConfig.js';
import type { MeshCoreObserverStatus, MeshCoreObserverBrokerStatus } from '../services/meshcoreObserverStatus.js';
import type { Source } from '../../db/repositories/sources.js';

const router = Router({ mergeParams: true });

/** 128 lowercase/uppercase hex chars — the orlp private-key wire shape. */
const HEX_128 = /^[0-9a-fA-F]{128}$/;

/**
 * Hot-swap the running Analyzer Observer publisher (if any) so it re-mints
 * against the signing key that was just stored/cleared, without requiring
 * the operator to disable/re-enable the whole source (#4543). The publisher
 * only mints a token at `start()` and on its renewal timer — a key written
 * to the store after the publisher is already up (e.g. `configured: true,
 * keyStored: false` at boot) is otherwise never picked up until the source
 * itself restarts. Passes the source's own unchanged `observer` block
 * through `reconfigureObserver` purely to trigger the stop/restart; this is
 * a no-op on config, matching the hot-swap branch in `sourceRoutes.ts`'s PUT
 * handler. Best-effort: a source with no registered manager (or a manager
 * type without `reconfigureObserver`) just resolves to `false` — the key is
 * still stored either way.
 */
async function refreshObserverPublisher(source: Source): Promise<void> {
  try {
    const cfg = (source.config as Record<string, unknown> | undefined) ?? {};
    await sourceManagerRegistry.reconfigureObserver(
      source.id,
      cfg.observer as Record<string, unknown> | undefined,
    );
  } catch (error) {
    logger.warn(`Could not refresh Analyzer Observer publisher for source ${source.id}:`, error);
  }
}

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

/**
 * Re-derive the normalized, multi-broker-aware observer config from a
 * source's saved `config` blob (#5014 Phase 1). `observerConfigFromSource`'s
 * declared return type (`MeshCoreConfig['observer']`) is not yet retyped to
 * `NormalizedObserverConfig` here (that retyping is WP3, in
 * `meshcoreManager.ts`, and runs in parallel) — but the object it actually
 * constructs, when the observer is enabled and has at least one usable
 * broker, always has the richer shape (see `normalizeObserverBrokers`). This
 * cast is the one place that gap is bridged for the route layer; it never
 * imports the publisher.
 */
function resolveNormalizedObserverConfig(source: Source): NormalizedObserverConfig | undefined {
  return observerConfigFromSource(source.config as MeshCoreSourceConfig) as NormalizedObserverConfig | undefined;
}

/**
 * Validate the optional `brokerKey` accepted by the credential PUT/DELETE
 * routes (#5014 Phase 1, spec §5.3). Absent -> `{}` (legacy single-credential
 * path, byte-compatible with pre-#5014 behaviour). Present -> type/length
 * checked, then bounded against the source's currently CONFIGURED brokers —
 * this is what stops an operator (or a stale client) from accumulating
 * credentials for a broker that was removed from the config, or that was
 * never configured at all.
 */
function validateBrokerKeyParam(
  raw: unknown,
  observer: NormalizedObserverConfig | undefined,
): { brokerKey?: string; error?: { status: number; code: string; message: string } } {
  if (raw === undefined) return {};
  if (typeof raw !== 'string') {
    return { error: { status: 400, code: 'INVALID_PARAMETER_TYPE', message: 'brokerKey must be a string' } };
  }
  if (raw.length === 0 || raw.length > 255) {
    return {
      error: {
        status: 400,
        code: 'INVALID_PARAMETER',
        message: 'brokerKey must be a non-empty string of at most 255 characters',
      },
    };
  }
  const known = observer?.brokers.some((broker) => broker.key === raw) ?? false;
  if (!known) {
    return { error: { status: 400, code: 'UNKNOWN_BROKER', message: `Unknown or unconfigured broker: ${raw}` } };
  }
  return { brokerKey: raw };
}

/**
 * Build the "not running" Analyzer Observer status snapshot from a source's
 * saved config (#5014 Phase 1, spec §5.2 step 4) — used when no manager is
 * registered for the source, or a registered manager reports no running
 * publisher (`getObserverStatus()` returns `undefined`). Every counter is
 * zeroed and every broker is `configured: true, keyStored: false,
 * connected: false` so the UI gets a meaningful, config-derived answer
 * instead of a 404.
 */
function synthesizeNotRunningStatus(source: Source): MeshCoreObserverStatus {
  const observer = resolveNormalizedObserverConfig(source);
  const brokers: MeshCoreObserverBrokerStatus[] = (observer?.brokers ?? []).map((broker) => ({
    key: broker.key,
    url: broker.url,
    label: broker.label ?? null,
    authMode: broker.authMode,
    tokenAudience: broker.tokenAudience ?? null,
    configured: true,
    keyStored: false,
    connected: false,
    publishes: 0,
    dropped: 0,
    lastPublishAt: null,
    lastError: null,
    tokenExpiresAt: null,
  }));
  return {
    configured: !!observer,
    authMode: observer?.authMode ?? 'token',
    keyStored: false,
    connected: false,
    publishes: 0,
    dropped: 0,
    lastPublishAt: null,
    lastError: null,
    tokenExpiresAt: null,
    brokers,
  };
}

// GET /api/sources/:id/observer/status — running publisher status (from the
// registered manager) or a config-derived "not running" snapshot (#5014
// Phase 1, spec §5.2). Depends only on the manager's `getObserverStatus()`
// duck-type and the types-only `meshcoreObserverStatus.js` module — never
// imports the publisher, so this route can be built in parallel with WP3.
router.get(
  '/status',
  requirePermission('configuration', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const source = await resolveMeshCoreSource(req, res);
      if (!source) return;

      const mgr = sourceManagerRegistry.getManager(source.id);
      const status = mgr && isMeshCoreManager(mgr) ? mgr.getObserverStatus() : undefined;

      if (status) {
        ok(res, { running: true, ...status });
        return;
      }

      ok(res, { running: false, ...synthesizeNotRunningStatus(source) });
    } catch (error) {
      logger.error(`[API] Observer status error for ${req.params.id}:`, error);
      fail(res, 500, 'INTERNAL_ERROR', 'Failed to get Analyzer Observer status');
    }
  },
);

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
      await refreshObserverPublisher(source);
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
      await refreshObserverPublisher(source);
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
      await refreshObserverPublisher(source);
      const status = await store.status(source.id);
      ok(res, status);
    } catch (error) {
      logger.error(`[API] Observer key clear error for ${req.params.id}:`, error);
      fail(res, 500, 'INTERNAL_ERROR', 'Failed to clear Analyzer Observer signing key');
    }
  },
);

// ---------------------------------------------------------------------------
// Static MQTT credentials (#4595) — for Analyzer brokers that authenticate
// with a plain username/password instead of the Ed25519-signed token.
//
// Secrets hygiene, same contract as the key routes above: NO handler ever
// returns the password. `ObserverCredentialStatus` is the only shape returned,
// and it carries `username` (not secret, needed by the UI) plus booleans.
// ---------------------------------------------------------------------------

// GET /api/sources/:id/observer/credentials — status only, never the password.
router.get(
  '/credentials',
  requirePermission('configuration', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const source = await resolveMeshCoreSource(req, res);
      if (!source) return;
      const store = getMeshCoreObserverCredentialStore();
      const [status, brokers] = await Promise.all([store.status(source.id), store.listBrokers(source.id)]);
      // `brokers` is always present here (even `[]`), sourced from
      // `listBrokers()` directly — unlike `status()`'s own conditional
      // `brokers` field (kept omitted-when-empty there for its pre-#5014
      // `Object.keys` back-compat contract), the route response always
      // carries the array so the UI never has to special-case its absence.
      ok(res, { ...status, brokers });
    } catch (error) {
      logger.error(`[API] Observer credential status error for ${req.params.id}:`, error);
      fail(res, 500, 'INTERNAL_ERROR', 'Failed to get Analyzer Observer credential status');
    }
  },
);

// PUT /api/sources/:id/observer/credentials — body { username, password }.
router.put(
  '/credentials',
  requirePermission('configuration', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const source = await resolveMeshCoreSource(req, res);
      if (!source) return;

      const store = getMeshCoreObserverCredentialStore();
      if (!store.capability.canStore) {
        fail(
          res,
          400,
          'CREDENTIAL_PERSISTENCE_DISABLED',
          store.capability.reason ?? 'Cannot persist Analyzer Observer broker password',
        );
        return;
      }

      // Optional per-broker targeting (#5014 Phase 1). Absent -> the
      // pre-#5014 legacy single-credential path below, byte-compatible.
      const brokerKeyResult = validateBrokerKeyParam(req.body?.brokerKey, resolveNormalizedObserverConfig(source));
      if (brokerKeyResult.error) {
        fail(res, brokerKeyResult.error.status, brokerKeyResult.error.code, brokerKeyResult.error.message);
        return;
      }
      const brokerKey = brokerKeyResult.brokerKey;

      const rawUsername = req.body?.username;
      const rawPassword = req.body?.password;
      if (typeof rawUsername !== 'string' || typeof rawPassword !== 'string') {
        fail(res, 400, 'INVALID_PARAMETER_TYPE', 'username and password must be strings');
        return;
      }
      // Only the username is trimmed — a password's leading/trailing
      // whitespace is part of the secret and trimming it would silently
      // authenticate as something the operator did not type.
      const username = rawUsername.trim();
      if (!username || username.length > OBSERVER_USERNAME_MAX_LENGTH) {
        fail(
          res,
          400,
          'INVALID_PARAMETER',
          `username must be a non-empty string of at most ${OBSERVER_USERNAME_MAX_LENGTH} characters`,
        );
        return;
      }
      if (!rawPassword || rawPassword.length > OBSERVER_PASSWORD_MAX_LENGTH) {
        fail(
          res,
          400,
          'INVALID_PARAMETER',
          `password must be a non-empty string of at most ${OBSERVER_PASSWORD_MAX_LENGTH} characters`,
        );
        return;
      }

      if (brokerKey) {
        await store.storeForBroker(source.id, brokerKey, username, rawPassword);
      } else {
        await store.store(source.id, username, rawPassword);
      }
      // Audit records THAT credentials changed, never the values. `brokerKey`
      // is a URL identity, not a secret, so it is safe to include verbatim.
      auditMeshcoreEvent(req, 'meshcore_observer_credentials_set', 'configuration', {
        sourceId: source.id,
        ...(brokerKey ? { brokerKey } : {}),
      });
      await refreshObserverPublisher(source);
      const [status, brokers] = await Promise.all([store.status(source.id), store.listBrokers(source.id)]);
      ok(res, { ...status, brokers });
    } catch (error) {
      logger.error(`[API] Observer credential set error for ${req.params.id}:`, error);
      fail(res, 500, 'INTERNAL_ERROR', 'Failed to set Analyzer Observer broker credentials');
    }
  },
);

// DELETE /api/sources/:id/observer/credentials — forget them. Idempotent.
// Deliberately NOT gated on `capability.canStore`, for the same reason as the
// key DELETE above: forgetting an unrecoverable secret must always be possible.
router.delete(
  '/credentials',
  requirePermission('configuration', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const source = await resolveMeshCoreSource(req, res);
      if (!source) return;

      // Optional per-broker targeting (#5014 Phase 1). Absent -> the
      // pre-#5014 "wipe everything" path below, byte-compatible. Deliberately
      // NOT gated on `capability.canStore`, for the same reason as the
      // single-credential path: forgetting an unrecoverable secret must
      // always be possible.
      const brokerKeyResult = validateBrokerKeyParam(req.query.brokerKey, resolveNormalizedObserverConfig(source));
      if (brokerKeyResult.error) {
        fail(res, brokerKeyResult.error.status, brokerKeyResult.error.code, brokerKeyResult.error.message);
        return;
      }
      const brokerKey = brokerKeyResult.brokerKey;

      const store = getMeshCoreObserverCredentialStore();
      if (brokerKey) {
        await store.clearForBroker(source.id, brokerKey);
      } else {
        await store.clear(source.id);
      }
      auditMeshcoreEvent(req, 'meshcore_observer_credentials_clear', 'configuration', {
        sourceId: source.id,
        ...(brokerKey ? { brokerKey } : {}),
      });
      await refreshObserverPublisher(source);
      const [status, brokers] = await Promise.all([store.status(source.id), store.listBrokers(source.id)]);
      ok(res, { ...status, brokers });
    } catch (error) {
      logger.error(`[API] Observer credential clear error for ${req.params.id}:`, error);
      fail(res, 500, 'INTERNAL_ERROR', 'Failed to clear Analyzer Observer broker credentials');
    }
  },
);

export default router;
