/**
 * Settings Routes
 *
 * GET /settings   — read all settings (public, optionalAuth)
 * POST /settings  — save settings (requires settings:write)
 * DELETE /settings — reset to defaults (requires settings:write)
 *
 * Extracted from server.ts so the real filtering/validation logic
 * can be tested without importing the entire monolith.
 */

import { Router, Request, Response } from 'express';
import { optionalAuth, requirePermission } from '../auth/authMiddleware.js';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { compileUserRegex } from '../../utils/safeRegex.js';
import { parseDiscardInvalidPositions } from '../../utils/positionIngestConfig.js';
import { parseNoIndexEnabled } from '../../utils/robotsConfig.js';
import { securityDigestService } from '../services/securityDigestService.js';
import { invalidatePkiDmGlobalCache } from '../services/sourcePkiKeyStore.js';
import { VALID_SETTINGS_KEYS, stripSecretSettings } from '../constants/settings.js';
import { resolveSourceManager } from '../utils/resolveSourceManager.js';
import { validateFilterNameRegexOnSave } from '../utils/filterNameRegex.js';
import { positionEstimationScheduler } from '../services/positionEstimationScheduler.js';
import { autoDeleteByDistanceService } from '../services/autoDeleteByDistanceService.js';

// ─── Tile URL validation ─────────────────────────────────────────────────

export function validateTileUrl(url: string): boolean {
  if (!url.includes('{z}') || !url.includes('{x}') || !url.includes('{y}')) {
    return false;
  }
  try {
    const testUrl = url
      .replace(/{z}/g, '0')
      .replace(/{x}/g, '0')
      .replace(/{y}/g, '0')
      .replace(/{s}/g, 'a');
    const parsedUrl = new URL(testUrl);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function validateCustomTilesets(tilesets: any[]): boolean {
  if (!Array.isArray(tilesets)) {
    return false;
  }

  for (const tileset of tilesets) {
    if (
      typeof tileset.id !== 'string' ||
      typeof tileset.name !== 'string' ||
      typeof tileset.url !== 'string' ||
      typeof tileset.attribution !== 'string' ||
      typeof tileset.maxZoom !== 'number' ||
      typeof tileset.description !== 'string' ||
      typeof tileset.createdAt !== 'number' ||
      typeof tileset.updatedAt !== 'number'
    ) {
      return false;
    }

    if (!tileset.id.startsWith('custom-')) {
      return false;
    }

    if (
      tileset.name.length > 100 ||
      tileset.url.length > 500 ||
      tileset.attribution.length > 200 ||
      tileset.description.length > 200
    ) {
      return false;
    }

    if (tileset.maxZoom < 1 || tileset.maxZoom > 22) {
      return false;
    }

    if (!validateTileUrl(tileset.url)) {
      return false;
    }
  }

  return true;
}

function normalizeIgnoredNodeIds(rawValue: string): string {
  const tokens = rawValue
    .split(/[\s,]+/)
    .map(token => token.trim().toLowerCase())
    .filter(Boolean);

  const normalized = new Set<string>();

  for (const token of tokens) {
    if (!/^!?[0-9a-f]{8}$/.test(token)) {
      throw new Error('Node ignore list entries must be 8-digit hex node IDs (example: !b29fa8d4)');
    }

    const hex = token.startsWith('!') ? token.slice(1) : token;
    normalized.add(`!${hex}`);
  }

  return [...normalized].join(',');
}

// ─── Side-effect callbacks ───────────────────────────────────────────────
// These are injected by server.ts so the route handler doesn't directly
// depend on meshtasticManager / inactiveNodeNotificationService / etc.

export interface SettingsCallbacks {
  refreshTileHostnameCache?: () => void | Promise<void>;
  setTracerouteInterval?: (interval: number) => void;
  setRemoteAdminScannerInterval?: (interval: number, sourceId?: string | null) => void;
  setLocalStatsInterval?: (interval: number) => void;
  setKeyRepairSettings?: (settings: {
    enabled: boolean;
    intervalMinutes: number;
    maxExchanges: number;
    autoPurge: boolean;
    immediatePurge: boolean;
  }) => void;
  restartInactiveNodeService?: (threshold: number, check: number, cooldown: number) => void;
  stopInactiveNodeService?: () => void;
  restartLowBatteryService?: (check: number, cooldown: number) => void;
  stopLowBatteryService?: () => void;
  restartAnnounceScheduler?: (sourceId?: string | null) => void;
  restartTimerScheduler?: (sourceId?: string | null) => void;
  restartGeofenceEngine?: (sourceId?: string | null) => void;
  setAutomationAirtimeCutoffThreshold?: (threshold: number, sourceId?: string | null) => void;
  setAutomationAirtimeCutoffSource?: (source: string, sourceId?: string | null) => void;
  handleAutoWelcomeEnabled?: () => number;
  invalidateHtmlCache?: () => void;
  // Global (default ON): push the new discard-invalid-positions value into the
  // cached ingest gate so it takes effect immediately, no restart.
  setDiscardInvalidPositions?: (enabled: boolean) => void;
  // Global (default OFF): push the new no-index value into the cached gate so
  // the X-Robots-Tag header + /robots.txt body take effect immediately (#4202).
  setNoIndexEnabled?: (enabled: boolean) => void;
  // Per-source (#3901): the scheduler reads the source's own interval, so no
  // intervalHours arg. A null sourceId is a no-op (no global scheduler).
  restartAutoDeleteByDistanceService?: (sourceId?: string | null) => void;
  stopAutoDeleteByDistanceService?: (sourceId?: string | null) => void;
  // ATAK/CoT Phase 3 (issue #3691): global singleton (not per-source). Re-read
  // cotFeedEnabled/cotFeedPort and (re)start or stop the CoT feed server.
  restartCotFeed?: () => void;
  stopCotFeed?: () => void;
}

let callbacks: SettingsCallbacks = {};

export function setSettingsCallbacks(cb: SettingsCallbacks): void {
  callbacks = cb;
}

// ─── Router ──────────────────────────────────────────────────────────────

const router = Router();

// GET /settings — read settings (public)
// ?sourceId=<id>  → global settings merged with per-source overrides (source wins)
//
// Secret-bearing keys (VAPID private key, apprise URLs, analytics tokens, etc.)
// are stripped from the response for non-admin callers (MM-SEC-1) — see
// `stripSecretSettings` and `SECRET_SETTINGS_KEYS` in `constants/settings.ts`.
router.get('/', optionalAuth(), async (req: Request, res: Response) => {
  try {
    const sourceId = typeof req.query.sourceId === 'string' ? req.query.sourceId : null;
    const isAdmin = (req as any).user?.isAdmin === true;

    const globalSettings = await databaseService.settings.getAllSettings();

    if (sourceId) {
      // Strip source: prefixed keys from global (they are internal implementation detail)
      const cleaned: Record<string, string> = {};
      for (const [k, v] of Object.entries(globalSettings)) {
        if (!k.startsWith('source:')) cleaned[k] = v;
      }
      const sourceSettings = await databaseService.settings.getSourceSettings(sourceId);
      const merged = { ...cleaned, ...sourceSettings };
      res.json(stripSecretSettings(merged, isAdmin));
    } else {
      // Return only non-namespaced keys for global view
      const cleaned: Record<string, string> = {};
      for (const [k, v] of Object.entries(globalSettings)) {
        if (!k.startsWith('source:')) cleaned[k] = v;
      }
      res.json(stripSecretSettings(cleaned, isAdmin));
    }
  } catch (error) {
    logger.error('Error fetching settings:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// POST /settings — save settings
// ?sourceId=<id>  → save as per-source settings (skips global side-effects)
router.post('/', requirePermission('settings', 'write'), async (req: Request, res: Response) => {
  try {
    const settings = req.body;
    const sourceId = typeof req.query.sourceId === 'string' ? req.query.sourceId : null;

    // Get current settings for before/after comparison
    const currentSettings = await databaseService.settings.getAllSettings();

    // Validate settings
    const filteredSettings: Record<string, string> = {};

    for (const key of VALID_SETTINGS_KEYS) {
      if (key in settings) {
        filteredSettings[key] = String(settings[key]);
      }
    }

    // Validate autoAckRegex pattern.
    //
    // The pattern is validated with RE2 (compileUserRegex), which — unlike the
    // browser's native RegExp used by the client — rejects lookaround and
    // backreferences (`(?=`, `(?<=`, `(?!`, `(?<!`, `\1`, …). Without the guard
    // below, an install that previously persisted such a pattern would be
    // permanently stuck: every save re-POSTs the stored regex and the whole
    // request 400s, so the user can't even toggle auto-ack OFF (#3806).
    //
    // We therefore only hard-validate when the regex actually matters: when
    // auto-acknowledge is being (or staying) enabled, or when the regex value
    // is actually changing. Disabling auto-ack — or re-saving an unchanged bad
    // pattern while it's disabled — is always allowed so the section unsticks.
    if ('autoAckRegex' in filteredSettings) {
      const pattern = filteredSettings.autoAckRegex;

      const willBeEnabled =
        'autoAckEnabled' in filteredSettings
          ? filteredSettings.autoAckEnabled === 'true'
          : currentSettings.autoAckEnabled === 'true';
      const regexChanged = pattern !== (currentSettings.autoAckRegex ?? '');

      if (willBeEnabled || regexChanged) {
        if (pattern.length > 100) {
          return res.status(400).json({ error: 'Regex pattern too long (max 100 characters)' });
        }

        if (/(\.\*){2,}|(\+.*\+)|(\*.*\*)|(\{[0-9]{3,}\})|(\{[0-9]+,\})/.test(pattern)) {
          return res.status(400).json({ error: 'Regex pattern too complex or may cause performance issues' });
        }

        try {
          compileUserRegex(pattern, 'i');
        } catch (error) {
          return res.status(400).json({
            error:
              'Invalid regex syntax: lookaround and backreferences (e.g. (?=, (?!, (?<=, \\1) are not supported. Use a simpler pattern.',
          });
        }
      }
    }

    // Validate autoAckChannels
    if ('autoAckChannels' in filteredSettings) {
      const channelList = filteredSettings.autoAckChannels.split(',');
      const validChannels = channelList
        .map((c) => parseInt(c.trim()))
        .filter((n) => !isNaN(n) && n >= 0 && n < 8);
      filteredSettings.autoAckChannels = validChannels.join(',');
    }

    if ('autoAckIgnoredNodes' in filteredSettings) {
      try {
        filteredSettings.autoAckIgnoredNodes = normalizeIgnoredNodeIds(filteredSettings.autoAckIgnoredNodes);
      } catch (error) {
        return res.status(400).json({
          error: error instanceof Error ? error.message : 'Invalid node ignore list format',
        });
      }
    }

    // Validate inactive node notification settings
    if ('inactiveNodeThresholdHours' in filteredSettings) {
      const threshold = parseInt(filteredSettings.inactiveNodeThresholdHours, 10);
      if (isNaN(threshold) || threshold < 1 || threshold > 720) {
        return res.status(400).json({ error: 'inactiveNodeThresholdHours must be between 1 and 720 hours' });
      }
    }

    if ('inactiveNodeCheckIntervalMinutes' in filteredSettings) {
      const interval = parseInt(filteredSettings.inactiveNodeCheckIntervalMinutes, 10);
      if (isNaN(interval) || interval < 1 || interval > 1440) {
        return res
          .status(400)
          .json({ error: 'inactiveNodeCheckIntervalMinutes must be between 1 and 1440 minutes' });
      }
    }

    if ('inactiveNodeCooldownHours' in filteredSettings) {
      const cooldown = parseInt(filteredSettings.inactiveNodeCooldownHours, 10);
      if (isNaN(cooldown) || cooldown < 1 || cooldown > 720) {
        return res.status(400).json({ error: 'inactiveNodeCooldownHours must be between 1 and 720 hours' });
      }
    }

    // Validate low battery notification settings
    if ('lowBatteryCheckIntervalMinutes' in filteredSettings) {
      const interval = parseInt(filteredSettings.lowBatteryCheckIntervalMinutes, 10);
      if (isNaN(interval) || interval < 1 || interval > 1440) {
        return res
          .status(400)
          .json({ error: 'lowBatteryCheckIntervalMinutes must be between 1 and 1440 minutes' });
      }
    }

    if ('lowBatteryCooldownHours' in filteredSettings) {
      const cooldown = parseInt(filteredSettings.lowBatteryCooldownHours, 10);
      if (isNaN(cooldown) || cooldown < 1 || cooldown > 720) {
        return res.status(400).json({ error: 'lowBatteryCooldownHours must be between 1 and 720 hours' });
      }
    }

    // Validate airtime cutoff threshold (0 = disabled, 1-100 = percent Channel Utilization)
    if ('automationAirtimeCutoffThreshold' in filteredSettings) {
      const threshold = parseInt(filteredSettings.automationAirtimeCutoffThreshold, 10);
      if (isNaN(threshold) || threshold < 0 || threshold > 100) {
        return res
          .status(400)
          .json({ error: 'automationAirtimeCutoffThreshold must be between 0 and 100 (0 = disabled)' });
      }
    }

    // Validate airtime cutoff source ('local' or 'neighbors')
    if ('automationAirtimeCutoffSource' in filteredSettings) {
      const source = filteredSettings.automationAirtimeCutoffSource;
      if (source !== 'local' && source !== 'neighbors') {
        return res
          .status(400)
          .json({ error: "automationAirtimeCutoffSource must be 'local' or 'neighbors'" });
      }
    }

    // Validate autoResponderTriggers JSON
    if ('autoResponderTriggers' in filteredSettings) {
      try {
        const triggers = JSON.parse(filteredSettings.autoResponderTriggers);

        if (!Array.isArray(triggers)) {
          return res.status(400).json({ error: 'autoResponderTriggers must be an array' });
        }

        for (const trigger of triggers) {
          // Mailbox is a built-in handler that parses the message itself — it
          // carries no `response`, so exempt it from the response-required check.
          const responseRequired = trigger.responseType !== 'mailbox';
          if (!trigger.id || !trigger.trigger || !trigger.responseType || (responseRequired && !trigger.response)) {
            return res
              .status(400)
              .json({ error: 'Each trigger must have id, trigger, responseType, and response fields' });
          }

          if (Array.isArray(trigger.trigger) && trigger.trigger.length === 0) {
            return res.status(400).json({ error: 'Trigger array cannot be empty' });
          }
          if (!Array.isArray(trigger.trigger) && typeof trigger.trigger !== 'string') {
            return res.status(400).json({ error: 'Trigger must be a string or array of strings' });
          }

          if (
            trigger.responseType !== 'text' &&
            trigger.responseType !== 'http' &&
            trigger.responseType !== 'script' &&
            trigger.responseType !== 'mailbox'
          ) {
            return res.status(400).json({ error: 'responseType must be "text", "http", "script", or "mailbox"' });
          }

          if (trigger.responseType === 'script') {
            if (!trigger.response.startsWith('/data/scripts/')) {
              return res.status(400).json({ error: 'Script path must start with /data/scripts/' });
            }
            if (trigger.response.includes('..')) {
              return res.status(400).json({ error: 'Script path cannot contain ..' });
            }
            const ext = trigger.response.split('.').pop()?.toLowerCase();
            if (!ext || !['js', 'mjs', 'py', 'sh'].includes(ext)) {
              return res.status(400).json({ error: 'Script must have .js, .mjs, .py, or .sh extension' });
            }
          }
        }
      } catch (error) {
        return res.status(400).json({ error: 'Invalid JSON format for autoResponderTriggers' });
      }
    }

    // Validate timerTriggers JSON
    if ('timerTriggers' in filteredSettings) {
      try {
        const triggers = JSON.parse(filteredSettings.timerTriggers);

        if (!Array.isArray(triggers)) {
          return res.status(400).json({ error: 'timerTriggers must be an array' });
        }

        for (const trigger of triggers) {
          if (!trigger.id || !trigger.name || !trigger.cronExpression) {
            return res
              .status(400)
              .json({ error: 'Each timer trigger must have id, name, and cronExpression fields' });
          }

          const responseType = trigger.responseType || 'script';
          if (responseType !== 'script' && responseType !== 'text') {
            return res.status(400).json({ error: 'responseType must be "script" or "text"' });
          }

          if (responseType === 'script') {
            if (!trigger.scriptPath) {
              return res.status(400).json({ error: 'Script timer triggers must have a scriptPath' });
            }
            if (!trigger.scriptPath.startsWith('/data/scripts/')) {
              return res.status(400).json({ error: 'Timer script path must start with /data/scripts/' });
            }
            if (trigger.scriptPath.includes('..')) {
              return res.status(400).json({ error: 'Timer script path cannot contain ..' });
            }
            const ext = trigger.scriptPath.split('.').pop()?.toLowerCase();
            if (!ext || !['js', 'mjs', 'py', 'sh'].includes(ext)) {
              return res.status(400).json({ error: 'Timer script must have .js, .mjs, .py, or .sh extension' });
            }
          } else if (responseType === 'text') {
            if (!trigger.response || typeof trigger.response !== 'string' || trigger.response.trim().length === 0) {
              return res
                .status(400)
                .json({ error: 'Text timer triggers must have a non-empty response message' });
            }
          }

          if (typeof trigger.cronExpression !== 'string' || trigger.cronExpression.trim().length === 0) {
            return res.status(400).json({ error: 'cronExpression must be a non-empty string' });
          }

          if (trigger.enabled !== undefined && typeof trigger.enabled !== 'boolean') {
            return res.status(400).json({ error: 'enabled must be a boolean' });
          }
        }
      } catch (error) {
        return res.status(400).json({ error: 'Invalid JSON format for timerTriggers' });
      }
    }

    // Validate geofenceTriggers JSON
    if ('geofenceTriggers' in filteredSettings) {
      try {
        const triggers = JSON.parse(filteredSettings.geofenceTriggers);

        if (!Array.isArray(triggers)) {
          return res.status(400).json({ error: 'geofenceTriggers must be an array' });
        }

        for (const trigger of triggers) {
          if (
            !trigger.id ||
            !trigger.name ||
            !trigger.shape ||
            !trigger.event ||
            !trigger.responseType ||
            trigger.channel === undefined
          ) {
            return res.status(400).json({
              error: 'Each geofence trigger must have id, name, shape, event, responseType, and channel fields',
            });
          }

          if (trigger.enabled !== undefined && typeof trigger.enabled !== 'boolean') {
            return res.status(400).json({ error: 'enabled must be a boolean' });
          }

          // Validate shape
          if (trigger.shape.type === 'circle') {
            if (
              !trigger.shape.center ||
              typeof trigger.shape.center.lat !== 'number' ||
              typeof trigger.shape.center.lng !== 'number'
            ) {
              return res.status(400).json({ error: 'Circle geofence must have a center with lat and lng' });
            }
            if (trigger.shape.center.lat < -90 || trigger.shape.center.lat > 90) {
              return res.status(400).json({ error: 'Circle center latitude must be between -90 and 90' });
            }
            if (trigger.shape.center.lng < -180 || trigger.shape.center.lng > 180) {
              return res.status(400).json({ error: 'Circle center longitude must be between -180 and 180' });
            }
            if (typeof trigger.shape.radiusKm !== 'number' || trigger.shape.radiusKm <= 0) {
              return res.status(400).json({ error: 'Circle geofence must have a positive radiusKm' });
            }
          } else if (trigger.shape.type === 'polygon') {
            if (!Array.isArray(trigger.shape.vertices) || trigger.shape.vertices.length < 3) {
              return res.status(400).json({ error: 'Polygon geofence must have at least 3 vertices' });
            }
            for (const v of trigger.shape.vertices) {
              if (typeof v.lat !== 'number' || typeof v.lng !== 'number') {
                return res.status(400).json({ error: 'Each polygon vertex must have numeric lat and lng' });
              }
              if (v.lat < -90 || v.lat > 90 || v.lng < -180 || v.lng > 180) {
                return res.status(400).json({ error: 'Polygon vertex coordinates out of range' });
              }
            }
          } else {
            return res.status(400).json({ error: 'Shape type must be "circle" or "polygon"' });
          }

          if (!['entry', 'exit', 'while_inside'].includes(trigger.event)) {
            return res.status(400).json({ error: 'event must be "entry", "exit", or "while_inside"' });
          }

          if (trigger.event === 'while_inside') {
            if (typeof trigger.whileInsideIntervalMinutes !== 'number' || trigger.whileInsideIntervalMinutes < 1) {
              return res
                .status(400)
                .json({ error: 'whileInsideIntervalMinutes must be >= 1 when event is "while_inside"' });
            }
          }

          if (trigger.responseType !== 'text' && trigger.responseType !== 'script') {
            return res.status(400).json({ error: 'Geofence responseType must be "text" or "script"' });
          }

          if (trigger.responseType === 'text') {
            if (!trigger.response || typeof trigger.response !== 'string' || trigger.response.trim().length === 0) {
              return res
                .status(400)
                .json({ error: 'Text geofence triggers must have a non-empty response message' });
            }
          } else if (trigger.responseType === 'script') {
            if (!trigger.scriptPath) {
              return res.status(400).json({ error: 'Script geofence triggers must have a scriptPath' });
            }
            if (!trigger.scriptPath.startsWith('/data/scripts/')) {
              return res.status(400).json({ error: 'Geofence script path must start with /data/scripts/' });
            }
            if (trigger.scriptPath.includes('..')) {
              return res.status(400).json({ error: 'Geofence script path cannot contain ..' });
            }
            const ext = trigger.scriptPath.split('.').pop()?.toLowerCase();
            if (!ext || !['js', 'mjs', 'py', 'sh'].includes(ext)) {
              return res
                .status(400)
                .json({ error: 'Geofence script must have .js, .mjs, .py, or .sh extension' });
            }
          }

          if (
            trigger.channel !== 'dm' &&
            trigger.channel !== 'none' &&
            (typeof trigger.channel !== 'number' || trigger.channel < 0 || trigger.channel > 7)
          ) {
            return res
              .status(400)
              .json({ error: 'Geofence channel must be "dm", "none", or a number between 0 and 7' });
          }

          if (trigger.nodeFilter) {
            if (trigger.nodeFilter.type !== 'all' && trigger.nodeFilter.type !== 'selected') {
              return res.status(400).json({ error: 'nodeFilter type must be "all" or "selected"' });
            }
            if (trigger.nodeFilter.type === 'selected') {
              if (!Array.isArray(trigger.nodeFilter.nodeNums) || trigger.nodeFilter.nodeNums.length === 0) {
                return res
                  .status(400)
                  .json({ error: 'Selected node filter must include at least one node number' });
              }
            }
          }
        }
      } catch (error) {
        return res.status(400).json({ error: 'Invalid JSON format for geofenceTriggers' });
      }
    }

    // Validate customTilesets JSON
    if ('customTilesets' in filteredSettings) {
      try {
        const tilesets = JSON.parse(filteredSettings.customTilesets);

        if (!Array.isArray(tilesets)) {
          return res.status(400).json({ error: 'customTilesets must be an array' });
        }

        if (tilesets.length > 50) {
          return res.status(400).json({ error: 'Maximum 50 custom tilesets allowed' });
        }

        if (!validateCustomTilesets(tilesets)) {
          return res
            .status(400)
            .json({ error: 'Invalid custom tileset configuration. Check field types, lengths, and URL format.' });
        }
      } catch (error) {
        return res.status(400).json({ error: 'Invalid JSON format for customTilesets' });
      }
    }

    if ('autoDeleteByDistanceIntervalHours' in filteredSettings) {
      const interval = parseInt(filteredSettings.autoDeleteByDistanceIntervalHours, 10);
      if (isNaN(interval) || ![6, 12, 24, 48].includes(interval)) {
        return res.status(400).json({ error: 'autoDeleteByDistanceIntervalHours must be 6, 12, 24, or 48' });
      }
    }

    if ('autoDeleteByDistanceThresholdKm' in filteredSettings) {
      const threshold = parseFloat(filteredSettings.autoDeleteByDistanceThresholdKm);
      if (isNaN(threshold) || threshold <= 0 || threshold > 50000) {
        return res.status(400).json({ error: 'autoDeleteByDistanceThresholdKm must be between 0 and 50000' });
      }
    }

    if ('autoDeleteByDistanceLat' in filteredSettings) {
      const lat = parseFloat(filteredSettings.autoDeleteByDistanceLat);
      if (isNaN(lat) || lat < -90 || lat > 90) {
        return res.status(400).json({ error: 'autoDeleteByDistanceLat must be between -90 and 90' });
      }
    }

    if ('autoDeleteByDistanceLon' in filteredSettings) {
      const lon = parseFloat(filteredSettings.autoDeleteByDistanceLon);
      if (isNaN(lon) || lon < -180 || lon > 180) {
        return res.status(400).json({ error: 'autoDeleteByDistanceLon must be between -180 and 180' });
      }
    }

    // Apprise API server URL (global; #3012). Empty string clears the override
    // so the resolver falls back to APPRISE_URL env / bundled localhost default.
    if ('appriseApiServerUrl' in filteredSettings) {
      const raw = filteredSettings.appriseApiServerUrl.trim();
      if (raw.length > 0) {
        try {
          const parsed = new URL(raw);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return res.status(400).json({ error: 'appriseApiServerUrl must use http:// or https://' });
          }
        } catch {
          return res.status(400).json({ error: 'appriseApiServerUrl must be a valid http(s) URL' });
        }
      }
      filteredSettings.appriseApiServerUrl = raw;
    }

    // Save to database
    if (sourceId) {
      // Per-source: store with source: prefix
      await databaseService.settings.setSourceSettings(sourceId, filteredSettings);

      // Per-source scheduler side-effects (announce / timer / geofence schedulers
      // each read `getSettingForSource(this.sourceId, ...)`, so we must restart
      // the scheduler on the matching source manager when its settings change).
      const announceKeys = [
        'autoAnnounceEnabled',
        'autoAnnounceIntervalHours',
        'autoAnnounceUseSchedule',
        'autoAnnounceSchedule',
      ];
      if (announceKeys.some((key) => key in filteredSettings)) {
        callbacks.restartAnnounceScheduler?.(sourceId);
      }
      if ('timerTriggers' in filteredSettings) {
        callbacks.restartTimerScheduler?.(sourceId);
      }
      if ('geofenceTriggers' in filteredSettings) {
        callbacks.restartGeofenceEngine?.(sourceId);
      }
      if ('automationAirtimeCutoffThreshold' in filteredSettings) {
        const threshold = parseInt(filteredSettings.automationAirtimeCutoffThreshold, 10);
        if (!isNaN(threshold)) {
          callbacks.setAutomationAirtimeCutoffThreshold?.(threshold, sourceId);
        }
      }
      if ('automationAirtimeCutoffSource' in filteredSettings) {
        callbacks.setAutomationAirtimeCutoffSource?.(filteredSettings.automationAirtimeCutoffSource, sourceId);
      }

      // Auto-delete-by-distance is per-source (#3901): restart this source's
      // own scheduler so a settings change takes effect without waiting for the
      // source to reconnect. The scheduler reads enabled/interval itself.
      const distanceDeleteKeys = [
        'autoDeleteByDistanceEnabled',
        'autoDeleteByDistanceIntervalHours',
        'autoDeleteByDistanceThresholdKm',
        'autoDeleteByDistanceLat',
        'autoDeleteByDistanceLon',
        'autoDeleteByDistanceAction',
      ];
      if (distanceDeleteKeys.some((key) => key in filteredSettings)) {
        const enabled = await databaseService.settings.getSettingForSource(sourceId, 'autoDeleteByDistanceEnabled');
        if (enabled === 'true') {
          callbacks.restartAutoDeleteByDistanceService?.(sourceId);
          logger.debug(`✅ Auto-delete-by-distance scheduler restarted (source: ${sourceId})`);
        } else {
          callbacks.stopAutoDeleteByDistanceService?.(sourceId);
          logger.debug(`⏹️ Auto-delete-by-distance scheduler stopped (source: ${sourceId})`);
        }
      }

      return res.json({ success: true });
    }

    await databaseService.settings.setSettings(filteredSettings);

    // ─── Side effects ───────────────────────────────────────────────────
    // PKI DM decryption master switch (#3441): invalidate the cached flag, and
    // when it's turned OFF, forget every stored private key so the master switch
    // is a true off — keys are re-extracted per source only after it's re-enabled.
    if ('pkiDmDecryptionGloballyEnabled' in filteredSettings) {
      invalidatePkiDmGlobalCache();
      if (filteredSettings.pkiDmDecryptionGloballyEnabled !== 'true') {
        try {
          const cleared = await databaseService.sourcePkiKeys.deleteAll();
          logger.info(`🔒 PKI DM decryption disabled globally — cleared ${cleared} stored key(s)`);
        } catch (err) {
          logger.warn('Failed to clear stored PKI keys after global disable:', err);
        }
      }
    }

    if ('customTilesets' in filteredSettings) {
      void callbacks.refreshTileHostnameCache?.();
      logger.debug('🗺️ Refreshed CSP tile hostname cache after customTilesets update');
    }

    if ('analyticsProvider' in filteredSettings || 'analyticsConfig' in filteredSettings) {
      callbacks.invalidateHtmlCache?.();
      logger.debug('📊 Analytics settings updated - HTML cache invalidated');
    }

    if ('discardInvalidPositions' in filteredSettings) {
      const enabled = parseDiscardInvalidPositions(filteredSettings.discardInvalidPositions);
      callbacks.setDiscardInvalidPositions?.(enabled);
      logger.debug(`🗺️ discardInvalidPositions set to ${enabled} — ingest gate updated`);
    }

    if ('noIndexEnabled' in filteredSettings) {
      const enabled = parseNoIndexEnabled(filteredSettings.noIndexEnabled);
      callbacks.setNoIndexEnabled?.(enabled);
      logger.debug(`🤖 noIndexEnabled set to ${enabled} — robots gate updated`);
    }

    if ('autoWelcomeEnabled' in filteredSettings) {
      const wasEnabled = currentSettings['autoWelcomeEnabled'] === 'true';
      const nowEnabled = filteredSettings['autoWelcomeEnabled'] === 'true';
      if (!wasEnabled && nowEnabled) {
        logger.debug('👋 Auto-welcome being enabled - marking existing nodes as welcomed...');
        const markedCount = callbacks.handleAutoWelcomeEnabled?.() ?? 0;
        if (markedCount > 0) {
          logger.debug(`✅ Marked ${markedCount} existing node(s) as welcomed to prevent spam`);
        }
      }
    }

    if ('tracerouteIntervalMinutes' in filteredSettings) {
      const interval = parseInt(filteredSettings.tracerouteIntervalMinutes);
      if (!isNaN(interval) && (interval === 0 || (interval >= 3 && interval <= 60))) {
        callbacks.setTracerouteInterval?.(interval);
      }
    }

    if ('remoteAdminScannerIntervalMinutes' in filteredSettings) {
      const interval = parseInt(filteredSettings.remoteAdminScannerIntervalMinutes);
      if (!isNaN(interval) && interval >= 0 && interval <= 60) {
        callbacks.setRemoteAdminScannerInterval?.(interval, sourceId);
      }
    }

    if ('localStatsIntervalMinutes' in filteredSettings) {
      const interval = parseInt(filteredSettings.localStatsIntervalMinutes);
      if (!isNaN(interval) && interval >= 0 && interval <= 60) {
        callbacks.setLocalStatsInterval?.(interval);
      }
    }

    if ('automationAirtimeCutoffThreshold' in filteredSettings) {
      const threshold = parseInt(filteredSettings.automationAirtimeCutoffThreshold, 10);
      if (!isNaN(threshold) && threshold >= 0 && threshold <= 100) {
        callbacks.setAutomationAirtimeCutoffThreshold?.(threshold, sourceId);
      }
    }

    if ('automationAirtimeCutoffSource' in filteredSettings) {
      callbacks.setAutomationAirtimeCutoffSource?.(filteredSettings.automationAirtimeCutoffSource, sourceId);
    }

    const keyRepairSettings = [
      'autoKeyManagementEnabled',
      'autoKeyManagementIntervalMinutes',
      'autoKeyManagementMaxExchanges',
      'autoKeyManagementAutoPurge',
      'autoKeyManagementImmediatePurge',
    ];
    const keyRepairSettingsChanged = keyRepairSettings.some((key) => key in filteredSettings);
    if (keyRepairSettingsChanged) {
      const dbEnabled = await databaseService.settings.getSetting('autoKeyManagementEnabled');
      const dbInterval = await databaseService.settings.getSetting('autoKeyManagementIntervalMinutes');
      const dbMaxExchanges = await databaseService.settings.getSetting('autoKeyManagementMaxExchanges');
      const dbAutoPurge = await databaseService.settings.getSetting('autoKeyManagementAutoPurge');
      const dbImmediatePurge = await databaseService.settings.getSetting('autoKeyManagementImmediatePurge');
      callbacks.setKeyRepairSettings?.({
        enabled:
          filteredSettings.autoKeyManagementEnabled === 'true' ||
          (filteredSettings.autoKeyManagementEnabled === undefined &&
            dbEnabled === 'true'),
        intervalMinutes: parseInt(
          filteredSettings.autoKeyManagementIntervalMinutes ||
            dbInterval ||
            '5'
        ),
        maxExchanges: parseInt(
          filteredSettings.autoKeyManagementMaxExchanges ||
            dbMaxExchanges ||
            '3'
        ),
        autoPurge:
          filteredSettings.autoKeyManagementAutoPurge === 'true' ||
          (filteredSettings.autoKeyManagementAutoPurge === undefined &&
            dbAutoPurge === 'true'),
        immediatePurge:
          filteredSettings.autoKeyManagementImmediatePurge === 'true' ||
          (filteredSettings.autoKeyManagementImmediatePurge === undefined &&
            dbImmediatePurge === 'true'),
      });
      logger.debug('✅ Auto key repair settings updated');
    }

    const inactiveNodeSettings = [
      'inactiveNodeThresholdHours',
      'inactiveNodeCheckIntervalMinutes',
      'inactiveNodeCooldownHours',
    ];
    const inactiveNodeSettingsChanged = inactiveNodeSettings.some((key) => key in filteredSettings);
    if (inactiveNodeSettingsChanged) {
      const dbThreshold = await databaseService.settings.getSetting('inactiveNodeThresholdHours');
      const dbCheckInterval = await databaseService.settings.getSetting('inactiveNodeCheckIntervalMinutes');
      const dbCooldown = await databaseService.settings.getSetting('inactiveNodeCooldownHours');
      const threshold = parseInt(
        filteredSettings.inactiveNodeThresholdHours ||
          dbThreshold ||
          '24',
        10
      );
      const checkInterval = parseInt(
        filteredSettings.inactiveNodeCheckIntervalMinutes ||
          dbCheckInterval ||
          '60',
        10
      );
      const cooldown = parseInt(
        filteredSettings.inactiveNodeCooldownHours ||
          dbCooldown ||
          '24',
        10
      );

      if (!isNaN(threshold) && threshold > 0 && !isNaN(checkInterval) && checkInterval > 0 && !isNaN(cooldown) && cooldown > 0) {
        callbacks.stopInactiveNodeService?.();
        callbacks.restartInactiveNodeService?.(threshold, checkInterval, cooldown);
        logger.debug(
          `✅ Inactive node notification service restarted (threshold: ${threshold}h, check: ${checkInterval}min, cooldown: ${cooldown}h)`
        );
      }
    }

    const lowBatterySettings = [
      'lowBatteryCheckIntervalMinutes',
      'lowBatteryCooldownHours',
    ];
    const lowBatterySettingsChanged = lowBatterySettings.some((key) => key in filteredSettings);
    if (lowBatterySettingsChanged) {
      const dbCheckInterval = await databaseService.settings.getSetting('lowBatteryCheckIntervalMinutes');
      const dbCooldown = await databaseService.settings.getSetting('lowBatteryCooldownHours');
      const checkInterval = parseInt(
        filteredSettings.lowBatteryCheckIntervalMinutes ||
          dbCheckInterval ||
          '60',
        10
      );
      const cooldown = parseInt(
        filteredSettings.lowBatteryCooldownHours ||
          dbCooldown ||
          '24',
        10
      );

      if (!isNaN(checkInterval) && checkInterval > 0 && !isNaN(cooldown) && cooldown > 0) {
        callbacks.stopLowBatteryService?.();
        callbacks.restartLowBatteryService?.(checkInterval, cooldown);
        logger.debug(
          `✅ Low battery notification service restarted (check: ${checkInterval}min, cooldown: ${cooldown}h)`
        );
      }
    }

    // ATAK/CoT Phase 3 (issue #3691): global singleton (this code path only
    // runs for global saves — the `if (sourceId)` branch above returns
    // early). A single restart callback covers both the enable-toggle and a
    // port change; restartCotFeed internally calls
    // cotFeedService.startFromSettings(), which stops the feed when
    // disabled, so stopCotFeed is invoked too only for symmetry/explicitness.
    const cotFeedSettings = ['cotFeedEnabled', 'cotFeedPort'];
    const cotFeedSettingsChanged = cotFeedSettings.some((key) => key in filteredSettings);
    if (cotFeedSettingsChanged) {
      callbacks.restartCotFeed?.();
      logger.debug('✅ CoT feed server settings applied');
    }

    const announceSettings = [
      'autoAnnounceEnabled',
      'autoAnnounceIntervalHours',
      'autoAnnounceUseSchedule',
      'autoAnnounceSchedule',
    ];
    const announceSettingsChanged = announceSettings.some((key) => key in filteredSettings);
    if (announceSettingsChanged) {
      callbacks.restartAnnounceScheduler?.(null);
    }

    if ('timerTriggers' in filteredSettings) {
      callbacks.restartTimerScheduler?.(null);
    }

    if ('geofenceTriggers' in filteredSettings) {
      callbacks.restartGeofenceEngine?.(null);
    }

    // Auto-delete-by-distance is per-source only (#3901). A global (null-source)
    // save persists the keys but drives no scheduler — every source owns its own
    // via its manager lifecycle + the per-source branch above.

    // Audit log with before/after values.
    // Allowlist check is explicit here so static analyzers can see that
    // `key` cannot be an attacker-controlled property name like `__proto__`.
    const validKeySet = new Set<string>(VALID_SETTINGS_KEYS as readonly string[]);
    const changedSettings: Record<string, { before: string | undefined; after: string }> = {};
    Object.keys(filteredSettings).forEach((key) => {
      if (!validKeySet.has(key)) return;
      if (currentSettings[key] !== filteredSettings[key]) {
        Object.defineProperty(changedSettings, key, {
          value: { before: currentSettings[key], after: filteredSettings[key] },
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    });

    if (Object.keys(changedSettings).length > 0) {
      void databaseService.auditLogAsync(
        req.user!.id,
        'settings_updated',
        'settings',
        JSON.stringify({ keys: Object.keys(changedSettings) }),
        req.ip || null,
        JSON.stringify(Object.fromEntries(Object.entries(changedSettings).map(([k, v]) => [k, v.before]))),
        JSON.stringify(Object.fromEntries(Object.entries(changedSettings).map(([k, v]) => [k, v.after])))
      );
    }

    // Reschedule security digest if any digest setting changed
    if (Object.keys(filteredSettings).some(k => k.startsWith('securityDigest'))) {
      securityDigestService.reschedule();
    }

    res.json({ success: true, settings: filteredSettings });
  } catch (error) {
    logger.error('Error saving settings:', error);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// POST /settings/test-apprise — probe an Apprise API server URL (#3012).
// If `url` is supplied in the body, that URL is tested directly (so admins can
// validate a value before saving it). Otherwise the currently-saved global
// setting is used, falling back to the same precedence as the resolver
// (APPRISE_URL env / bundled http://localhost:8000).
export const MAX_APPRISE_PROBE_URL_LENGTH = 2048;

// Hostnames/IPs that resolve to cloud Instance Metadata Service endpoints.
// Even though this route is admin-only and never returns the upstream body,
// allowing `fetch()` at these hosts gives a stolen settings:write token a
// reliable SSRF primitive against AWS/GCP/Azure IMDS. Block them by name and
// by the 169.254.0.0/16 link-local range that backs the IPv4 IMDS.
const BLOCKED_APPRISE_PROBE_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.azure.com',
]);

function isBlockedAppriseProbeHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (BLOCKED_APPRISE_PROBE_HOSTNAMES.has(h)) return true;
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return false;
}

export interface AppriseProbeUrlValidation {
  ok: boolean;
  error?: string;
  probeUrl?: string;
}

export function validateAppriseProbeUrl(raw: string): AppriseProbeUrlValidation {
  if (raw.length === 0) return { ok: false, error: 'URL is required' };
  if (raw.length > MAX_APPRISE_PROBE_URL_LENGTH) return { ok: false, error: 'URL is too long' };
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: 'Invalid URL format' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'URL must use http:// or https://' };
  }
  if (isBlockedAppriseProbeHost(parsed.hostname)) {
    return { ok: false, error: 'Host is not permitted' };
  }
  let pathEnd = parsed.pathname.length;
  while (pathEnd > 0 && parsed.pathname.charCodeAt(pathEnd - 1) === 47 /* '/' */) {
    pathEnd--;
  }
  const probeUrl = `${parsed.origin}${parsed.pathname.slice(0, pathEnd)}/health`;
  return { ok: true, probeUrl };
}

router.post('/test-apprise', requirePermission('settings', 'write'), async (req: Request, res: Response) => {
  try {
    const requestUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';

    let target: string;
    if (requestUrl.length > 0) {
      target = requestUrl;
    } else {
      const saved = await databaseService.settings.getSetting('appriseApiServerUrl');
      target = (saved && saved.trim().length > 0)
        ? saved.trim()
        : (process.env.APPRISE_URL || 'http://localhost:8000');
    }

    const validation = validateAppriseProbeUrl(target);
    if (!validation.ok || !validation.probeUrl) {
      return res.status(400).json({ ok: false, error: validation.error || 'Invalid URL', url: target });
    }
    const probeUrl = validation.probeUrl;
    const start = Date.now();
    try {
      const response = await fetch(probeUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      const latencyMs = Date.now() - start;

      if (!response.ok) {
        return res.json({
          ok: false,
          status: response.status,
          latencyMs,
          error: `Apprise server returned HTTP ${response.status}`,
          url: target,
        });
      }

      return res.json({
        ok: true,
        status: response.status,
        latencyMs,
        url: target,
      });
    } catch (error: any) {
      const latencyMs = Date.now() - start;
      const isTimeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      const message = isTimeout
        ? 'Connection timed out after 5000ms'
        : (error?.message || String(error));
      return res.json({
        ok: false,
        latencyMs,
        error: message,
        url: target,
      });
    }
  } catch (error) {
    logger.error('Error testing Apprise connection:', error);
    res.status(500).json({ ok: false, error: 'Failed to test Apprise connection' });
  }
});

// DELETE /settings — reset to defaults
router.delete('/', requirePermission('settings', 'write'), async (req: Request, res: Response) => {
  try {
    const currentSettings = await databaseService.settings.getAllSettings();

    await databaseService.settings.deleteAllSettings();
    callbacks.setTracerouteInterval?.(0);

    void databaseService.auditLogAsync(
      req.user!.id,
      'settings_reset',
      'settings',
      'All settings reset to defaults',
      req.ip || null,
      JSON.stringify(currentSettings),
      null
    );

    res.json({ success: true, message: 'Settings reset to defaults' });
  } catch (error) {
    logger.error('Error resetting settings:', error);
    res.status(500).json({ error: 'Failed to reset settings' });
  }
});

// ─── Extracted from server.ts (#3502 PR2) ─────────────────────────────────
// The following 17 handlers were `apiRouter.*('/settings/...')` inline in
// server.ts; moved verbatim (only the leading route registration rewritten
// from `apiRouter.<m>('/settings/...')` to `router.<m>('/...')`).

router.post('/traceroute-interval', requirePermission('settings', 'write'), (req, res) => {
  try {
    const { intervalMinutes, sourceId: traceIntervalSourceId } = req.body;
    if (typeof intervalMinutes !== 'number' || intervalMinutes < 0 || intervalMinutes > 60) {
      return res.status(400).json({ error: 'Invalid interval. Must be between 0 and 60 minutes (0 = disabled).' });
    }

    const traceIntervalManager = (resolveSourceManager(traceIntervalSourceId));
    traceIntervalManager.setTracerouteInterval(intervalMinutes);
    res.json({ success: true, intervalMinutes });
  } catch (error) {
    logger.error('Error setting traceroute interval:', error);
    res.status(500).json({ error: 'Failed to set traceroute interval' });
  }
});

router.post('/remote-localstats-interval', requirePermission('settings', 'write'), (req, res) => {
  try {
    const { intervalMinutes, sourceId: rlsIntervalSourceId } = req.body;
    if (typeof intervalMinutes !== 'number' || intervalMinutes < 0 || intervalMinutes > 1440) {
      return res.status(400).json({ error: 'Invalid interval. Must be between 0 and 1440 minutes (0 = disabled).' });
    }
    const rlsIntervalManager = (resolveSourceManager(rlsIntervalSourceId));
    rlsIntervalManager.setRemoteLocalStatsInterval(intervalMinutes);
    res.json({ success: true, intervalMinutes });
  } catch (error) {
    logger.error('Error setting remote LocalStats interval:', error);
    res.status(500).json({ error: 'Failed to set remote LocalStats interval' });
  }
});

router.get('/traceroute-nodes', requirePermission('settings', 'read'), async (req, res) => {
  try {
    const traceNodesSourceId = req.query.sourceId as string | undefined;
    const settings = await databaseService.getTracerouteFilterSettingsAsync(traceNodesSourceId);
    res.json(settings);
  } catch (error) {
    logger.error('Error fetching auto-traceroute node filter:', error);
    res.status(500).json({ error: 'Failed to fetch auto-traceroute node filter' });
  }
});

router.post('/traceroute-nodes', requirePermission('settings', 'write'), async (req, res) => {
  try {
    const {
      enabled, nodeNums, filterChannels, filterRoles, filterHwModels, filterNameRegex,
      filterNodesEnabled, filterChannelsEnabled, filterRolesEnabled, filterHwModelsEnabled, filterRegexEnabled,
      expirationHours, sortByHops,
      filterLastHeardEnabled, filterLastHeardHours,
      filterHopsEnabled, filterHopsMin, filterHopsMax,
    } = req.body;

    // Validate input
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'Invalid enabled value. Must be a boolean.' });
    }

    if (!Array.isArray(nodeNums)) {
      return res.status(400).json({ error: 'Invalid nodeNums value. Must be an array.' });
    }

    // Validate all node numbers are valid integers
    for (const nodeNum of nodeNums) {
      if (!Number.isInteger(nodeNum) || nodeNum < 0) {
        return res.status(400).json({ error: 'All node numbers must be positive integers.' });
      }
    }

    // Validate optional filter arrays
    const validateIntArray = (arr: unknown, name: string): number[] => {
      if (arr === undefined || arr === null) return [];
      if (!Array.isArray(arr)) {
        throw new Error(`Invalid ${name} value. Must be an array.`);
      }
      for (const item of arr) {
        if (!Number.isInteger(item) || item < 0) {
          throw new Error(`All ${name} values must be non-negative integers.`);
        }
      }
      return arr as number[];
    };

    let validatedChannels: number[];
    let validatedRoles: number[];
    let validatedHwModels: number[];
    try {
      validatedChannels = validateIntArray(filterChannels, 'filterChannels');
      validatedRoles = validateIntArray(filterRoles, 'filterRoles');
      validatedHwModels = validateIntArray(filterHwModels, 'filterHwModels');
    } catch (error) {
      return res.status(400).json({ error: (error as Error).message });
    }

    // Current stored settings — needed to decide whether the regex must be
    // hard-validated (see validateFilterNameRegexOnSave / #3934).
    const traceNodesPostSourceId = (req.query.sourceId as string | undefined) || (req.body?.sourceId as string | undefined);
    const currentTraceSettings = await databaseService.getTracerouteFilterSettingsAsync(traceNodesPostSourceId);

    // Validate regex if provided — only hard-validate (RE2) when it will actually
    // be applied or the pattern changed, so a stored RE2-incompatible pattern
    // can't permanently brick the automation (#3934, mirrors #3806).
    let validatedRegex = '.*';
    if (filterNameRegex !== undefined && filterNameRegex !== null) {
      if (typeof filterNameRegex !== 'string') {
        return res.status(400).json({ error: 'Invalid filterNameRegex value. Must be a string.' });
      }
      const regexWillBeApplied =
        enabled &&
        (filterRegexEnabled !== undefined ? filterRegexEnabled === true : currentTraceSettings.filterRegexEnabled);
      const regexResult = validateFilterNameRegexOnSave(filterNameRegex, {
        willBeApplied: regexWillBeApplied,
        storedRegex: currentTraceSettings.filterNameRegex,
      });
      if ('error' in regexResult) {
        return res.status(400).json({ error: regexResult.error });
      }
      validatedRegex = regexResult.regex;
    }

    // Validate individual filter enabled flags (optional booleans, default to true)
    const validateOptionalBoolean = (value: unknown, name: string): boolean | undefined => {
      if (value === undefined) return undefined;
      if (typeof value !== 'boolean') {
        throw new Error(`Invalid ${name} value. Must be a boolean.`);
      }
      return value;
    };

    let validatedFilterNodesEnabled: boolean | undefined;
    let validatedFilterChannelsEnabled: boolean | undefined;
    let validatedFilterRolesEnabled: boolean | undefined;
    let validatedFilterHwModelsEnabled: boolean | undefined;
    let validatedFilterRegexEnabled: boolean | undefined;
    let validatedSortByHops: boolean | undefined;
    try {
      validatedFilterNodesEnabled = validateOptionalBoolean(filterNodesEnabled, 'filterNodesEnabled');
      validatedFilterChannelsEnabled = validateOptionalBoolean(filterChannelsEnabled, 'filterChannelsEnabled');
      validatedFilterRolesEnabled = validateOptionalBoolean(filterRolesEnabled, 'filterRolesEnabled');
      validatedFilterHwModelsEnabled = validateOptionalBoolean(filterHwModelsEnabled, 'filterHwModelsEnabled');
      validatedFilterRegexEnabled = validateOptionalBoolean(filterRegexEnabled, 'filterRegexEnabled');
      validatedSortByHops = validateOptionalBoolean(sortByHops, 'sortByHops');
    } catch (error) {
      return res.status(400).json({ error: (error as Error).message });
    }

    // Validate expirationHours (optional, must be an integer between 0 and 168; 0 = always retraceroute)
    let validatedExpirationHours: number | undefined;
    if (expirationHours !== undefined) {
      if (!Number.isInteger(expirationHours) || expirationHours < 0 || expirationHours > 168) {
        return res.status(400).json({ error: 'Invalid expirationHours value. Must be an integer between 0 and 168.' });
      }
      validatedExpirationHours = expirationHours;
    }

    // Validate filterLastHeardEnabled (optional boolean)
    let validatedFilterLastHeardEnabled: boolean | undefined;
    try {
      validatedFilterLastHeardEnabled = validateOptionalBoolean(filterLastHeardEnabled, 'filterLastHeardEnabled');
    } catch (error) {
      return res.status(400).json({ error: (error as Error).message });
    }

    // Validate filterLastHeardHours (optional, must be integer >= 1)
    let validatedFilterLastHeardHours: number | undefined;
    if (filterLastHeardHours !== undefined) {
      if (!Number.isInteger(filterLastHeardHours) || filterLastHeardHours < 1) {
        return res.status(400).json({ error: 'Invalid filterLastHeardHours value. Must be an integer >= 1.' });
      }
      validatedFilterLastHeardHours = filterLastHeardHours;
    }

    // Validate filterHopsEnabled (optional boolean)
    let validatedFilterHopsEnabled: boolean | undefined;
    try {
      validatedFilterHopsEnabled = validateOptionalBoolean(filterHopsEnabled, 'filterHopsEnabled');
    } catch (error) {
      return res.status(400).json({ error: (error as Error).message });
    }

    // Validate filterHopsMin/Max (optional, must be integers >= 0, min <= max)
    let validatedFilterHopsMin: number | undefined;
    let validatedFilterHopsMax: number | undefined;
    if (filterHopsMin !== undefined) {
      if (!Number.isInteger(filterHopsMin) || filterHopsMin < 0) {
        return res.status(400).json({ error: 'Invalid filterHopsMin value. Must be a non-negative integer.' });
      }
      validatedFilterHopsMin = filterHopsMin;
    }
    if (filterHopsMax !== undefined) {
      if (!Number.isInteger(filterHopsMax) || filterHopsMax < 0) {
        return res.status(400).json({ error: 'Invalid filterHopsMax value. Must be a non-negative integer.' });
      }
      validatedFilterHopsMax = filterHopsMax;
    }
    if (validatedFilterHopsMin !== undefined && validatedFilterHopsMax !== undefined && validatedFilterHopsMin > validatedFilterHopsMax) {
      return res.status(400).json({ error: 'filterHopsMin cannot be greater than filterHopsMax.' });
    }

    // Update all settings (scoped to source when provided; sourceId resolved above)
    await databaseService.setTracerouteFilterSettingsAsync({
      enabled,
      nodeNums,
      filterChannels: validatedChannels,
      filterRoles: validatedRoles,
      filterHwModels: validatedHwModels,
      filterNameRegex: validatedRegex,
      filterNodesEnabled: validatedFilterNodesEnabled,
      filterChannelsEnabled: validatedFilterChannelsEnabled,
      filterRolesEnabled: validatedFilterRolesEnabled,
      filterHwModelsEnabled: validatedFilterHwModelsEnabled,
      filterRegexEnabled: validatedFilterRegexEnabled,
      expirationHours: validatedExpirationHours,
      sortByHops: validatedSortByHops,
      filterLastHeardEnabled: validatedFilterLastHeardEnabled,
      filterLastHeardHours: validatedFilterLastHeardHours,
      filterHopsEnabled: validatedFilterHopsEnabled,
      filterHopsMin: validatedFilterHopsMin,
      filterHopsMax: validatedFilterHopsMax,
    }, traceNodesPostSourceId);

    // Get the updated settings to return (includes resolved default values)
    const updatedSettings = await databaseService.getTracerouteFilterSettingsAsync(traceNodesPostSourceId);

    res.json({
      success: true,
      ...updatedSettings,
    });
  } catch (error) {
    logger.error('Error updating auto-traceroute node filter:', error);
    res.status(500).json({ error: 'Failed to update auto-traceroute node filter' });
  }
});

router.get('/remote-localstats-nodes', requirePermission('settings', 'read'), async (req, res) => {
  try {
    const sourceId = req.query.sourceId as string | undefined;
    const settings = await databaseService.getRemoteLocalStatsFilterSettingsAsync(sourceId);
    res.json(settings);
  } catch (error) {
    logger.error('Error fetching remote LocalStats node filter:', error);
    res.status(500).json({ error: 'Failed to fetch remote LocalStats node filter' });
  }
});

router.post('/remote-localstats-nodes', requirePermission('settings', 'write'), async (req, res) => {
  try {
    const {
      enabled, nodeNums, filterRoles, filterNameRegex,
      filterNodesEnabled, filterRolesEnabled, filterFavoriteEnabled, filterRegexEnabled,
      filterLastHeardEnabled, filterLastHeardHours,
    } = req.body;

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'Invalid enabled value. Must be a boolean.' });
    }
    if (!Array.isArray(nodeNums)) {
      return res.status(400).json({ error: 'Invalid nodeNums value. Must be an array.' });
    }
    for (const nodeNum of nodeNums) {
      if (!Number.isInteger(nodeNum) || nodeNum < 0) {
        return res.status(400).json({ error: 'All node numbers must be positive integers.' });
      }
    }

    const validateIntArray = (arr: unknown, name: string): number[] => {
      if (arr === undefined || arr === null) return [];
      if (!Array.isArray(arr)) {
        throw new Error(`Invalid ${name} value. Must be an array.`);
      }
      for (const item of arr) {
        if (!Number.isInteger(item) || item < 0) {
          throw new Error(`All ${name} values must be non-negative integers.`);
        }
      }
      return arr as number[];
    };

    let validatedRoles: number[];
    try {
      validatedRoles = validateIntArray(filterRoles, 'filterRoles');
    } catch (error) {
      return res.status(400).json({ error: (error as Error).message });
    }

    // sourceId is required here; resolve it up-front so we can read the current
    // stored settings for the regex guard below.
    const sourceId = (req.query.sourceId as string | undefined) || (req.body?.sourceId as string | undefined);
    if (!sourceId) {
      return res.status(400).json({ error: 'sourceId is required for remote LocalStats filter settings.' });
    }
    const currentRemoteSettings = await databaseService.getRemoteLocalStatsFilterSettingsAsync(sourceId);

    // Validate regex — only hard-validate (RE2) when it will actually be applied
    // or the pattern changed, so a stored RE2-incompatible pattern can't
    // permanently brick the automation (#3934, mirrors #3806).
    let validatedRegex = '.*';
    if (filterNameRegex !== undefined && filterNameRegex !== null) {
      if (typeof filterNameRegex !== 'string') {
        return res.status(400).json({ error: 'Invalid filterNameRegex value. Must be a string.' });
      }
      const regexWillBeApplied =
        enabled &&
        (filterRegexEnabled !== undefined ? filterRegexEnabled === true : currentRemoteSettings.filterRegexEnabled);
      const regexResult = validateFilterNameRegexOnSave(filterNameRegex, {
        willBeApplied: regexWillBeApplied,
        storedRegex: currentRemoteSettings.filterNameRegex,
      });
      if ('error' in regexResult) {
        return res.status(400).json({ error: regexResult.error });
      }
      validatedRegex = regexResult.regex;
    }

    const validateOptionalBoolean = (value: unknown, name: string): boolean | undefined => {
      if (value === undefined) return undefined;
      if (typeof value !== 'boolean') {
        throw new Error(`Invalid ${name} value. Must be a boolean.`);
      }
      return value;
    };

    let validatedFilterNodesEnabled: boolean | undefined;
    let validatedFilterRolesEnabled: boolean | undefined;
    let validatedFilterFavoriteEnabled: boolean | undefined;
    let validatedFilterRegexEnabled: boolean | undefined;
    let validatedFilterLastHeardEnabled: boolean | undefined;
    try {
      validatedFilterNodesEnabled = validateOptionalBoolean(filterNodesEnabled, 'filterNodesEnabled');
      validatedFilterRolesEnabled = validateOptionalBoolean(filterRolesEnabled, 'filterRolesEnabled');
      validatedFilterFavoriteEnabled = validateOptionalBoolean(filterFavoriteEnabled, 'filterFavoriteEnabled');
      validatedFilterRegexEnabled = validateOptionalBoolean(filterRegexEnabled, 'filterRegexEnabled');
      validatedFilterLastHeardEnabled = validateOptionalBoolean(filterLastHeardEnabled, 'filterLastHeardEnabled');
    } catch (error) {
      return res.status(400).json({ error: (error as Error).message });
    }

    let validatedFilterLastHeardHours: number | undefined;
    if (filterLastHeardHours !== undefined) {
      if (!Number.isInteger(filterLastHeardHours) || filterLastHeardHours < 1) {
        return res.status(400).json({ error: 'Invalid filterLastHeardHours value. Must be an integer >= 1.' });
      }
      validatedFilterLastHeardHours = filterLastHeardHours;
    }

    await databaseService.setRemoteLocalStatsFilterSettingsAsync({
      enabled,
      nodeNums,
      filterRoles: validatedRoles,
      filterNameRegex: validatedRegex,
      filterNodesEnabled: validatedFilterNodesEnabled,
      filterRolesEnabled: validatedFilterRolesEnabled,
      filterFavoriteEnabled: validatedFilterFavoriteEnabled,
      filterRegexEnabled: validatedFilterRegexEnabled,
      filterLastHeardEnabled: validatedFilterLastHeardEnabled,
      filterLastHeardHours: validatedFilterLastHeardHours,
    }, sourceId);

    const updatedSettings = await databaseService.getRemoteLocalStatsFilterSettingsAsync(sourceId);
    res.json({ success: true, ...updatedSettings });
  } catch (error) {
    logger.error('Error updating remote LocalStats node filter:', error);
    res.status(500).json({ error: 'Failed to update remote LocalStats node filter' });
  }
});

router.get('/traceroute-log', requirePermission('settings', 'read'), async (req, res) => {
  try {
    const traceLogSourceId = req.query.sourceId as string | undefined;
    const log = await databaseService.getAutoTracerouteLogAsync(10, traceLogSourceId);
    res.json({
      success: true,
      log,
    });
  } catch (error) {
    logger.error('Error fetching auto-traceroute log:', error);
    res.status(500).json({ error: 'Failed to fetch auto-traceroute log' });
  }
});

router.get('/time-sync-nodes', requirePermission('settings', 'read'), async (req, res) => {
  try {
    const sourceId = (req.query.sourceId as string | undefined) || undefined;
    const settings = await databaseService.getTimeSyncFilterSettingsAsync(sourceId);
    res.json(settings);
  } catch (error) {
    logger.error('Error fetching auto time sync settings:', error);
    res.status(500).json({ error: 'Failed to fetch auto time sync settings' });
  }
});

router.post('/time-sync-nodes', requirePermission('settings', 'write'), async (req, res) => {
  try {
    const { enabled, nodeNums, filterEnabled, expirationHours, intervalMinutes } = req.body;
    const sourceId = (req.query.sourceId as string | undefined) || (req.body.sourceId as string | undefined) || undefined;

    // Validate input
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'Invalid enabled value. Must be a boolean.' });
    }

    if (nodeNums !== undefined && !Array.isArray(nodeNums)) {
      return res.status(400).json({ error: 'Invalid nodeNums value. Must be an array.' });
    }

    // Validate all node numbers are valid integers
    if (nodeNums) {
      for (const nodeNum of nodeNums) {
        if (!Number.isInteger(nodeNum) || nodeNum < 0) {
          return res.status(400).json({ error: 'All node numbers must be positive integers.' });
        }
      }
    }

    if (filterEnabled !== undefined && typeof filterEnabled !== 'boolean') {
      return res.status(400).json({ error: 'Invalid filterEnabled value. Must be a boolean.' });
    }

    if (expirationHours !== undefined) {
      const hours = Number(expirationHours);
      if (!Number.isInteger(hours) || hours < 1 || hours > 24) {
        return res.status(400).json({ error: 'Expiration hours must be an integer between 1 and 24.' });
      }
    }

    if (intervalMinutes !== undefined) {
      const minutes = Number(intervalMinutes);
      if (!Number.isInteger(minutes) || (minutes !== 0 && (minutes < 15 || minutes > 1440))) {
        return res.status(400).json({ error: 'Interval must be 0 (disabled) or between 15 and 1440 minutes.' });
      }
    }

    // Update settings
    await databaseService.setTimeSyncFilterSettingsAsync({
      enabled,
      nodeNums,
      filterEnabled,
      expirationHours: expirationHours !== undefined ? Number(expirationHours) : undefined,
      intervalMinutes: intervalMinutes !== undefined ? Number(intervalMinutes) : undefined,
    }, sourceId);

    // Update the meshtastic manager interval if connected
    const timeSyncSourceId = sourceId;
    const timeSyncManager = resolveSourceManager(timeSyncSourceId);
    if (intervalMinutes !== undefined) {
      timeSyncManager.setTimeSyncInterval(enabled ? Number(intervalMinutes) : 0);
    } else if (enabled !== undefined) {
      // If only enabled/disabled changed, use existing interval (per-source with global fallback)
      const intervalStr = await databaseService.settings.getSettingForSource(timeSyncSourceId ?? null, 'autoTimeSyncIntervalMinutes');
      const parsed = intervalStr ? parseInt(intervalStr, 10) : NaN;
      const currentInterval = isNaN(parsed) ? 15 : parsed;
      timeSyncManager.setTimeSyncInterval(enabled ? currentInterval : 0);
    }

    // Get the updated settings to return
    const updatedSettings = await databaseService.getTimeSyncFilterSettingsAsync(sourceId);

    res.json({
      success: true,
      ...updatedSettings,
    });
  } catch (error) {
    logger.error('Error updating auto time sync settings:', error);
    res.status(500).json({ error: 'Failed to update auto time sync settings' });
  }
});

router.get('/auto-ping', requirePermission('settings', 'read'), async (req, res) => {
  try {
    const autoPingSourceId = req.query.sourceId as string | undefined;
    const autoPingManager = resolveSourceManager(autoPingSourceId);
    // Per-source settings layered on top of globals (source override wins)
    const sourceOverrides = autoPingSourceId
      ? await databaseService.settings.getSourceSettings(autoPingSourceId)
      : {};
    const readSetting = async (key: string): Promise<string | null> => {
      if (key in sourceOverrides) return sourceOverrides[key];
      return await databaseService.settings.getSetting(key);
    };
    const settings = {
      autoPingEnabled: (await readSetting('autoPingEnabled')) === 'true',
      autoPingIntervalSeconds: parseInt((await readSetting('autoPingIntervalSeconds')) || '30', 10),
      autoPingMaxPings: parseInt((await readSetting('autoPingMaxPings')) || '20', 10),
      autoPingTimeoutSeconds: parseInt((await readSetting('autoPingTimeoutSeconds')) || '60', 10),
    };
    const sessions = await autoPingManager.getAutoPingSessions();
    res.json({ settings, sessions });
  } catch (error) {
    logger.error('Error fetching auto-ping settings:', error);
    res.status(500).json({ error: 'Failed to fetch auto-ping settings' });
  }
});

router.post('/auto-ping', requirePermission('settings', 'write'), async (req, res) => {
  try {
    const { autoPingEnabled, autoPingIntervalSeconds, autoPingMaxPings, autoPingTimeoutSeconds } = req.body;
    const autoPingSourceId = req.query.sourceId as string | undefined;
    const writeSetting = async (key: string, value: string) => {
      if (autoPingSourceId) {
        await databaseService.settings.setSourceSetting(autoPingSourceId, key, value);
      } else {
        await databaseService.settings.setSetting(key, value);
      }
    };
    const sourceOverrides = autoPingSourceId
      ? await databaseService.settings.getSourceSettings(autoPingSourceId)
      : {};
    const readSetting = async (key: string): Promise<string | null> => {
      if (key in sourceOverrides) return sourceOverrides[key];
      return await databaseService.settings.getSetting(key);
    };

    if (autoPingEnabled !== undefined) {
      await writeSetting('autoPingEnabled', String(autoPingEnabled));
      sourceOverrides['autoPingEnabled'] = String(autoPingEnabled);
    }
    if (autoPingIntervalSeconds !== undefined) {
      const val = parseInt(String(autoPingIntervalSeconds), 10);
      if (isNaN(val) || val < 10) {
        return res.status(400).json({ error: 'Interval must be at least 10 seconds.' });
      }
      await writeSetting('autoPingIntervalSeconds', String(val));
      sourceOverrides['autoPingIntervalSeconds'] = String(val);
    }
    if (autoPingMaxPings !== undefined) {
      const val = parseInt(String(autoPingMaxPings), 10);
      if (isNaN(val) || val < 1 || val > 100) {
        return res.status(400).json({ error: 'Max pings must be between 1 and 100.' });
      }
      await writeSetting('autoPingMaxPings', String(val));
      sourceOverrides['autoPingMaxPings'] = String(val);
    }
    if (autoPingTimeoutSeconds !== undefined) {
      const val = parseInt(String(autoPingTimeoutSeconds), 10);
      if (isNaN(val) || val < 10) {
        return res.status(400).json({ error: 'Timeout must be at least 10 seconds.' });
      }
      await writeSetting('autoPingTimeoutSeconds', String(val));
      sourceOverrides['autoPingTimeoutSeconds'] = String(val);
    }

    const settings = {
      autoPingEnabled: (await readSetting('autoPingEnabled')) === 'true',
      autoPingIntervalSeconds: parseInt((await readSetting('autoPingIntervalSeconds')) || '30', 10),
      autoPingMaxPings: parseInt((await readSetting('autoPingMaxPings')) || '20', 10),
      autoPingTimeoutSeconds: parseInt((await readSetting('autoPingTimeoutSeconds')) || '60', 10),
    };

    res.json({ success: true, settings });
  } catch (error) {
    logger.error('Error updating auto-ping settings:', error);
    res.status(500).json({ error: 'Failed to update auto-ping settings' });
  }
});

router.get('/key-repair-log', requirePermission('settings', 'read'), async (req, res) => {
  try {
    const krSourceId = req.query.sourceId as string | undefined;
    const log = await databaseService.getKeyRepairLogAsync(50, krSourceId);
    res.json({
      success: true,
      log,
    });
  } catch (error) {
    logger.error('Error fetching auto key repair log:', error);
    res.status(500).json({ error: 'Failed to fetch auto key repair log' });
  }
});

router.get('/distance-delete/log', requirePermission('settings', 'read'), async (req, res) => {
  try {
    const distLogSourceId = req.query.sourceId as string | undefined;
    const entries = await databaseService.distanceDeleteLog.getDistanceDeleteLog(10, distLogSourceId);
    res.json(entries);
  } catch (error) {
    logger.error('Error fetching distance-delete log:', error);
    res.status(500).json({ error: 'Failed to fetch log' });
  }
});

router.post('/distance-delete/run-now', requirePermission('settings', 'write'), async (req, res) => {
  try {
    const distDelSourceId =
      (req.body && req.body.sourceId) ||
      (req.query.sourceId as string | undefined) ||
      undefined;
    const result = await autoDeleteByDistanceService.runNow(distDelSourceId);
    res.json(result);
  } catch (error) {
    logger.error('Error running distance-delete:', error);
    res.status(500).json({ error: 'Failed to run distance delete' });
  }
});

router.get('/position-estimation/status', requirePermission('settings', 'read'), async (_req, res) => {
  try {
    const status = await positionEstimationScheduler.getStatus();
    res.json(status);
  } catch (error) {
    logger.error('Error fetching position estimation status:', error);
    res.status(500).json({ error: 'Failed to fetch position estimation status' });
  }
});

router.post('/position-estimation/run-now', requirePermission('settings', 'write'), async (req, res) => {
  try {
    const result = await positionEstimationScheduler.runNow();
    void databaseService.auditLogAsync(
      req.user!.id,
      'position_estimation_run',
      'settings',
      `Ran position estimation: ${result.estimatedNodeCount} node(s) estimated`,
      req.ip || null,
      null,
      JSON.stringify(result)
    );
    res.json(result);
  } catch (error) {
    logger.error('Error running position estimation:', error);
    const message = error instanceof Error && /in progress/.test(error.message)
      ? 'Position estimation already in progress'
      : 'Failed to run position estimation';
    res.status(message.includes('in progress') ? 409 : 500).json({ error: message });
  }
});

router.post('/mark-all-welcomed', requirePermission('settings', 'write'), async (req, res) => {
  try {
    const sourceId = (req.query.sourceId as string | undefined) ?? (req.body?.sourceId as string | undefined) ?? null;
    const count = await databaseService.markAllNodesAsWelcomedAsync(sourceId);
    logger.debug(`👋 Manually marked ${count} nodes as welcomed via API${sourceId ? ` (source=${sourceId})` : ''}`);

    // Audit log
    void databaseService.auditLogAsync(
      req.user!.id,
      'mark_all_welcomed',
      'nodes',
      `Marked ${count} nodes as welcomed${sourceId ? ` for source ${sourceId}` : ''}`,
      req.ip || null,
      null,
      JSON.stringify({ count, sourceId })
    );

    res.json({ success: true, count, message: `Marked ${count} nodes as welcomed` });
  } catch (error) {
    logger.error('Error marking all nodes as welcomed:', error);
    res.status(500).json({ error: 'Failed to mark nodes as welcomed' });
  }
});

export default router;
