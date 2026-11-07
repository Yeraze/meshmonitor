/**
 * MeshCore API Routes — automation group
 *
 * Auto-pathfinding (+ target filter), auto-acknowledge, auto-announce
 * (+ preview/manual-send), timer triggers (+ manual run), and auto-
 * responder. Extracted verbatim from the former monolithic
 * `meshcoreRoutes.ts` (epic #3962 Task 4.3). The only group that uses the
 * `ok`/`fail` envelope helper (the 11 existing calls all live here).
 */

import { Router, Request, Response } from 'express';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { requireAuth, optionalAuth, requirePermission } from '../auth/authMiddleware.js';
import { validateAutoAckRegex } from '../utils/autoAckRegex.js';
import { validateResponderTrigger } from '../utils/autoResponderMatcher.js';
import { isResponderSyntax, resolveResponderSyntax } from '../../utils/responderTrigger.js';
import { meshcoreDeviceLimiter } from '../middleware/rateLimiters.js';
import { resolveAutoAckPreSendDelaySeconds } from '../autoAckDelay.js';
import { compileUserRegex } from '../../utils/safeRegex.js';
import { ok, fail } from '../utils/apiResponse.js';
import { parseAutoPingSettingsUpdate, readAutoPingSettings } from '../utils/autoPingSettings.js';
import { autoDeleteByDistanceService } from '../services/autoDeleteByDistanceService.js';
import { MESHCORE_ADVERT_MODES, isMeshCoreAdvertMode, resolveMeshCoreAdvertMode } from '../../types/meshcoreAdvert.js';
import type { MeshcorePathfindingFilterSettings } from '../../services/database.js';
import { managerFor, requireMeshcoreTx, failIfTxDisabled } from './meshcoreRouteShared.js';
import { extendRequestTimeout } from '../middleware/requestTimeout.js';
import { keepServerRunState, parseStoredTriggers } from '../utils/timerRunState.js';

// Manual announce-send / timer-run routes trigger a radio send + wait that
// can legitimately run past the 30s default socket timeout; extend it so
// the caller gets the real result instead of a dropped-socket 504.
/** Manual announce send / timer run: broadcast + multi-hop settle window. */
const MANUAL_AUTOMATION_RUN_TIMEOUT_MS = 120_000;

const router = Router({ mergeParams: true });

// ============ Auto-Pathfinding Automation ============

router.get(
  '/automation/pathfinding',
  optionalAuth(),
  requirePermission('automation', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const mgr = managerFor(req, res);
      const sourceId = (req.params as { id?: string }).id!;
      const status = mgr.getAutoPathfindingStatus();

      const enabled = await databaseService.settings.getSettingForSource(sourceId, 'meshcoreAutoPathfindingEnabled');
      const pathDiscoveryEnabled = await databaseService.settings.getSettingForSource(sourceId, 'meshcoreAutoPathfindingPathDiscoveryEnabled');
      const neighborsEnabled = await databaseService.settings.getSettingForSource(sourceId, 'meshcoreAutoPathfindingNeighborsEnabled');
      const intervalMinutes = await databaseService.settings.getSettingForSource(sourceId, 'meshcoreAutoPathfindingIntervalMinutes');
      const repeatHours = await databaseService.settings.getSettingForSource(sourceId, 'meshcoreAutoPathfindingRepeatHours');

      res.json({
        success: true,
        data: {
          enabled: enabled === 'true',
          pathDiscoveryEnabled: pathDiscoveryEnabled === 'true',
          neighborsEnabled: neighborsEnabled === 'true',
          intervalMinutes: parseInt(intervalMinutes || '5', 10) || 5,
          repeatHours: parseInt(repeatHours || '24', 10) || 24,
          schedulerRunning: status.enabled,
          lastRunAt: status.lastRunAt || null,
        },
      });
    } catch (error) {
      logger.error('[API] Error reading auto-pathfinding settings:', error);
      res.status(500).json({ success: false, error: 'Failed to read auto-pathfinding settings' });
    }
  },
);

router.post(
  '/automation/pathfinding',
  requireAuth(),
  requirePermission('automation', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const mgr = managerFor(req, res);
      const sourceId = (req.params as { id?: string }).id!;
      const {
        enabled,
        pathDiscoveryEnabled,
        neighborsEnabled,
        intervalMinutes,
        repeatHours,
      } = req.body as {
        enabled?: boolean;
        pathDiscoveryEnabled?: boolean;
        neighborsEnabled?: boolean;
        intervalMinutes?: number;
        repeatHours?: number;
      };

      if (enabled !== undefined) {
        await databaseService.settings.setSourceSetting(sourceId, 'meshcoreAutoPathfindingEnabled', String(enabled));
      }
      if (pathDiscoveryEnabled !== undefined) {
        await databaseService.settings.setSourceSetting(sourceId, 'meshcoreAutoPathfindingPathDiscoveryEnabled', String(pathDiscoveryEnabled));
      }
      if (neighborsEnabled !== undefined) {
        await databaseService.settings.setSourceSetting(sourceId, 'meshcoreAutoPathfindingNeighborsEnabled', String(neighborsEnabled));
      }
      if (intervalMinutes !== undefined) {
        const clamped = Math.max(3, Math.min(60, intervalMinutes));
        await databaseService.settings.setSourceSetting(sourceId, 'meshcoreAutoPathfindingIntervalMinutes', String(clamped));
      }
      if (repeatHours !== undefined) {
        const clamped = Math.max(1, Math.min(168, repeatHours));
        await databaseService.settings.setSourceSetting(sourceId, 'meshcoreAutoPathfindingRepeatHours', String(clamped));
      }

      await mgr.startAutoPathfinding();

      const status = mgr.getAutoPathfindingStatus();
      res.json({
        success: true,
        data: {
          schedulerRunning: status.enabled,
          lastRunAt: status.lastRunAt || null,
        },
      });
    } catch (error) {
      logger.error('[API] Error saving auto-pathfinding settings:', error);
      res.status(500).json({ success: false, error: 'Failed to save auto-pathfinding settings' });
    }
  },
);

// ============ Auto Ping (#5953) ============
//
// `ping N` DM sessions, Companion sources only. Same per-source keys and
// ranges as the Meshtastic `/api/settings/auto-ping` route
// (utils/autoPingSettings.ts). Saving writes settings only: it never starts,
// restarts or re-arms a session; sessions start from a received DM.

router.get(
  '/automation/auto-ping',
  optionalAuth(),
  requirePermission('automation', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const mgr = managerFor(req, res);
      const sourceId = (req.params as { id?: string }).id!;
      const settings = await readAutoPingSettings((key) => databaseService.settings.getSettingForSource(sourceId, key));
      ok(res, { settings, sessions: mgr.getAutoPingSessions() });
    } catch (error) {
      logger.error('[API] Error reading meshcore auto-ping settings:', error);
      fail(res, 500, 'INTERNAL_ERROR', 'Failed to read auto-ping settings');
    }
  },
);

router.post(
  '/automation/auto-ping',
  requireAuth(),
  requirePermission('automation', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id?: string }).id!;
      const parsed = parseAutoPingSettingsUpdate(req.body);
      if (!parsed.ok) {
        return fail(res, 400, parsed.code, parsed.message);
      }
      for (const [key, value] of parsed.updates) {
        await databaseService.settings.setSourceSetting(sourceId, key, value);
      }
      const settings = await readAutoPingSettings((key) => databaseService.settings.getSettingForSource(sourceId, key));
      ok(res, { settings });
    } catch (error) {
      logger.error('[API] Error saving meshcore auto-ping settings:', error);
      fail(res, 500, 'INTERNAL_ERROR', 'Failed to save auto-ping settings');
    }
  },
);

router.post(
  '/automation/auto-ping/stop',
  requireAuth(),
  requirePermission('automation', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const publicKey = (req.body as { publicKey?: unknown } | undefined)?.publicKey;
      if (typeof publicKey !== 'string' || !publicKey) {
        return fail(res, 400, 'INVALID_PUBLIC_KEY', 'publicKey is required');
      }
      const stopped = managerFor(req, res).stopAutoPingSession(publicKey);
      if (!stopped) {
        return fail(res, 404, 'NOT_FOUND', 'No active ping session for that node');
      }
      ok(res);
    } catch (error) {
      logger.error('[API] Error stopping meshcore auto-ping session:', error);
      fail(res, 500, 'INTERNAL_ERROR', 'Failed to stop auto-ping session');
    }
  },
);

// ============ Auto Delete by Distance (#6224) ============
//
// MeshCore parity with the Meshtastic auto-delete-by-distance automation. The
// per-source `DistanceDeleteScheduler` + shared `autoDeleteByDistanceService`
// already run for MeshCore sources (issue #3901); this only surfaces the same
// per-source settings in the MeshCore Automation tab. Saving re-arms the
// scheduler (mgr.restartDistanceDeleteScheduler) so a new interval / home /
// threshold takes effect immediately. The settings are LOCAL only — purging a
// node never transmits, so there is no mesh airtime here.

/** Ceiling on the distance threshold the UI can store, in km. */
const DISTANCE_DELETE_MAX_KM = 50_000;
/** Interval bounds (hours), matching the Meshtastic UI's 6–48 range. */
const DISTANCE_DELETE_MIN_HOURS = 6;
const DISTANCE_DELETE_MAX_HOURS = 48;

interface DistanceDeleteSettings {
  enabled: boolean;
  intervalHours: number;
  thresholdKm: number;
  lat: number | null;
  lon: number | null;
  action: 'delete' | 'ignore';
}

async function readDistanceDeleteSettings(sourceId: string): Promise<DistanceDeleteSettings> {
  const get = (key: string) => databaseService.settings.getSettingForSource(sourceId, key);
  const [enabled, intervalHours, thresholdKm, lat, lon, action] = await Promise.all([
    get('autoDeleteByDistanceEnabled'),
    get('autoDeleteByDistanceIntervalHours'),
    get('autoDeleteByDistanceThresholdKm'),
    get('autoDeleteByDistanceLat'),
    get('autoDeleteByDistanceLon'),
    get('autoDeleteByDistanceAction'),
  ]);
  const num = (v: string | null, fallback: number) => {
    const n = v == null || v === '' ? NaN : Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const coord = (v: string | null): number | null => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    enabled: enabled === 'true',
    intervalHours: num(intervalHours, 24),
    thresholdKm: num(thresholdKm, 100),
    lat: coord(lat),
    lon: coord(lon),
    action: action === 'ignore' ? 'ignore' : 'delete',
  };
}

type ParsedResult =
  | { ok: true; updates: Array<[string, string]> }
  | { ok: false; code: string; message: string };

function parseDistanceDeleteUpdate(body: unknown): ParsedResult {
  if (!body || typeof body !== 'object') {
    return { ok: false, code: 'INVALID_BODY', message: 'Request body must be an object' };
  }
  const b = body as Record<string, unknown>;
  const updates: Array<[string, string]> = [];

  if ('enabled' in b) {
    if (typeof b.enabled !== 'boolean') return { ok: false, code: 'INVALID_ENABLED', message: 'enabled must be a boolean' };
    updates.push(['autoDeleteByDistanceEnabled', b.enabled ? 'true' : 'false']);
  }
  if ('intervalHours' in b) {
    const n = Number(b.intervalHours);
    if (!Number.isFinite(n) || n < DISTANCE_DELETE_MIN_HOURS || n > DISTANCE_DELETE_MAX_HOURS) {
      return { ok: false, code: 'INVALID_INTERVAL', message: `intervalHours must be ${DISTANCE_DELETE_MIN_HOURS}–${DISTANCE_DELETE_MAX_HOURS}` };
    }
    updates.push(['autoDeleteByDistanceIntervalHours', String(Math.round(n))]);
  }
  if ('thresholdKm' in b) {
    const n = Number(b.thresholdKm);
    if (!Number.isFinite(n) || n <= 0 || n > DISTANCE_DELETE_MAX_KM) {
      return { ok: false, code: 'INVALID_THRESHOLD', message: `thresholdKm must be between 0 and ${DISTANCE_DELETE_MAX_KM}` };
    }
    updates.push(['autoDeleteByDistanceThresholdKm', String(n)]);
  }
  if ('lat' in b) {
    if (b.lat === null || b.lat === '') {
      updates.push(['autoDeleteByDistanceLat', '']);
    } else {
      const n = Number(b.lat);
      if (!Number.isFinite(n) || n < -90 || n > 90) return { ok: false, code: 'INVALID_LAT', message: 'lat must be -90..90 or null' };
      updates.push(['autoDeleteByDistanceLat', String(n)]);
    }
  }
  if ('lon' in b) {
    if (b.lon === null || b.lon === '') {
      updates.push(['autoDeleteByDistanceLon', '']);
    } else {
      const n = Number(b.lon);
      if (!Number.isFinite(n) || n < -180 || n > 180) return { ok: false, code: 'INVALID_LON', message: 'lon must be -180..180 or null' };
      updates.push(['autoDeleteByDistanceLon', String(n)]);
    }
  }
  if ('action' in b) {
    if (b.action !== 'delete' && b.action !== 'ignore') return { ok: false, code: 'INVALID_ACTION', message: "action must be 'delete' or 'ignore'" };
    updates.push(['autoDeleteByDistanceAction', b.action]);
  }
  return { ok: true, updates };
}

router.get(
  '/automation/auto-delete-distance',
  optionalAuth(),
  requirePermission('automation', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id?: string }).id!;
      const mgr = managerFor(req, res);
      const settings = await readDistanceDeleteSettings(sourceId);
      ok(res, { settings, running: mgr.isDistanceDeleteRunning() });
    } catch (error) {
      logger.error('[API] Error reading meshcore auto-delete-by-distance settings:', error);
      fail(res, 500, 'INTERNAL_ERROR', 'Failed to read auto-delete-by-distance settings');
    }
  },
);

router.post(
  '/automation/auto-delete-distance',
  requireAuth(),
  requirePermission('automation', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id?: string }).id!;
      const parsed = parseDistanceDeleteUpdate(req.body);
      if (!parsed.ok) return fail(res, 400, parsed.code, parsed.message);
      for (const [key, value] of parsed.updates) {
        await databaseService.settings.setSourceSetting(sourceId, key, value);
      }
      // Re-arm the per-source scheduler so a new interval/home/threshold applies
      // now rather than after a restart (#3900 cache + #6224).
      await managerFor(req, res).restartDistanceDeleteScheduler();
      const settings = await readDistanceDeleteSettings(sourceId);
      ok(res, { settings });
    } catch (error) {
      logger.error('[API] Error saving meshcore auto-delete-by-distance settings:', error);
      fail(res, 500, 'INTERNAL_ERROR', 'Failed to save auto-delete-by-distance settings');
    }
  },
);

router.post(
  '/automation/auto-delete-distance/run',
  requireAuth(),
  requirePermission('automation', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id?: string }).id!;
      // Scope the run to this source; purges only its own out-of-range nodes.
      managerFor(req, res); // 404s if the source is not a connected MeshCore manager
      const { deletedCount } = await autoDeleteByDistanceService.runNow(sourceId);
      ok(res, { deletedCount });
    } catch (error) {
      logger.error('[API] Error running meshcore auto-delete-by-distance:', error);
      fail(res, 500, 'INTERNAL_ERROR', 'Failed to run auto-delete-by-distance');
    }
  },
);

// ============ Time Sync overview (#6224) ============
//
// Central read of the per-node time-sync config (#4916) for the Automation
// tab. MeshCore time-sync is per-node (timeSyncEnabled / interval live on each
// meshcore_node), unlike Meshtastic's single source-level toggle, so this is a
// management OVERVIEW of the nodes that have it enabled; per-node changes go to
// the existing /nodes/:publicKey/time-sync-config route. Read-only here — it
// starts no sync and puts nothing on the air.

router.get(
  '/automation/time-sync',
  optionalAuth(),
  requirePermission('automation', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id?: string }).id!;
      managerFor(req, res); // 404 unless a connected MeshCore source
      const nodes = await databaseService.meshcore.getTimeSyncEnabledNodes(sourceId);
      ok(res, {
        nodes: nodes.map((n) => ({
          publicKey: n.publicKey,
          name: n.name ?? null,
          intervalMinutes: n.timeSyncIntervalMinutes ?? null,
          lastSyncAt: n.lastTimeSyncAt ?? null,
        })),
      });
    } catch (error) {
      logger.error('[API] Error reading meshcore time-sync overview:', error);
      fail(res, 500, 'INTERNAL_ERROR', 'Failed to read time-sync overview');
    }
  },
);

// ============ Auto-Pathfinding Target Filter (#4024) ============
//
// Filter config for Auto-Pathfinding contact selection: AND pre-filters
// (last-heard/hops/signal) narrow the pool, then OR-union identity filters
// (allowlist/name-regex) select within it. See
// docs/internal/dev-notes/PATHFINDING_FILTER_SPEC.md §0/§2.7/§3.
//
// Deliberately a SEPARATE endpoint from POST /automation/pathfinding above:
// that handler calls mgr.startAutoPathfinding() to rebuild the scheduler
// closure, but the filter config does not require a scheduler restart —
// executeRun() reads it fresh on every tick (§3.2). Saving the filter here
// must NOT call startAutoPathfinding().

/** MeshCore public keys are hex strings; allow any length firmware might use up to the full 64-char (32-byte) key. */
const PATHFINDING_TARGET_KEY_PATTERN = /^[0-9a-fA-F]{2,64}$/;

router.get(
  '/automation/pathfinding/filter',
  optionalAuth(),
  requirePermission('automation', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id?: string }).id!;
      const settings = await databaseService.getMeshcorePathfindingFilterSettingsAsync(sourceId);
      ok(res, settings);
    } catch (error) {
      logger.error('[API] Error reading auto-pathfinding filter settings:', error);
      fail(res, 500, 'PATHFINDING_FILTER_READ_FAILED', 'Failed to read pathfinding filter');
    }
  },
);

router.post(
  '/automation/pathfinding/filter',
  requireAuth(),
  requirePermission('automation', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id?: string }).id!;
      const body = (req.body ?? {}) as Record<string, unknown>;

      // ---- boolean fields ----
      const booleanFieldNames = [
        'enabled', 'contactsEnabled', 'regexEnabled', 'lastHeardEnabled', 'hopsEnabled', 'signalEnabled',
      ] as const;
      for (const field of booleanFieldNames) {
        if (body[field] !== undefined && typeof body[field] !== 'boolean') {
          return fail(res, 400, 'PATHFINDING_FILTER_INVALID', `${field} must be a boolean`);
        }
      }

      // ---- targetKeys allowlist ----
      let targetKeys: string[] = [];
      if (body.targetKeys !== undefined) {
        const raw = body.targetKeys;
        const valid =
          Array.isArray(raw) &&
          raw.every((k): k is string => typeof k === 'string' && PATHFINDING_TARGET_KEY_PATTERN.test(k));
        if (!valid) {
          return fail(res, 400, 'PATHFINDING_FILTER_INVALID', 'targetKeys must be an array of hex-string public keys');
        }
        targetKeys = raw as string[];
      }

      // ---- nameRegex: type + RE2-safe compile check ----
      if (body.nameRegex !== undefined) {
        if (typeof body.nameRegex !== 'string') {
          return fail(res, 400, 'PATHFINDING_FILTER_INVALID', 'nameRegex must be a string');
        }
        if (body.nameRegex.length > 512) {
          return fail(res, 400, 'PATHFINDING_FILTER_INVALID', 'nameRegex too long (max 512 characters)');
        }
        try {
          compileUserRegex(body.nameRegex, 'i');
        } catch {
          return fail(res, 400, 'PATHFINDING_FILTER_BAD_REGEX', 'Invalid name filter regex');
        }
      }

      // ---- integer range fields ----
      const intFieldBounds: Array<{ key: string; min: number; max: number }> = [
        { key: 'lastHeardHours', min: 1, max: 8760 },
        { key: 'hopsMin', min: 0, max: 10 },
        { key: 'hopsMax', min: 0, max: 10 },
        { key: 'rssiMin', min: -200, max: 0 },
        { key: 'snrMin', min: -100, max: 100 },
      ];
      for (const { key, min, max } of intFieldBounds) {
        const value = body[key];
        if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)) {
          return fail(res, 400, 'PATHFINDING_FILTER_INVALID', `${key} must be an integer between ${min} and ${max}`);
        }
      }
      if (
        typeof body.hopsMin === 'number' &&
        typeof body.hopsMax === 'number' &&
        body.hopsMax < body.hopsMin
      ) {
        return fail(res, 400, 'PATHFINDING_FILTER_INVALID', 'hopsMax must be >= hopsMin');
      }

      const validated: Partial<MeshcorePathfindingFilterSettings> & { targetKeys: string[] } = { targetKeys };
      if (typeof body.enabled === 'boolean') validated.enabled = body.enabled;
      if (typeof body.contactsEnabled === 'boolean') validated.contactsEnabled = body.contactsEnabled;
      if (typeof body.regexEnabled === 'boolean') validated.regexEnabled = body.regexEnabled;
      if (typeof body.nameRegex === 'string') validated.nameRegex = body.nameRegex;
      if (typeof body.lastHeardEnabled === 'boolean') validated.lastHeardEnabled = body.lastHeardEnabled;
      if (typeof body.lastHeardHours === 'number') validated.lastHeardHours = body.lastHeardHours;
      if (typeof body.hopsEnabled === 'boolean') validated.hopsEnabled = body.hopsEnabled;
      if (typeof body.hopsMin === 'number') validated.hopsMin = body.hopsMin;
      if (typeof body.hopsMax === 'number') validated.hopsMax = body.hopsMax;
      if (typeof body.signalEnabled === 'boolean') validated.signalEnabled = body.signalEnabled;
      if (typeof body.rssiMin === 'number') validated.rssiMin = body.rssiMin;
      if (typeof body.snrMin === 'number') validated.snrMin = body.snrMin;

      // Filter is read fresh every executeRun() tick — do NOT call
      // mgr.startAutoPathfinding() here (see block comment above).
      await databaseService.setMeshcorePathfindingFilterSettingsAsync(sourceId, validated);

      const persisted = await databaseService.getMeshcorePathfindingFilterSettingsAsync(sourceId);
      ok(res, persisted);
    } catch (error) {
      logger.error('[API] Error saving auto-pathfinding filter settings:', error);
      fail(res, 500, 'PATHFINDING_FILTER_SAVE_FAILED', 'Failed to save pathfinding filter');
    }
  },
);

// ============ Auto-Acknowledge Automation ============
//
// Per-source settings store for MeshCore auto-acknowledge. The trigger
// fires from the manager's incoming-message handler (handleBridgeEvent),
// so this endpoint is just a CRUD wrapper — no scheduler.

router.get(
  '/automation/autoack',
  optionalAuth(),
  requirePermission('automation', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id?: string }).id!;
      const settings = databaseService.settings;

      const enabled = await settings.getSettingForSource(sourceId, 'meshcoreAutoAckEnabled');
      const regex = await settings.getSettingForSource(sourceId, 'meshcoreAutoAckRegex');
      const message = await settings.getSettingForSource(sourceId, 'meshcoreAutoAckMessage');
      const channels = await settings.getSettingForSource(sourceId, 'meshcoreAutoAckChannels');
      const directMessages = await settings.getSettingForSource(sourceId, 'meshcoreAutoAckDirectMessages');
      const useDM = await settings.getSettingForSource(sourceId, 'meshcoreAutoAckUseDM');
      const cooldownSeconds = await settings.getSettingForSource(sourceId, 'meshcoreAutoAckCooldownSeconds');
      const preSendDelaySeconds = await settings.getSettingForSource(sourceId, 'meshcoreAutoAckPreSendDelaySeconds');
      const testMessages = await settings.getSettingForSource(sourceId, 'meshcoreAutoAckTestMessages');
      const ignoredNodes = await settings.getSettingForSource(sourceId, 'meshcoreAutoAckIgnoredNodes');
      const splitLongMessages = await settings.getSettingForSource(sourceId, 'meshcoreAutoAckSplitLongMessages');
      const scopeMode = await settings.getSettingForSource(sourceId, 'meshcoreAutoAckScopeMode');
      const scopeName = await settings.getSettingForSource(sourceId, 'meshcoreAutoAckScopeName');

      ok(res, {
        enabled: enabled === 'true',
        regex: regex || '^(test|ping)',
        message: message || '🤖 Copy, {NODE_NAME}! {HOPS} hops @ {TIME}',
        channels: (channels || '')
          .split(',')
          .map(s => s.trim())
          .filter(Boolean)
          .map(s => parseInt(s, 10))
          .filter(n => Number.isFinite(n)),
        directMessages: directMessages === 'true',
        useDM: useDM === 'true',
        cooldownSeconds: parseInt(cooldownSeconds || '0', 10) || 0,
        // Defense-in-depth: clamp on read too (default 0, cap 120s) so a
        // value written directly to the DB can't escape the UI's bounds.
        preSendDelaySeconds: resolveAutoAckPreSendDelaySeconds(preSendDelaySeconds),
        testMessages: testMessages || 'test\nTest message\nping\nPING\nHello world\nTESTING 123',
        // Per-sender ignore list (#4391): key prefixes and/or contact names.
        ignoredNodes: ignoredNodes || '',
        // Split a long reply into up to 3 sends (#5564). Off unless the
        // stored value is exactly 'true', so an unset key reads as off.
        splitLongMessages: splitLongMessages === 'true',
        // MeshCore scope/region for the ack reply (#3833).
        scopeMode: (scopeMode as 'inherit' | 'trigger' | 'unscoped' | 'named') || 'inherit',
        scopeName: scopeName || '',
      });
    } catch (error) {
      logger.error('[API] Error reading meshcore auto-ack settings:', error);
      fail(res, 500, 'INTERNAL_ERROR', 'Failed to read auto-ack settings');
    }
  },
);

router.post(
  '/automation/autoack',
  requireAuth(),
  requirePermission('automation', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id?: string }).id!;
      const settings = databaseService.settings;
      const {
        enabled,
        regex,
        message,
        channels,
        directMessages,
        useDM,
        cooldownSeconds,
        preSendDelaySeconds,
        testMessages,
        ignoredNodes,
        splitLongMessages,
        scopeMode,
        scopeName,
      } = req.body as {
        enabled?: boolean;
        regex?: string;
        message?: string;
        channels?: number[];
        directMessages?: boolean;
        useDM?: boolean;
        cooldownSeconds?: number;
        preSendDelaySeconds?: number;
        testMessages?: string;
        ignoredNodes?: string;
        splitLongMessages?: boolean;
        scopeMode?: 'inherit' | 'trigger' | 'unscoped' | 'named';
        scopeName?: string;
      };

      if (enabled !== undefined) {
        await settings.setSourceSetting(sourceId, 'meshcoreAutoAckEnabled', String(enabled));
      }
      if (regex !== undefined) {
        // Store-time safety gate. The shared validator rejects unsafe
        // shapes (catastrophic backtracking, oversized patterns) and
        // confirms the value is a syntactically valid RegExp. Centralised
        // with the manager's execution-time check so the two stay in
        // sync; this also satisfies CodeQL's js/regex-injection check.
        const validation = validateAutoAckRegex(regex);
        if (!validation.ok) {
          return fail(res, 400, 'INVALID_REGEX', `Invalid regex pattern: ${validation.error}`);
        }
        await settings.setSourceSetting(sourceId, 'meshcoreAutoAckRegex', regex);
      }
      if (message !== undefined) {
        await settings.setSourceSetting(sourceId, 'meshcoreAutoAckMessage', message);
      }
      if (channels !== undefined) {
        const csv = Array.isArray(channels)
          ? channels.filter(n => Number.isFinite(n)).join(',')
          : '';
        await settings.setSourceSetting(sourceId, 'meshcoreAutoAckChannels', csv);
      }
      if (directMessages !== undefined) {
        await settings.setSourceSetting(sourceId, 'meshcoreAutoAckDirectMessages', String(directMessages));
      }
      if (useDM !== undefined) {
        await settings.setSourceSetting(sourceId, 'meshcoreAutoAckUseDM', String(useDM));
      }
      if (cooldownSeconds !== undefined) {
        const clamped = Math.max(0, Math.min(3600, cooldownSeconds));
        await settings.setSourceSetting(sourceId, 'meshcoreAutoAckCooldownSeconds', String(clamped));
      }
      if (preSendDelaySeconds !== undefined) {
        // Pre-send delay caps at 120s (#3876) — long enough to let a repeater
        // settle, short enough that an ack stays prompt.
        const clamped = Math.max(0, Math.min(120, preSendDelaySeconds));
        await settings.setSourceSetting(sourceId, 'meshcoreAutoAckPreSendDelaySeconds', String(clamped));
      }
      if (testMessages !== undefined) {
        await settings.setSourceSetting(sourceId, 'meshcoreAutoAckTestMessages', testMessages);
      }
      if (ignoredNodes !== undefined) {
        // Stored verbatim (minus edge whitespace) so the operator's own layout
        // survives a round-trip; parsing happens at match time (#4391).
        await settings.setSourceSetting(sourceId, 'meshcoreAutoAckIgnoredNodes', String(ignoredNodes).trim());
      }
      if (splitLongMessages !== undefined) {
        // Strict boolean: only a real `true` turns splitting on (#5564), so a
        // stray "false" string cannot multiply the airtime of every reply.
        await settings.setSourceSetting(sourceId, 'meshcoreAutoAckSplitLongMessages', String(splitLongMessages === true));
      }
      if (scopeMode !== undefined) {
        const mode = ['inherit', 'trigger', 'unscoped', 'named'].includes(String(scopeMode)) ? String(scopeMode) : 'inherit';
        await settings.setSourceSetting(sourceId, 'meshcoreAutoAckScopeMode', mode);
      }
      if (scopeName !== undefined) {
        await settings.setSourceSetting(sourceId, 'meshcoreAutoAckScopeName', String(scopeName).trim());
      }

      ok(res);
    } catch (error) {
      logger.error('[API] Error saving meshcore auto-ack settings:', error);
      fail(res, 500, 'INTERNAL_ERROR', 'Failed to save auto-ack settings');
    }
  },
);

// ============ Auto-Announce Automation ============
//
// Per-source settings + actions for MeshCore auto-announce. The
// scheduler lives on the manager (`startAutoAnnounce`,
// `runAutoAnnounceCycle`); this surface is the CRUD + manual-fire +
// preview wrapper the UI calls.

router.get(
  '/automation/announce',
  optionalAuth(),
  requirePermission('automation', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id?: string }).id!;
      const settings = databaseService.settings;

      const enabled = await settings.getSettingForSource(sourceId, 'meshcoreAutoAnnounceEnabled');
      const intervalHours = await settings.getSettingForSource(sourceId, 'meshcoreAutoAnnounceIntervalHours');
      const message = await settings.getSettingForSource(sourceId, 'meshcoreAutoAnnounceMessage');
      const channelIndexesRaw = await settings.getSettingForSource(sourceId, 'meshcoreAutoAnnounceChannelIndexes');
      const announceOnStart = await settings.getSettingForSource(sourceId, 'meshcoreAutoAnnounceOnStart');
      const useSchedule = await settings.getSettingForSource(sourceId, 'meshcoreAutoAnnounceUseSchedule');
      const schedule = await settings.getSettingForSource(sourceId, 'meshcoreAutoAnnounceSchedule');
      const advertEnabled = await settings.getSettingForSource(sourceId, 'meshcoreAutoAnnounceAdvertEnabled');
      const advertDelaySeconds = await settings.getSettingForSource(sourceId, 'meshcoreAutoAnnounceAdvertDelaySeconds');
      const advertMode = await settings.getSettingForSource(sourceId, 'meshcoreAutoAnnounceAdvertMode');
      const lastRunAt = await settings.getSettingForSource(sourceId, 'meshcoreAutoAnnounceLastRunAt');
      const scopeMode = await settings.getSettingForSource(sourceId, 'meshcoreAutoAnnounceScopeMode');
      const scopeName = await settings.getSettingForSource(sourceId, 'meshcoreAutoAnnounceScopeName');

      res.json({
        success: true,
        data: {
          enabled: enabled === 'true',
          intervalHours: parseInt(intervalHours || '6', 10) || 6,
          message: message || 'MeshMonitor {VERSION} online for {DURATION} — {CONTACTCOUNT} contacts',
          channelIndexes: (channelIndexesRaw || '')
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
            .map(s => parseInt(s, 10))
            .filter(n => Number.isFinite(n)),
          announceOnStart: announceOnStart === 'true',
          useSchedule: useSchedule === 'true',
          schedule: schedule || '0 */6 * * *',
          advertEnabled: advertEnabled === 'true',
          advertDelaySeconds: parseInt(advertDelaySeconds || '30', 10) || 30,
          // Absent mode: an ENABLED burst predates the field and has always
          // flooded, so report (and keep) flood; otherwise this is a new
          // config and gets the zero-hop default.
          advertMode: resolveMeshCoreAdvertMode(advertMode, advertEnabled === 'true' ? 'flood' : 'zero_hop'),
          lastRunAt: lastRunAt ? parseInt(lastRunAt, 10) || null : null,
          // MeshCore scope/region for the announcement (#3833). No trigger here,
          // so only inherit / unscoped / named are meaningful.
          scopeMode: (scopeMode as 'inherit' | 'unscoped' | 'named') || 'inherit',
          scopeName: scopeName || '',
        },
      });
    } catch (error) {
      logger.error('[API] Error reading meshcore auto-announce settings:', error);
      res.status(500).json({ success: false, error: 'Failed to read auto-announce settings' });
    }
  },
);

router.post(
  '/automation/announce',
  requireAuth(),
  requirePermission('automation', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id?: string }).id!;
      const settings = databaseService.settings;
      const {
        enabled,
        intervalHours,
        message,
        channelIndexes,
        announceOnStart,
        useSchedule,
        schedule,
        advertEnabled,
        advertDelaySeconds,
        advertMode,
        scopeMode,
        scopeName,
      } = req.body as {
        enabled?: boolean;
        intervalHours?: number;
        message?: string;
        channelIndexes?: number[];
        announceOnStart?: boolean;
        useSchedule?: boolean;
        schedule?: string;
        advertEnabled?: boolean;
        advertDelaySeconds?: number;
        advertMode?: unknown;
        scopeMode?: 'inherit' | 'unscoped' | 'named';
        scopeName?: string;
      };

      // Validate before writing anything so a bad request leaves no partial save.
      if (advertMode !== undefined && !isMeshCoreAdvertMode(advertMode)) {
        return fail(res, 400, 'INVALID_ADVERT_MODE', `advertMode must be one of: ${MESHCORE_ADVERT_MODES.join(', ')}`);
      }

      if (enabled !== undefined) {
        await settings.setSourceSetting(sourceId, 'meshcoreAutoAnnounceEnabled', String(enabled));
      }
      if (intervalHours !== undefined) {
        const clamped = Math.max(1, Math.min(168, Math.floor(intervalHours) || 6));
        await settings.setSourceSetting(sourceId, 'meshcoreAutoAnnounceIntervalHours', String(clamped));
      }
      if (message !== undefined) {
        await settings.setSourceSetting(sourceId, 'meshcoreAutoAnnounceMessage', String(message));
      }
      if (channelIndexes !== undefined) {
        const csv = Array.isArray(channelIndexes)
          ? channelIndexes.filter(n => Number.isFinite(n)).join(',')
          : '';
        await settings.setSourceSetting(sourceId, 'meshcoreAutoAnnounceChannelIndexes', csv);
      }
      if (announceOnStart !== undefined) {
        await settings.setSourceSetting(sourceId, 'meshcoreAutoAnnounceOnStart', String(announceOnStart));
      }
      if (useSchedule !== undefined) {
        await settings.setSourceSetting(sourceId, 'meshcoreAutoAnnounceUseSchedule', String(useSchedule));
      }
      if (schedule !== undefined) {
        await settings.setSourceSetting(sourceId, 'meshcoreAutoAnnounceSchedule', String(schedule));
      }
      if (advertEnabled !== undefined) {
        await settings.setSourceSetting(sourceId, 'meshcoreAutoAnnounceAdvertEnabled', String(advertEnabled));
      }
      if (advertDelaySeconds !== undefined) {
        const clamped = Math.max(0, Math.min(600, Math.floor(advertDelaySeconds) || 30));
        await settings.setSourceSetting(sourceId, 'meshcoreAutoAnnounceAdvertDelaySeconds', String(clamped));
      }
      if (advertMode !== undefined) {
        await settings.setSourceSetting(sourceId, 'meshcoreAutoAnnounceAdvertMode', advertMode);
      }
      if (scopeMode !== undefined) {
        const mode = ['inherit', 'unscoped', 'named'].includes(String(scopeMode)) ? String(scopeMode) : 'inherit';
        await settings.setSourceSetting(sourceId, 'meshcoreAutoAnnounceScopeMode', mode);
      }
      if (scopeName !== undefined) {
        await settings.setSourceSetting(sourceId, 'meshcoreAutoAnnounceScopeName', String(scopeName).trim());
      }

      // Re-arm the scheduler so the new settings take effect immediately.
      await managerFor(req, res).startAutoAnnounce().catch((err: Error) =>
        logger.warn(`[API] auto-announce restart after save failed: ${err.message}`));

      const lastRunRaw = await settings.getSettingForSource(sourceId, 'meshcoreAutoAnnounceLastRunAt');
      res.json({
        success: true,
        data: {
          lastRunAt: lastRunRaw ? parseInt(lastRunRaw, 10) || null : null,
        },
      });
    } catch (error) {
      logger.error('[API] Error saving meshcore auto-announce settings:', error);
      res.status(500).json({ success: false, error: 'Failed to save auto-announce settings' });
    }
  },
);

router.get(
  '/automation/announce/preview',
  optionalAuth(),
  requirePermission('automation', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const mgr = managerFor(req, res);
      const message = String(req.query.message ?? '');
      if (!message) {
        return res.status(400).json({ success: false, error: 'Missing message parameter' });
      }
      const preview = await mgr.previewAnnouncementMessage(message);
      res.json({ success: true, preview });
    } catch (error) {
      logger.error('[API] Error generating meshcore announce preview:', error);
      res.status(500).json({ success: false, error: 'Failed to generate preview' });
    }
  },
);

router.post(
  '/automation/announce/send',
  extendRequestTimeout(MANUAL_AUTOMATION_RUN_TIMEOUT_MS),
  meshcoreDeviceLimiter,
  requireAuth(),
  requirePermission('automation', 'write', { sourceIdFrom: 'params.id' }),
  requireMeshcoreTx(),
  async (req: Request, res: Response) => {
    try {
      const mgr = managerFor(req, res);
      const result = await mgr.runAutoAnnounceCycle('manual');
      const status = mgr.getAutoAnnounceStatus();
      res.json({ success: true, data: { ...result, lastRunAt: status.lastRunAt || null } });
    } catch (error) {
      if (failIfTxDisabled(res, error)) return;
      logger.error('[API] Error sending manual meshcore announce:', error);
      res.status(500).json({ success: false, error: 'Failed to send announcement' });
    }
  },
);

// ============ Timer Triggers Automation ============
//
// Triggers persist as a JSON array; the manager re-reads on schedule
// fire so a freshly-saved template applies on the next tick. The
// shared MeshCoreTimerTrigger type lives in src/server/meshcoreManager.ts.

router.get(
  '/automation/timers',
  optionalAuth(),
  requirePermission('automation', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id?: string }).id!;
      const raw = (await databaseService.settings.getSettingForSource(sourceId, 'meshcoreTimerTriggers')) || '[]';
      let triggers: unknown = [];
      try { triggers = JSON.parse(raw); } catch { triggers = []; }
      res.json({ success: true, data: { triggers: Array.isArray(triggers) ? triggers : [] } });
    } catch (error) {
      logger.error('[API] Error reading meshcore timer triggers:', error);
      res.status(500).json({ success: false, error: 'Failed to read timer triggers' });
    }
  },
);

router.post(
  '/automation/timers',
  requireAuth(),
  requirePermission('automation', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id?: string }).id!;
      const body = req.body as { triggers?: unknown };
      if (!Array.isArray(body.triggers)) {
        return res.status(400).json({ success: false, error: 'triggers must be an array' });
      }
      // advertMode is optional (absent = legacy flood) but must be valid if set.
      const badMode = (body.triggers as Array<{ id?: unknown; advertMode?: unknown } | null>).find(
        (t) => t != null && t.advertMode !== undefined && !isMeshCoreAdvertMode(t.advertMode),
      );
      if (badMode) {
        return fail(res, 400, 'INVALID_ADVERT_MODE', `Trigger ${String(badMode.id ?? '')}: advertMode must be one of: ${MESHCORE_ADVERT_MODES.join(', ')}`);
      }
      // Run state belongs to the scheduler; keep the stored values (#5827).
      const storedJson = await databaseService.settings.getSettingForSource(sourceId, 'meshcoreTimerTriggers');
      const triggers = keepServerRunState(body.triggers as unknown[], parseStoredTriggers(storedJson));
      await databaseService.settings.setSourceSetting(sourceId, 'meshcoreTimerTriggers', JSON.stringify(triggers));

      await managerFor(req, res).startTimerTriggers().catch((err: Error) =>
        logger.warn(`[API] timer-trigger restart after save failed: ${err.message}`));

      res.json({ success: true });
    } catch (error) {
      logger.error('[API] Error saving meshcore timer triggers:', error);
      res.status(500).json({ success: false, error: 'Failed to save timer triggers' });
    }
  },
);

router.post(
  '/automation/timers/:triggerId/run',
  extendRequestTimeout(MANUAL_AUTOMATION_RUN_TIMEOUT_MS),
  meshcoreDeviceLimiter,
  requireAuth(),
  requirePermission('automation', 'write', { sourceIdFrom: 'params.id' }),
  requireMeshcoreTx(),
  async (req: Request, res: Response) => {
    try {
      const mgr = managerFor(req, res);
      const triggerId = String((req.params as { triggerId?: string }).triggerId || '');
      if (!triggerId) {
        return res.status(400).json({ success: false, error: 'triggerId required' });
      }
      const result = await mgr.runTimerTrigger(triggerId);
      res.json({ success: result.ok, data: result });
    } catch (error) {
      if (failIfTxDisabled(res, error)) return;
      logger.error('[API] Error running meshcore timer trigger:', error);
      res.status(500).json({ success: false, error: 'Failed to run timer trigger' });
    }
  },
);

// ============ Auto-Responder Automation ============
//
// Multi-pattern reactor. Triggers persist as a JSON array and the
// manager re-reads them on every incoming message so a saved pattern
// fires on the next packet without a restart.

router.get(
  '/automation/responder',
  optionalAuth(),
  requirePermission('automation', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id?: string }).id!;
      const enabled = await databaseService.settings.getSettingForSource(sourceId, 'meshcoreAutoResponderEnabled');
      const raw = (await databaseService.settings.getSettingForSource(sourceId, 'meshcoreAutoResponderTriggers')) || '[]';
      let triggers: unknown = [];
      try { triggers = JSON.parse(raw); } catch { triggers = []; }
      res.json({
        success: true,
        data: {
          enabled: enabled === 'true',
          triggers: Array.isArray(triggers) ? triggers : [],
        },
      });
    } catch (error) {
      logger.error('[API] Error reading meshcore auto-responder settings:', error);
      res.status(500).json({ success: false, error: 'Failed to read auto-responder settings' });
    }
  },
);

router.post(
  '/automation/responder',
  requireAuth(),
  requirePermission('automation', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id?: string }).id!;
      const body = req.body as { enabled?: boolean; triggers?: unknown };

      if (body.enabled !== undefined) {
        await databaseService.settings.setSourceSetting(sourceId, 'meshcoreAutoResponderEnabled', String(body.enabled));
      }
      if (body.triggers !== undefined) {
        if (!Array.isArray(body.triggers)) {
          return res.status(400).json({ success: false, error: 'triggers must be an array' });
        }
        // Validate each trigger's pattern up front, in its syntax (#5924),
        // so a broken pattern never reaches the message loop. Missing
        // syntax = 'regex', the pre-#5924 behaviour. Same shared checks
        // the manager and the UI apply.
        for (const tr of body.triggers as Array<{ id?: string; pattern?: string; syntax?: unknown }>) {
          if (tr?.syntax !== undefined && !isResponderSyntax(tr.syntax)) {
            return fail(res, 400, 'INVALID_REGEX', `Invalid syntax for trigger ${tr.id || '(unnamed)'}: must be "pattern" or "regex"`);
          }
          if (typeof tr?.pattern !== 'string') continue;
          const syntax = resolveResponderSyntax(tr.syntax, 'regex');
          const v = validateResponderTrigger(tr.pattern, syntax);
          if (!v.ok) {
            const kind = syntax === 'regex' ? 'regex' : 'pattern';
            return fail(res, 400, 'INVALID_REGEX', `Invalid ${kind} for trigger ${tr.id || '(unnamed)'}: ${v.error}`);
          }
        }
        await databaseService.settings.setSourceSetting(sourceId, 'meshcoreAutoResponderTriggers', JSON.stringify(body.triggers));
      }

      managerFor(req, res).resetAutoResponderRegexCache();

      res.json({ success: true });
    } catch (error) {
      logger.error('[API] Error saving meshcore auto-responder settings:', error);
      res.status(500).json({ success: false, error: 'Failed to save auto-responder settings' });
    }
  },
);

export default router;
