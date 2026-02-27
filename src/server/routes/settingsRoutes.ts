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
import { VALID_SETTINGS_KEYS } from '../constants/settings.js';

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

// ─── Side-effect callbacks ───────────────────────────────────────────────
// These are injected by server.ts so the route handler doesn't directly
// depend on meshtasticManager / inactiveNodeNotificationService / etc.

export interface SettingsCallbacks {
  refreshTileHostnameCache?: () => void;
  setTracerouteInterval?: (interval: number) => void;
  setRemoteAdminScannerInterval?: (interval: number) => void;
  setLocalStatsInterval?: (interval: number) => void;
  setKeyRepairSettings?: (settings: {
    enabled: boolean;
    intervalMinutes: number;
    maxExchanges: number;
    autoPurge: boolean;
  }) => void;
  restartInactiveNodeService?: (threshold: number, check: number, cooldown: number) => void;
  stopInactiveNodeService?: () => void;
  restartAnnounceScheduler?: () => void;
  restartTimerScheduler?: () => void;
  restartGeofenceEngine?: () => void;
  handleAutoWelcomeEnabled?: () => number;
}

let callbacks: SettingsCallbacks = {};

export function setSettingsCallbacks(cb: SettingsCallbacks): void {
  callbacks = cb;
}

// ─── Router ──────────────────────────────────────────────────────────────

const router = Router();

// GET /settings — read all settings (public)
router.get('/', optionalAuth(), (_req: Request, res: Response) => {
  try {
    const settings = databaseService.getAllSettings();
    res.json(settings);
  } catch (error) {
    logger.error('Error fetching settings:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// POST /settings — save settings
router.post('/', requirePermission('settings', 'write'), (req: Request, res: Response) => {
  try {
    const settings = req.body;

    // Get current settings for before/after comparison
    const currentSettings = databaseService.getAllSettings();

    // Validate settings
    const filteredSettings: Record<string, string> = {};

    for (const key of VALID_SETTINGS_KEYS) {
      if (key in settings) {
        filteredSettings[key] = String(settings[key]);
      }
    }

    // Validate autoAckRegex pattern
    if ('autoAckRegex' in filteredSettings) {
      const pattern = filteredSettings.autoAckRegex;

      if (pattern.length > 100) {
        return res.status(400).json({ error: 'Regex pattern too long (max 100 characters)' });
      }

      if (/(\.\*){2,}|(\+.*\+)|(\*.*\*)|(\{[0-9]{3,}\})|(\{[0-9]+,\})/.test(pattern)) {
        return res.status(400).json({ error: 'Regex pattern too complex or may cause performance issues' });
      }

      try {
        new RegExp(pattern, 'i');
      } catch (error) {
        return res.status(400).json({ error: 'Invalid regex syntax' });
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

    // Validate autoResponderTriggers JSON
    if ('autoResponderTriggers' in filteredSettings) {
      try {
        const triggers = JSON.parse(filteredSettings.autoResponderTriggers);

        if (!Array.isArray(triggers)) {
          return res.status(400).json({ error: 'autoResponderTriggers must be an array' });
        }

        for (const trigger of triggers) {
          if (!trigger.id || !trigger.trigger || !trigger.responseType || !trigger.response) {
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
            trigger.responseType !== 'script'
          ) {
            return res.status(400).json({ error: 'responseType must be "text", "http", or "script"' });
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

    // Save to database
    databaseService.setSettings(filteredSettings);

    // ─── Side effects ───────────────────────────────────────────────────
    if ('customTilesets' in filteredSettings) {
      callbacks.refreshTileHostnameCache?.();
      logger.debug('🗺️ Refreshed CSP tile hostname cache after customTilesets update');
    }

    if ('autoWelcomeEnabled' in filteredSettings) {
      const wasEnabled = currentSettings['autoWelcomeEnabled'] === 'true';
      const nowEnabled = filteredSettings['autoWelcomeEnabled'] === 'true';
      if (!wasEnabled && nowEnabled) {
        logger.info('👋 Auto-welcome being enabled - marking existing nodes as welcomed...');
        const markedCount = callbacks.handleAutoWelcomeEnabled?.() ?? 0;
        if (markedCount > 0) {
          logger.info(`✅ Marked ${markedCount} existing node(s) as welcomed to prevent spam`);
        }
      }
    }

    if ('tracerouteIntervalMinutes' in filteredSettings) {
      const interval = parseInt(filteredSettings.tracerouteIntervalMinutes);
      if (!isNaN(interval) && interval >= 0 && interval <= 60) {
        callbacks.setTracerouteInterval?.(interval);
      }
    }

    if ('remoteAdminScannerIntervalMinutes' in filteredSettings) {
      const interval = parseInt(filteredSettings.remoteAdminScannerIntervalMinutes);
      if (!isNaN(interval) && interval >= 0 && interval <= 60) {
        callbacks.setRemoteAdminScannerInterval?.(interval);
      }
    }

    if ('localStatsIntervalMinutes' in filteredSettings) {
      const interval = parseInt(filteredSettings.localStatsIntervalMinutes);
      if (!isNaN(interval) && interval >= 0 && interval <= 60) {
        callbacks.setLocalStatsInterval?.(interval);
      }
    }

    const keyRepairSettings = [
      'autoKeyManagementEnabled',
      'autoKeyManagementIntervalMinutes',
      'autoKeyManagementMaxExchanges',
      'autoKeyManagementAutoPurge',
    ];
    const keyRepairSettingsChanged = keyRepairSettings.some((key) => key in filteredSettings);
    if (keyRepairSettingsChanged) {
      callbacks.setKeyRepairSettings?.({
        enabled:
          filteredSettings.autoKeyManagementEnabled === 'true' ||
          (filteredSettings.autoKeyManagementEnabled === undefined &&
            databaseService.getSetting('autoKeyManagementEnabled') === 'true'),
        intervalMinutes: parseInt(
          filteredSettings.autoKeyManagementIntervalMinutes ||
            databaseService.getSetting('autoKeyManagementIntervalMinutes') ||
            '5'
        ),
        maxExchanges: parseInt(
          filteredSettings.autoKeyManagementMaxExchanges ||
            databaseService.getSetting('autoKeyManagementMaxExchanges') ||
            '3'
        ),
        autoPurge:
          filteredSettings.autoKeyManagementAutoPurge === 'true' ||
          (filteredSettings.autoKeyManagementAutoPurge === undefined &&
            databaseService.getSetting('autoKeyManagementAutoPurge') === 'true'),
      });
      logger.info('✅ Auto key repair settings updated');
    }

    const inactiveNodeSettings = [
      'inactiveNodeThresholdHours',
      'inactiveNodeCheckIntervalMinutes',
      'inactiveNodeCooldownHours',
    ];
    const inactiveNodeSettingsChanged = inactiveNodeSettings.some((key) => key in filteredSettings);
    if (inactiveNodeSettingsChanged) {
      const threshold = parseInt(
        filteredSettings.inactiveNodeThresholdHours ||
          databaseService.getSetting('inactiveNodeThresholdHours') ||
          '24',
        10
      );
      const checkInterval = parseInt(
        filteredSettings.inactiveNodeCheckIntervalMinutes ||
          databaseService.getSetting('inactiveNodeCheckIntervalMinutes') ||
          '60',
        10
      );
      const cooldown = parseInt(
        filteredSettings.inactiveNodeCooldownHours ||
          databaseService.getSetting('inactiveNodeCooldownHours') ||
          '24',
        10
      );

      if (!isNaN(threshold) && threshold > 0 && !isNaN(checkInterval) && checkInterval > 0 && !isNaN(cooldown) && cooldown > 0) {
        callbacks.stopInactiveNodeService?.();
        callbacks.restartInactiveNodeService?.(threshold, checkInterval, cooldown);
        logger.info(
          `✅ Inactive node notification service restarted (threshold: ${threshold}h, check: ${checkInterval}min, cooldown: ${cooldown}h)`
        );
      }
    }

    const announceSettings = [
      'autoAnnounceEnabled',
      'autoAnnounceIntervalHours',
      'autoAnnounceUseSchedule',
      'autoAnnounceSchedule',
    ];
    const announceSettingsChanged = announceSettings.some((key) => key in filteredSettings);
    if (announceSettingsChanged) {
      callbacks.restartAnnounceScheduler?.();
    }

    if ('timerTriggers' in filteredSettings) {
      callbacks.restartTimerScheduler?.();
    }

    if ('geofenceTriggers' in filteredSettings) {
      callbacks.restartGeofenceEngine?.();
    }

    // Audit log with before/after values
    const changedSettings: Record<string, { before: string | undefined; after: string }> = {};
    Object.keys(filteredSettings).forEach((key) => {
      if (currentSettings[key] !== filteredSettings[key]) {
        changedSettings[key] = {
          before: currentSettings[key],
          after: filteredSettings[key],
        };
      }
    });

    if (Object.keys(changedSettings).length > 0) {
      databaseService.auditLog(
        req.user!.id,
        'settings_updated',
        'settings',
        JSON.stringify({ keys: Object.keys(changedSettings) }),
        req.ip || null,
        JSON.stringify(Object.fromEntries(Object.entries(changedSettings).map(([k, v]) => [k, v.before]))),
        JSON.stringify(Object.fromEntries(Object.entries(changedSettings).map(([k, v]) => [k, v.after])))
      );
    }

    res.json({ success: true, settings: filteredSettings });
  } catch (error) {
    logger.error('Error saving settings:', error);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// DELETE /settings — reset to defaults
router.delete('/', requirePermission('settings', 'write'), (req: Request, res: Response) => {
  try {
    const currentSettings = databaseService.getAllSettings();

    databaseService.deleteAllSettings();
    callbacks.setTracerouteInterval?.(0);

    databaseService.auditLog(
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

export default router;
