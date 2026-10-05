import { Router, Request, Response } from 'express';
import { optionalAuth, requireAuth, requirePermission, requireAdmin } from '../auth/authMiddleware.js';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { fail } from '../utils/apiResponse.js';
import { validateMessageTemplate, normalizeTemplate } from '../../utils/notificationTemplate.js';
import { defaultNotificationPreferences } from '../../utils/notificationDefaults.js';
import { pushNotificationService } from '../services/pushNotificationService.js';
import { appriseNotificationService, resolveAppriseServerUrl } from '../services/appriseNotificationService.js';
import { fallbackManager } from '../meshtasticManager.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { getPrimaryMeshtasticManager } from '../sourceManagerTypes.js';
import {
  getUserNotificationPreferencesAsync,
  resolveNotificationPreferencesAsync,
  saveUserNotificationPreferencesAsync,
  applyNodeNamePrefixAsync,
  type NotificationPreferences,
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

      // requireAuth()/requireAdmin() populate req.user for BOTH a session and a
      // Bearer API token (#4259). Reading the session directly ignored the token
      // half, so these endpoints 401d for a valid token even though the guard had
      // already accepted it.
      const userId = req.user?.id ?? req.session?.userId;
      const userAgent = req.headers['user-agent'];

      await pushNotificationService.saveSubscription(userId, subscription, userAgent, sourceId);

      res.json({ success: true });
    } catch (error: any) {
      logger.error('Error saving push subscription:', error);
      res.status(500).json({ error: error.message || 'Failed to save subscription' });
    }
  }
);

// Response shapes on the three handlers below stay FLAT on purpose
// (`{ success: true, remainingSources }` etc.): the frontend ApiService returns
// the raw body and does not unwrap `data`, so `ok(res, data)` would nest the
// fields where the client does not read them. Errors use `fail()`, which is
// always safe for ApiService.

/**
 * Unsubscribe THIS source only (#5493). A browser has one push endpoint per
 * origin, shared by every source it subscribed on, so deleting by endpoint
 * alone silently dropped the user from every other source too. Returns how
 * many other sources still hold a row for the endpoint, so the client knows
 * whether it may kill the browser subscription. Count only: listing the ids
 * could reveal sources this user may not read.
 */
pushRouter.post(
  '/unsubscribe',
  optionalAuth(),
  requirePermission('messages', 'read', { sourceIdFrom: 'body' }),
  async (req: Request, res: Response) => {
    try {
      const { endpoint, sourceId } = req.body;

      if (!endpoint || typeof endpoint !== 'string') {
        return fail(res, 400, 'MISSING_ENDPOINT', 'Endpoint is required');
      }
      if (!sourceId || typeof sourceId !== 'string') {
        return fail(res, 400, 'MISSING_SOURCE_ID', 'sourceId is required');
      }

      await pushNotificationService.removeSubscription(endpoint, sourceId);
      const remaining = await pushNotificationService.getSubscriptionSourceIds(endpoint);

      res.json({ success: true, remainingSources: remaining.length });
    } catch (error) {
      logger.error('Error removing push subscription:', error);
      return fail(res, 500, 'INTERNAL_ERROR', error instanceof Error && error.message ? error.message : 'Failed to remove subscription');
    }
  }
);

/**
 * Is this browser's endpoint subscribed on this source? (#5493)
 *
 * POST, not GET, so the endpoint URL (a bearer-like capability) stays out of
 * access logs and query strings. `otherSources` is a count only, for the same
 * reason `/unsubscribe` returns a count.
 */
pushRouter.post(
  '/subscription-status',
  optionalAuth(),
  requirePermission('messages', 'read', { sourceIdFrom: 'body' }),
  async (req: Request, res: Response) => {
    try {
      const { endpoint, sourceId } = req.body;

      if (!endpoint || typeof endpoint !== 'string') {
        return fail(res, 400, 'MISSING_ENDPOINT', 'Endpoint is required');
      }
      if (!sourceId || typeof sourceId !== 'string') {
        return fail(res, 400, 'MISSING_SOURCE_ID', 'sourceId is required');
      }

      const sourceIds = await pushNotificationService.getSubscriptionSourceIds(endpoint);
      const subscribed = sourceIds.includes(sourceId);
      const otherSources = sourceIds.filter(id => id !== sourceId).length;

      res.json({ success: true, subscribed, otherSources });
    } catch (error) {
      logger.error('Error checking push subscription status:', error);
      return fail(res, 500, 'INTERNAL_ERROR', error instanceof Error && error.message ? error.message : 'Failed to check subscription status');
    }
  }
);

/**
 * Remove this browser's endpoint from EVERY source (#5493).
 *
 * No per-source permission check: holding the endpoint URL is the ownership
 * proof. The push service mints it per browser and only that browser (and our
 * DB) knows it, and the only effect is to stop pushes to the caller's own
 * browser, so there is nothing to gain by guessing someone else's.
 */
pushRouter.post(
  '/unsubscribe-all',
  optionalAuth(),
  async (req: Request, res: Response) => {
    try {
      const { endpoint } = req.body;

      if (!endpoint || typeof endpoint !== 'string') {
        return fail(res, 400, 'MISSING_ENDPOINT', 'Endpoint is required');
      }

      const before = await pushNotificationService.getSubscriptionSourceIds(endpoint);
      await pushNotificationService.removeSubscription(endpoint);

      // `removed` counts the distinct sources the endpoint was dropped from.
      res.json({ success: true, removed: before.length });
    } catch (error) {
      logger.error('Error removing push subscription from all sources:', error);
      return fail(res, 500, 'INTERNAL_ERROR', error instanceof Error && error.message ? error.message : 'Failed to remove subscription');
    }
  }
);

// Test push notification (admin only)
pushRouter.post('/test', requireAdmin(), async (req: Request, res: Response) => {
  try {
    // requireAuth()/requireAdmin() populate req.user for BOTH a session and a
    // Bearer API token (#4259). Reading the session directly ignored the token
    // half, so these endpoints 401d for a valid token even though the guard had
    // already accepted it.
    const userId = req.user?.id ?? req.session?.userId;

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

// The built-in defaults: what GET answers for a source the user never
// configured, and what a partial POST that creates a source's first row fills
// the unsent fields from. Same definition the filter path decides with.
const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = defaultNotificationPreferences();

const BOOLEAN_PREF_FIELDS = [
  'enableWebPush',
  'enableApprise',
  'enableDirectMessages',
  'notifyOnEmoji',
  'notifyOnMqtt',
  'notifyOnNewNode',
  'notifyOnTraceroute',
  'notifyOnInactiveNode',
  'notifyOnLowBattery',
  'notifyOnWaypoint',
  'notifyOnServerEvents',
  'prefixWithNodeName',
] as const;

const ARRAY_PREF_FIELDS = ['enabledChannels', 'whitelist', 'blacklist'] as const;

const PREF_FIELDS = Object.keys(DEFAULT_NOTIFICATION_PREFERENCES) as Array<keyof NotificationPreferences>;

// Get notification preferences (unified for Web Push and Apprise)
pushRouter.get(
  '/preferences',
  requireAuth(),
  requirePermission('messages', 'read', { sourceIdFrom: 'query' }),
  async (req: Request, res: Response) => {
  try {
    // requireAuth()/requireAdmin() populate req.user for BOTH a session and a
    // Bearer API token (#4259). Reading the session directly ignored the token
    // half, so these endpoints 401d for a valid token even though the guard had
    // already accepted it.
    const userId = req.user?.id ?? req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const sourceId = typeof req.query.sourceId === 'string' && req.query.sourceId
      ? req.query.sourceId
      : undefined;

    const resolved = await resolveNotificationPreferencesAsync(userId, sourceId);
    if (!resolved) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    res.json({
      ...resolved.prefs,
      // True when nothing is saved for this source and the answer is the
      // built-in defaults (or the user's pre-4.0 settings). Never another
      // source's row. The first save creates the row.
      usingDefaults: resolved.origin !== 'row',
      // True when the mute lists were carried from the user's legacy '' row
      // (#5487). The server only does that for a Meshtastic source.
      sourceFallback: resolved.legacyMutes,
    });
  } catch (error: any) {
    logger.error('Error loading notification preferences:', error);
    res.status(500).json({ error: error.message || 'Failed to load preferences' });
  }
  }
);

/**
 * Save notification preferences (unified for Web Push and Apprise).
 *
 * Partial update: only the fields in the body change. The rest come from the
 * stored row for (user, sourceId), or — for a source with no row yet — from
 * whatever GET would answer: the built-in defaults (never another source's
 * row), plus the legacy '' row's active mutes on a Meshtastic source. Each
 * client sends only the fields it edits, so the Notifications tab can't
 * overwrite a channel/DM mute set elsewhere after it loaded, and a mute save
 * can't overwrite Notifications-tab edits.
 */
pushRouter.post(
  '/preferences',
  requireAuth(),
  requirePermission('messages', 'read', { sourceIdFrom: 'body' }),
  async (req: Request, res: Response) => {
  try {
    // requireAuth()/requireAdmin() populate req.user for BOTH a session and a
    // Bearer API token (#4259). Reading the session directly ignored the token
    // half, so these endpoints 401d for a valid token even though the guard had
    // already accepted it.
    const userId = req.user?.id ?? req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const body: Record<string, any> =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};

    const sourceId = typeof body.sourceId === 'string' && body.sourceId
      ? body.sourceId
      : undefined;

    const {
      lowBatteryThreshold,
      lowBatteryVoltageThreshold,
      waypointRadiusKm,
      waypointCenterLat,
      waypointCenterLon,
      monitoredNodes,
      appriseUrls,
      mutedChannels,
      mutedDMs,
    } = body;

    // Validate only the fields the client sent.
    if (
      BOOLEAN_PREF_FIELDS.some(f => body[f] !== undefined && typeof body[f] !== 'boolean') ||
      ARRAY_PREF_FIELDS.some(f => body[f] !== undefined && !Array.isArray(body[f]))
    ) {
      return res.status(400).json({ error: 'Invalid preferences data' });
    }

    // Validate monitoredNodes is an array of strings
    if (monitoredNodes !== undefined && !Array.isArray(monitoredNodes)) {
      return res.status(400).json({ error: 'monitoredNodes must be an array' });
    }
    if (monitoredNodes && monitoredNodes.some((id: any) => typeof id !== 'string')) {
      return res.status(400).json({ error: 'monitoredNodes must be an array of strings' });
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
    // 0 km would silently disable the feature while the toggle reads on, so the
    // radius has to be positive. The ceiling is half the Earth's circumference:
    // beyond that every point on the planet is inside the fence anyway (#4750).
    if (
      waypointRadiusKm !== undefined &&
      (typeof waypointRadiusKm !== 'number' ||
        !Number.isFinite(waypointRadiusKm) ||
        waypointRadiusKm <= 0 ||
        waypointRadiusKm > 20037)
    ) {
      return res.status(400).json({ error: 'waypointRadiusKm must be a number between 0 (exclusive) and 20037' });
    }
    // The centre is nullable — null means "use this source's own node". Both
    // halves must be present together, or the radius has no origin.
    const latGiven = waypointCenterLat !== undefined && waypointCenterLat !== null;
    const lonGiven = waypointCenterLon !== undefined && waypointCenterLon !== null;
    if (latGiven !== lonGiven) {
      return res.status(400).json({ error: 'waypointCenterLat and waypointCenterLon must be set together' });
    }
    if (latGiven && (typeof waypointCenterLat !== 'number' || !Number.isFinite(waypointCenterLat) || Math.abs(waypointCenterLat) > 90)) {
      return res.status(400).json({ error: 'waypointCenterLat must be a number between -90 and 90' });
    }
    if (lonGiven && (typeof waypointCenterLon !== 'number' || !Number.isFinite(waypointCenterLon) || Math.abs(waypointCenterLon) > 180)) {
      return res.status(400).json({ error: 'waypointCenterLon must be a number between -180 and 180' });
    }

    // lowBatteryVoltageThreshold (mV). MeshCore nodes report battery voltage;
    // 0-20000 mV covers single-cell through multi-cell packs.
    if (
      lowBatteryVoltageThreshold !== undefined &&
      (typeof lowBatteryVoltageThreshold !== 'number' ||
        !Number.isFinite(lowBatteryVoltageThreshold) ||
        lowBatteryVoltageThreshold < 0 ||
        lowBatteryVoltageThreshold > 20000)
    ) {
      return res.status(400).json({ error: 'lowBatteryVoltageThreshold must be a number between 0 and 20000' });
    }

    if (appriseUrls !== undefined && !Array.isArray(appriseUrls)) {
      return res.status(400).json({ error: 'appriseUrls must be an array' });
    }
    if (appriseUrls && appriseUrls.some((url: any) => typeof url !== 'string')) {
      return res.status(400).json({ error: 'appriseUrls must be an array of strings' });
    }

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

    // Message-notification templates (#5593). null or blank clears the
    // template (back to the built-in default). An unknown `{{ token }}` is
    // REJECTED here rather than saved and rendered empty, so a typo is caught
    // at save instead of showing up as a hole in a notification.
    for (const [field, kind] of [
      ['messageTitleTemplate', 'title'],
      ['messageBodyTemplate', 'body'],
    ] as const) {
      if (body[field] === undefined) continue;
      const problem = validateMessageTemplate(body[field], kind);
      if (problem) {
        return fail(res, 400, problem.code, problem.message, {
          field,
          ...(problem.unknownTokens ? { unknownTokens: problem.unknownTokens } : {}),
        });
      }
      body[field] = normalizeTemplate(body[field]);
    }

    // Base row. The own-row read rethrows: a failed read must fail the save,
    // not fall through to defaults and overwrite the user's settings.
    //
    // Not transactional: two concurrent saves from the same user and source
    // can both read the same base, and the later write then drops the earlier
    // one's fields. Saves are single-user UI actions, so the window is small;
    // it is still far narrower than the old client-side whole-row writes.
    const ownRow = await databaseService.notifications.getUserPreferences(
      userId,
      sourceId,
      { rethrow: true },
    );
    // No row yet: start from what GET answers for this source. That is the
    // built-in defaults, so a first save never copies another source's
    // channels, keywords, toggles or templates. A Meshtastic source keeps the
    // legacy '' row's active mutes (#5487), so the first save does not unmute.
    const base: NotificationPreferences = ownRow
      ?? (await resolveNotificationPreferencesAsync(userId, sourceId))?.prefs
      ?? DEFAULT_NOTIFICATION_PREFERENCES;

    const patch: Partial<NotificationPreferences> = {};
    for (const field of PREF_FIELDS) {
      if (body[field] !== undefined) {
        (patch as Record<string, unknown>)[field] = body[field];
      }
    }

    const prefs: NotificationPreferences = {
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      ...base,
      ...patch,
    };
    // A stored centre with only one half set would leave the radius with no
    // origin; clear both rather than save half.
    if ((prefs.waypointCenterLat === null) !== (prefs.waypointCenterLon === null)) {
      prefs.waypointCenterLat = null;
      prefs.waypointCenterLon = null;
    }

    const success = await saveUserNotificationPreferencesAsync(userId, prefs, sourceId);

    if (success) {
      logger.debug(
        `✅ Saved notification preferences for user ${userId} source=${sourceId ?? '(default)'} fields=[${Object.keys(patch).join(',')}]`
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
      // `apprise_enabled` is read here per-source-less/global even though it is
      // written per-source everywhere else — a real inconsistency, but this
      // endpoint is unscoped (no sourceId) and "enabled across N sources" is a
      // product question, not a cleanup. Left as-is; see #4442 spec discussion.
      enabled: await databaseService.settings.getSetting('apprise_enabled') === 'true',
      // Was: `getSetting('apprise_url') || 'http://localhost:8000'` — a key with
      // no global writer anywhere (only read per-source), so this always fell
      // through to the literal and ignored appriseApiServerUrl/APPRISE_URL. Now
      // reports the same endpoint a real send would actually use (#4442).
      url: await resolveAppriseServerUrl(databaseService.settings, null),
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
    // requireAuth()/requireAdmin() populate req.user for BOTH a session and a
    // Bearer API token (#4259). Reading the session directly ignored the token
    // half, so these endpoints 401d for a valid token even though the guard had
    // already accepted it.
    const userId = req.user?.id ?? req.session?.userId;
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
    const body = await applyNodeNamePrefixAsync(userId, baseBody, localNodeName, sourceId);

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
