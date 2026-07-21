import { Router, Request, Response } from 'express';
import { optionalAuth, requireAuth, requirePermission, requireAdmin } from '../auth/authMiddleware.js';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { pushNotificationService } from '../services/pushNotificationService.js';
import { appriseNotificationService } from '../services/appriseNotificationService.js';
import { fallbackManager } from '../meshtasticManager.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { getPrimaryMeshtasticManager } from '../sourceManagerTypes.js';
import {
  getUserNotificationPreferencesAsync,
  saveUserNotificationPreferencesAsync,
  applyNodeNamePrefixAsync,
} from '../utils/notificationFiltering.js';

/**
 * Web Push notification endpoints + unified notification preferences.
 * Mounted at `/push`.
 */
const pushRouter = Router();

// Get VAPID public key + status
pushRouter.get('/vapid-key', optionalAuth(), async (_req: Request, res: Response) => {
  const publicKey = await pushNotificationService.getPublicKeyAsync();
  const status = await pushNotificationService.getVapidStatusAsync();

  res.json({
    publicKey,
    status,
  });
});

// Get push notification status
pushRouter.get('/status', optionalAuth(), async (_req: Request, res: Response) => {
  const status = await pushNotificationService.getVapidStatusAsync();
  res.json(status);
});

// Update VAPID subject (admin only)
pushRouter.put('/vapid-subject', requireAdmin(), async (req: Request, res: Response) => {
  try {
    const { subject } = req.body;

    if (!subject || typeof subject !== 'string') {
      return res.status(400).json({ error: 'Subject is required and must be a string' });
    }

    await pushNotificationService.updateVapidSubject(subject);
    res.json({ success: true, subject });
  } catch (error: any) {
    logger.error('Error updating VAPID subject:', error);
    res.status(400).json({ error: error.message || 'Failed to update VAPID subject' });
  }
});

// Subscribe to push notifications
pushRouter.post(
  '/subscribe',
  optionalAuth(),
  requirePermission('messages', 'read', { sourceIdFrom: 'body' }),
  async (req: Request, res: Response) => {
    try {
      const { subscription, sourceId } = req.body;

      if (!subscription || !subscription.endpoint || !subscription.keys) {
        return res.status(400).json({ error: 'Invalid subscription data' });
      }
      if (!sourceId || typeof sourceId !== 'string') {
        return res.status(400).json({ error: 'sourceId is required' });
      }

      // Validate source exists
      const source = await databaseService.sources.getSource(sourceId);
      if (!source) {
        return res.status(400).json({ error: `Unknown sourceId: ${sourceId}` });
      }

      const userId = req.session?.userId;
      const userAgent = req.headers['user-agent'];

      await pushNotificationService.saveSubscription(userId, subscription, userAgent, sourceId);

      res.json({ success: true });
    } catch (error: any) {
      logger.error('Error saving push subscription:', error);
      res.status(500).json({ error: error.message || 'Failed to save subscription' });
    }
  }
);

// Unsubscribe from push notifications
pushRouter.post(
  '/unsubscribe',
  optionalAuth(),
  requirePermission('messages', 'read', { sourceIdFrom: 'body' }),
  async (req: Request, res: Response) => {
    try {
      const { endpoint, sourceId } = req.body;

      if (!endpoint) {
        return res.status(400).json({ error: 'Endpoint is required' });
      }
      if (!sourceId || typeof sourceId !== 'string') {
        return res.status(400).json({ error: 'sourceId is required' });
      }

      await pushNotificationService.removeSubscription(endpoint);

      res.json({ success: true });
    } catch (error: any) {
      logger.error('Error removing push subscription:', error);
      res.status(500).json({ error: error.message || 'Failed to remove subscription' });
    }
  }
);

// Test push notification (admin only)
pushRouter.post('/test', requireAdmin(), async (req: Request, res: Response) => {
  try {
    const userId = req.session?.userId;

    // Get local node name for prefix
    const mgr = getPrimaryMeshtasticManager(sourceManagerRegistry) ?? fallbackManager;
    const localNodeInfo = mgr.getLocalNodeInfo();
    const localNodeName = localNodeInfo?.longName || null;

    // Apply prefix if user has it enabled
    const baseBody = 'This is a test push notification from MeshMonitor';
    const body = await applyNodeNamePrefixAsync(userId, baseBody, localNodeName);

    const result = await pushNotificationService.sendToUser(userId, {
      title: 'Test Notification',
      body,
      icon: '/logo.png',
      badge: '/logo.png',
      tag: 'test-notification',
    });

    res.json({
      success: true,
      sent: result.sent,
      failed: result.failed,
    });
  } catch (error: any) {
    logger.error('Error sending test notification:', error);
    res.status(500).json({ error: error.message || 'Failed to send test notification' });
  }
});

// Get notification preferences (unified for Web Push and Apprise)
pushRouter.get(
  '/preferences',
  requireAuth(),
  requirePermission('messages', 'read', { sourceIdFrom: 'query' }),
  async (req: Request, res: Response) => {
  try {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const sourceId = typeof req.query.sourceId === 'string' && req.query.sourceId
      ? req.query.sourceId
      : undefined;

    const prefs = await getUserNotificationPreferencesAsync(userId, sourceId);

    if (prefs) {
      res.json(prefs);
    } else {
      // Return defaults
      res.json({
        enableWebPush: true,
        enableApprise: false,
        enabledChannels: [],
        enableDirectMessages: true,
        notifyOnEmoji: true,
        notifyOnMqtt: true,
        notifyOnNewNode: true,
        notifyOnTraceroute: true,
        notifyOnInactiveNode: false,
        notifyOnLowBattery: false,
        lowBatteryThreshold: 20,
        lowBatteryVoltageThreshold: 3300,
        notifyOnServerEvents: false,
        prefixWithNodeName: false,
        monitoredNodes: [],
        whitelist: ['Hi', 'Help'],
        blacklist: ['Test', 'Copy'],
        appriseUrls: [],
        mutedChannels: [],
        mutedDMs: [],
      });
    }
  } catch (error: any) {
    logger.error('Error loading notification preferences:', error);
    res.status(500).json({ error: error.message || 'Failed to load preferences' });
  }
  }
);

// Save notification preferences (unified for Web Push and Apprise)
pushRouter.post(
  '/preferences',
  requireAuth(),
  requirePermission('messages', 'read', { sourceIdFrom: 'body' }),
  async (req: Request, res: Response) => {
  try {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const sourceId = typeof req.body?.sourceId === 'string' && req.body.sourceId
      ? req.body.sourceId
      : undefined;

    const {
      enableWebPush,
      enableApprise,
      enabledChannels,
      enableDirectMessages,
      notifyOnEmoji,
      notifyOnMqtt,
      notifyOnNewNode,
      notifyOnTraceroute,
      notifyOnInactiveNode,
      notifyOnLowBattery,
      lowBatteryThreshold,
      lowBatteryVoltageThreshold,
      notifyOnServerEvents,
      prefixWithNodeName,
      monitoredNodes,
      whitelist,
      blacklist,
      appriseUrls,
      mutedChannels,
      mutedDMs,
    } = req.body;

    // Validate input
    if (
      typeof enableWebPush !== 'boolean' ||
      typeof enableApprise !== 'boolean' ||
      !Array.isArray(enabledChannels) ||
      typeof enableDirectMessages !== 'boolean' ||
      typeof notifyOnEmoji !== 'boolean' ||
      typeof notifyOnMqtt !== 'boolean' ||
      typeof notifyOnNewNode !== 'boolean' ||
      typeof notifyOnTraceroute !== 'boolean' ||
      typeof notifyOnInactiveNode !== 'boolean' ||
      typeof notifyOnServerEvents !== 'boolean' ||
      typeof prefixWithNodeName !== 'boolean' ||
      !Array.isArray(whitelist) ||
      !Array.isArray(blacklist)
    ) {
      return res.status(400).json({ error: 'Invalid preferences data' });
    }

    // Validate monitoredNodes is an array of strings
    if (monitoredNodes !== undefined && !Array.isArray(monitoredNodes)) {
      return res.status(400).json({ error: 'monitoredNodes must be an array' });
    }

    // Validate each element is a string
    if (monitoredNodes && monitoredNodes.some((id: any) => typeof id !== 'string')) {
      return res.status(400).json({ error: 'monitoredNodes must be an array of strings' });
    }

    // notifyOnLowBattery / lowBatteryThreshold are optional (older clients omit them)
    if (notifyOnLowBattery !== undefined && typeof notifyOnLowBattery !== 'boolean') {
      return res.status(400).json({ error: 'notifyOnLowBattery must be a boolean' });
    }
    if (
      lowBatteryThreshold !== undefined &&
      (typeof lowBatteryThreshold !== 'number' ||
        !Number.isFinite(lowBatteryThreshold) ||
        lowBatteryThreshold < 0 ||
        lowBatteryThreshold > 100)
    ) {
      return res.status(400).json({ error: 'lowBatteryThreshold must be a number between 0 and 100' });
    }
    // lowBatteryVoltageThreshold (mV) is optional (older clients omit it). MeshCore
    // nodes report battery voltage; 0-20000 mV covers single-cell through multi-cell packs.
    if (
      lowBatteryVoltageThreshold !== undefined &&
      (typeof lowBatteryVoltageThreshold !== 'number' ||
        !Number.isFinite(lowBatteryVoltageThreshold) ||
        lowBatteryVoltageThreshold < 0 ||
        lowBatteryVoltageThreshold > 20000)
    ) {
      return res.status(400).json({ error: 'lowBatteryVoltageThreshold must be a number between 0 and 20000' });
    }

    // Validate appriseUrls is an array of strings if provided
    if (appriseUrls !== undefined && !Array.isArray(appriseUrls)) {
      return res.status(400).json({ error: 'appriseUrls must be an array' });
    }
    if (appriseUrls && appriseUrls.some((url: any) => typeof url !== 'string')) {
      return res.status(400).json({ error: 'appriseUrls must be an array of strings' });
    }

    // Validate mutedChannels
    if (mutedChannels !== undefined && !Array.isArray(mutedChannels)) {
      return res.status(400).json({ error: 'mutedChannels must be an array' });
    }
    if (mutedChannels && mutedChannels.some((r: any) =>
      typeof r !== 'object' || r === null ||
      typeof r.channelId !== 'number' ||
      (r.muteUntil !== null && typeof r.muteUntil !== 'number')
    )) {
      return res.status(400).json({ error: 'mutedChannels entries must have channelId (number) and muteUntil (number|null)' });
    }

    // Validate mutedDMs
    if (mutedDMs !== undefined && !Array.isArray(mutedDMs)) {
      return res.status(400).json({ error: 'mutedDMs must be an array' });
    }
    if (mutedDMs && mutedDMs.some((r: any) =>
      typeof r !== 'object' || r === null ||
      typeof r.nodeUuid !== 'string' ||
      (r.muteUntil !== null && typeof r.muteUntil !== 'number')
    )) {
      return res.status(400).json({ error: 'mutedDMs entries must have nodeUuid (string) and muteUntil (number|null)' });
    }

    const prefs = {
      enableWebPush,
      enableApprise,
      enabledChannels,
      enableDirectMessages,
      notifyOnEmoji,
      notifyOnMqtt: notifyOnMqtt ?? true,
      notifyOnNewNode,
      notifyOnTraceroute,
      notifyOnInactiveNode: notifyOnInactiveNode ?? false,
      notifyOnLowBattery: notifyOnLowBattery ?? false,
      lowBatteryThreshold: lowBatteryThreshold ?? 20,
      lowBatteryVoltageThreshold: lowBatteryVoltageThreshold ?? 3300,
      notifyOnServerEvents: notifyOnServerEvents ?? false,
      prefixWithNodeName: prefixWithNodeName ?? false,
      monitoredNodes: monitoredNodes ?? [],
      whitelist,
      blacklist,
      appriseUrls: appriseUrls ?? [],
      mutedChannels: mutedChannels ?? [],
      mutedDMs: mutedDMs ?? [],
    };

    const success = await saveUserNotificationPreferencesAsync(userId, prefs, sourceId);

    if (success) {
      logger.debug(
        `✅ Saved notification preferences for user ${userId} source=${sourceId ?? '(default)'} (WebPush: ${enableWebPush}, Apprise: ${enableApprise})`
      );
      res.json({ success: true });
    } else {
      res.status(500).json({ error: 'Failed to save preferences' });
    }
  } catch (error: any) {
    logger.error('Error saving notification preferences:', error);
    res.status(500).json({ error: error.message || 'Failed to save preferences' });
  }
  }
);

/**
 * Apprise notification endpoints (admin only).
 * Mounted at `/apprise`.
 */
const appriseRouter = Router();

// Get Apprise status (admin only)
appriseRouter.get('/status', requireAdmin(), async (_req: Request, res: Response) => {
  try {
    const isAvailable = appriseNotificationService.isAvailable();
    res.json({
      available: isAvailable,
      enabled: await databaseService.settings.getSetting('apprise_enabled') === 'true',
      url: await databaseService.settings.getSetting('apprise_url') || 'http://localhost:8000',
    });
  } catch (error: any) {
    logger.error('Error getting Apprise status:', error);
    res.status(500).json({ error: error.message || 'Failed to get Apprise status' });
  }
});

// Send test Apprise notification (admin only)
appriseRouter.post(
  '/test',
  requireAdmin(),
  requirePermission('settings', 'write', { sourceIdFrom: 'body' }),
  async (req: Request, res: Response) => {
  try {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Not authenticated' });
    }

    const sourceId = typeof req.body?.sourceId === 'string' && req.body.sourceId
      ? req.body.sourceId
      : undefined;
    if (!sourceId) {
      return res.status(400).json({ success: false, message: 'sourceId is required' });
    }

    // Resolve source for sourceName
    const source = await databaseService.sources.getSource(sourceId);
    if (!source) {
      return res.status(400).json({ success: false, message: `Unknown sourceId: ${sourceId}` });
    }

    // Get user's Apprise URLs from their preferences (per-source)
    const prefs = await getUserNotificationPreferencesAsync(userId, sourceId);
    if (!prefs || !prefs.appriseUrls || prefs.appriseUrls.length === 0) {
      return res.json({
        success: false,
        message: 'No Apprise URLs configured in your notification preferences',
      });
    }

    // Get local node name for prefix
    const mgr = getPrimaryMeshtasticManager(sourceManagerRegistry) ?? fallbackManager;
    const localNodeInfo = mgr.getLocalNodeInfo();
    const localNodeName = localNodeInfo?.longName || null;

    // Apply prefix if user has it enabled
    const baseBody = 'This is a test notification from MeshMonitor via Apprise';
    const body = await applyNodeNamePrefixAsync(userId, baseBody, localNodeName);

    // Send to user's configured URLs
    const success = await appriseNotificationService.sendNotificationToUrls(
      {
        title: 'Test Notification',
        body,
        type: 'info',
        sourceId,
        sourceName: source.name ?? sourceId,
      },
      prefs.appriseUrls
    );

    if (success) {
      res.json({ success: true, message: 'Test notification sent successfully' });
    } else {
      res.json({ success: false, message: 'Failed to send notification - check your Apprise URLs' });
    }
  } catch (error: any) {
    logger.error('Error sending test Apprise notification:', error);
    res.status(500).json({ error: error.message || 'Failed to send test notification' });
  }
  }
);

// Get configured Apprise URLs (admin only)
appriseRouter.get('/urls', requireAdmin(), async (_req: Request, res: Response) => {
  try {
    const configFile = process.env.APPRISE_CONFIG_DIR
      ? `${process.env.APPRISE_CONFIG_DIR}/urls.txt`
      : '/data/apprise-config/urls.txt';

    // Check if file exists
    const fs = await import('fs/promises');
    try {
      const content = await fs.readFile(configFile, 'utf-8');
      const urls = content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith('#'));

      res.json({ urls });
    } catch (error: any) {
      // File doesn't exist or can't be read - return empty array
      if (error.code === 'ENOENT') {
        res.json({ urls: [] });
      } else {
        throw error;
      }
    }
  } catch (error: any) {
    logger.error('Error reading Apprise URLs:', error);
    res.status(500).json({ error: error.message || 'Failed to read Apprise URLs' });
  }
});

// Configure Apprise URLs (admin only)
appriseRouter.post('/configure', requireAdmin(), async (req: Request, res: Response) => {
  try {
    const { urls } = req.body;

    if (!Array.isArray(urls)) {
      return res.status(400).json({ error: 'URLs must be an array' });
    }

    // Security: Validate URL schemes to prevent malicious URLs
    // Comprehensive list of all Apprise-supported notification services
    // Reference: https://github.com/caronc/apprise
    const ALLOWED_SCHEMES = [
      // Core Apprise
      'apprise',
      'apprises',

      // Chat & Messaging
      'discord',
      'slack',
      'msteams',
      'teams',
      'guilded',
      'revolt',
      'matrix',
      'matrixs',
      'mmost',
      'mmosts',
      'rocket',
      'rockets',
      'ryver',
      'zulip',
      'twist',
      'gchat',
      'flock',

      // Instant Messaging & Social
      'telegram',
      'tgram',
      'signal',
      'signals',
      'whatsapp',
      'line',
      'mastodon',
      'mastodons',
      'misskey',
      'misskeys',
      'bluesky',
      'reddit',
      'twitter',

      // Team Communication
      'workflows',
      'wxteams',
      'wecombot',
      'feishu',
      'lark',
      'dingtalk',

      // Push Notifications
      'pushover',
      'pover',
      'pushbullet',
      'pbul',
      'pushed',
      'pushme',
      'pushplus',
      'pushdeer',
      'pushdeers',
      'pushy',
      'prowl',
      'simplepush',
      'spush',
      'popcorn',
      'push',

      // Notification Services
      'ntfy',
      'ntfys',
      'gotify',
      'gotifys',
      'join',
      'ifttt',
      'notica',
      'notifiarr',
      'notifico',
      'onesignal',
      'kumulos',
      'bark',
      'barks',
      'chanify',
      'serverchan',
      'schan',
      'qq',
      'wxpusher',

      // Incident Management & Monitoring
      'pagerduty',
      'pagertree',
      'opsgenie',
      'spike',
      'splunk',
      'victorops',
      'signl4',

      // Email Services
      'mailto',
      'email',
      'smtp',
      'smtps',
      'ses',
      'mailgun',
      'sendgrid',
      'smtp2go',
      'sparkpost',
      'o365',
      'resend',
      'sendpulse',

      // SMS Services
      'bulksms',
      'bulkvs',
      'burstsms',
      'clickatell',
      'clicksend',
      'd7sms',
      'freemobile',
      'httpsms',
      'atalk',

      // Cloud/IoT/Home
      'fcm',
      'hassio',
      'hassios',
      'homeassistant',
      'parsep',
      'parseps',
      'aws',
      'sns',

      // Media Centers
      'kodi',
      'kodis',
      'xbmc',
      'xbmcs',
      'emby',
      'embys',
      'enigma2',
      'enigma2s',

      // Collaboration & Productivity
      'ncloud',
      'nclouds',
      'nctalk',
      'nctalks',
      'office365',

      // Streaming & Gaming
      'streamlabs',
      'strmlabs',

      // Specialized
      'lametric',
      'synology',
      'synologys',
      'vapid',
      'mqtt',
      'mqtts',
      'rsyslog',
      'syslog',
      'dapnet',
      'aprs',
      'growl',
      'pjet',
      'pjets',
      'psafer',
      'psafers',
      'spugpush',
      'pushsafer',

      // Generic webhooks & protocols
      'webhook',
      'webhooks',
      'json',
      'xml',
      'form',
      'http',
      'https',
    ];

    const invalidUrls: string[] = [];
    const validUrls = urls.filter((url: string) => {
      if (typeof url !== 'string' || !url.trim()) {
        invalidUrls.push(url);
        return false;
      }

      // Extract scheme using regex instead of URL parser
      // This allows Apprise URLs with special characters (colons, multiple slashes, etc.)
      // that don't conform to strict URL syntax but are valid for Apprise
      // Support both "scheme://" format and special cases like "mailto:"
      const schemeMatch = url.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);

      if (!schemeMatch) {
        invalidUrls.push(url);
        return false;
      }

      const scheme = schemeMatch[1].toLowerCase();

      if (!ALLOWED_SCHEMES.includes(scheme)) {
        invalidUrls.push(url);
        return false;
      }

      return true;
    });

    if (invalidUrls.length > 0) {
      return res.status(400).json({
        error: 'Invalid or disallowed URL schemes detected',
        invalidUrls,
        allowedSchemes: ALLOWED_SCHEMES,
      });
    }

    const result = await appriseNotificationService.configureUrls(validUrls);
    res.json(result);
  } catch (error: any) {
    logger.error('Error configuring Apprise URLs:', error);
    res.status(500).json({ error: error.message || 'Failed to configure Apprise URLs' });
  }
});

// Enable/disable Apprise system-wide (admin only)
appriseRouter.put('/enabled', requireAdmin(), async (req: Request, res: Response) => {
  try {
    const { enabled } = req.body;

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'Enabled must be a boolean' });
    }

    await databaseService.settings.setSetting('apprise_enabled', enabled ? 'true' : 'false');
    logger.debug(`✅ Apprise ${enabled ? 'enabled' : 'disabled'} system-wide`);
    res.json({ success: true, enabled });
  } catch (error: any) {
    logger.error('Error updating Apprise enabled status:', error);
    res.status(500).json({ error: error.message || 'Failed to update Apprise status' });
  }
});

export { pushRouter, appriseRouter };
