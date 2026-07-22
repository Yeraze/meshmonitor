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
import { meshcoreDeviceLimiter } from '../middleware/rateLimiters.js';
import { resolveAutoAckPreSendDelaySeconds } from '../autoAckDelay.js';
import { compileUserRegex } from '../../utils/safeRegex.js';
import { ok, fail } from '../utils/apiResponse.js';
import type { MeshcorePathfindingFilterSettings } from '../../services/database.js';
import { managerFor } from './meshcoreRouteShared.js';

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
      const scopeMode = await settings.getSettingForSource(sourceId, 'meshcoreAutoAckScopeMode');
      const scopeName = await settings.getSettingForSource(sourceId, 'meshcoreAutoAckScopeName');

      res.json({
        success: true,
        data: {
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
          // MeshCore scope/region for the ack reply (#3833).
          scopeMode: (scopeMode as 'inherit' | 'trigger' | 'unscoped' | 'named') || 'inherit',
          scopeName: scopeName || '',
        },
      });
    } catch (error) {
      logger.error('[API] Error reading meshcore auto-ack settings:', error);
      res.status(500).json({ success: false, error: 'Failed to read auto-ack settings' });
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
          return res.status(400).json({ success: false, error: `Invalid regex pattern: ${validation.error}` });
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
      if (scopeMode !== undefined) {
        const mode = ['inherit', 'trigger', 'unscoped', 'named'].includes(String(scopeMode)) ? String(scopeMode) : 'inherit';
        await settings.setSourceSetting(sourceId, 'meshcoreAutoAckScopeMode', mode);
      }
      if (scopeName !== undefined) {
        await settings.setSourceSetting(sourceId, 'meshcoreAutoAckScopeName', String(scopeName).trim());
      }

      res.json({ success: true });
    } catch (error) {
      logger.error('[API] Error saving meshcore auto-ack settings:', error);
      res.status(500).json({ success: false, error: 'Failed to save auto-ack settings' });
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
        scopeMode?: 'inherit' | 'unscoped' | 'named';
        scopeName?: string;
      };

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
  meshcoreDeviceLimiter,
  requireAuth(),
  requirePermission('automation', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const mgr = managerFor(req, res);
      const result = await mgr.runAutoAnnounceCycle('manual');
      const status = mgr.getAutoAnnounceStatus();
      res.json({ success: true, data: { ...result, lastRunAt: status.lastRunAt || null } });
    } catch (error) {
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
      await databaseService.settings.setSourceSetting(sourceId, 'meshcoreTimerTriggers', JSON.stringify(body.triggers));

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
  meshcoreDeviceLimiter,
  requireAuth(),
  requirePermission('automation', 'write', { sourceIdFrom: 'params.id' }),
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
        // Validate each trigger's regex up front so a broken pattern
        // never reaches the message loop. Reuses the same validator
        // the manager applies at execution time.
        for (const tr of body.triggers as Array<{ id?: string; pattern?: string }>) {
          if (typeof tr?.pattern !== 'string') continue;
          const v = validateAutoAckRegex(tr.pattern);
          if (!v.ok) {
            return res.status(400).json({
              success: false,
              error: `Invalid regex for trigger ${tr.id || '(unnamed)'}: ${v.error}`,
            });
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
