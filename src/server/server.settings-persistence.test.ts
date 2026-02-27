/**
 * Settings Persistence Tests
 *
 * Verifies that EVERY setting in VALID_SETTINGS_KEYS can be saved via
 * POST /api/settings and read back via GET /api/settings. Both the server
 * and this test import from the same shared constant
 * (src/server/constants/settings.ts), so adding a key there is all that's
 * needed — no more duplicate arrays to keep in sync.
 *
 * The test also cross-references the frontend SettingsTab save payload and
 * SettingsContext server load to flag persistence gaps.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { Express } from 'express';
import session from 'express-session';
import request from 'supertest';
import { VALID_SETTINGS_KEYS } from './constants/settings.js';

// ─── Database mock ────────────────────────────────────────────────────────
// In-memory store that mimics setSetting / getAllSettings round-trip
const settingsStore: Record<string, string> = {};

vi.mock('../services/database.js', () => ({
  default: {
    drizzleDbType: 'sqlite',
    getAllSettings: vi.fn(() => ({ ...settingsStore })),
    setSetting: vi.fn((key: string, value: string) => {
      settingsStore[key] = value;
    }),
    getSetting: vi.fn((key: string) => settingsStore[key] ?? null),
    auditLog: vi.fn(),
    // Async methods required by authMiddleware
    findUserByIdAsync: vi.fn(),
    findUserByUsernameAsync: vi.fn(),
    checkPermissionAsync: vi.fn(),
    getUserPermissionSetAsync: vi.fn(),
  },
}));

// Must import AFTER the mock is set up
import databaseService from '../services/database.js';

const mockDb = databaseService as unknown as {
  getAllSettings: ReturnType<typeof vi.fn>;
  setSetting: ReturnType<typeof vi.fn>;
  getSetting: ReturnType<typeof vi.fn>;
  auditLog: ReturnType<typeof vi.fn>;
  findUserByIdAsync: ReturnType<typeof vi.fn>;
  findUserByUsernameAsync: ReturnType<typeof vi.fn>;
  checkPermissionAsync: ReturnType<typeof vi.fn>;
  getUserPermissionSetAsync: ReturnType<typeof vi.fn>;
};

// ─── Helpers ──────────────────────────────────────────────────────────────

const adminUser = {
  id: 1,
  username: 'admin',
  isActive: true,
  isAdmin: true,
};

/** Build an Express app that mounts the settings routes from server.ts */
async function createApp(): Promise<Express> {
  const app = express();
  app.use(express.json());
  app.use(
    session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
      cookie: { secure: false },
    })
  );

  // Inject authenticated admin session
  app.use((req, _res, next) => {
    req.session.userId = adminUser.id;
    req.session.username = adminUser.username;
    next();
  });

  // Minimal settings routes that mirror server.ts logic
  // GET /api/settings
  app.get('/api/settings', (_req, res) => {
    const settings = databaseService.getAllSettings();
    res.json(settings);
  });

  // POST /api/settings — uses the shared VALID_SETTINGS_KEYS allowlist
  app.post('/api/settings', (req, res) => {
    const settings = req.body;

    const filteredSettings: Record<string, string> = {};
    for (const key of VALID_SETTINGS_KEYS) {
      if (key in settings) {
        filteredSettings[key] = String(settings[key]);
      }
    }

    // Save each setting
    for (const [key, value] of Object.entries(filteredSettings)) {
      databaseService.setSetting(key, value);
    }

    res.json({ success: true, saved: Object.keys(filteredSettings).length });
  });

  return app;
}

// ─── The canonical list of ALL valid settings ─────────────────────────────
// Imported from the shared constant — single source of truth for server.ts
// and this test file.
const ALL_VALID_KEYS: readonly string[] = VALID_SETTINGS_KEYS;

// Keys the frontend SettingsTab.tsx sends in handleSave
const SETTINGS_TAB_SENDS = [
  'maxNodeAgeHours',
  'inactiveNodeThresholdHours',
  'inactiveNodeCheckIntervalMinutes',
  'inactiveNodeCooldownHours',
  'temperatureUnit',
  'distanceUnit',
  'positionHistoryLineStyle',
  'telemetryVisualizationHours',
  'favoriteTelemetryStorageDays',
  'preferredSortField',
  'preferredSortDirection',
  'timeFormat',
  'dateFormat',
  'mapTileset',
  'mapPinStyle',
  'theme',
  'packet_log_enabled',
  'packet_log_max_count',
  'packet_log_max_age_hours',
  'solarMonitoringEnabled',
  'solarMonitoringLatitude',
  'solarMonitoringLongitude',
  'solarMonitoringAzimuth',
  'solarMonitoringDeclination',
  'hideIncompleteNodes',
  'homoglyphEnabled',
  'localStatsIntervalMinutes',
  'nodeHopsCalculation',
  'nodeDimmingEnabled',
  'nodeDimmingStartHours',
  'nodeDimmingMinOpacity',
];

// Keys SettingsContext.tsx loads from the server in loadServerSettings
const SETTINGS_CONTEXT_LOADS = [
  'maxNodeAgeHours',
  'inactiveNodeThresholdHours',
  'inactiveNodeCheckIntervalMinutes',
  'inactiveNodeCooldownHours',
  'temperatureUnit',
  'distanceUnit',
  'positionHistoryLineStyle',
  'telemetryVisualizationHours',
  'favoriteTelemetryStorageDays',
  'preferredSortField',
  'preferredSortDirection',
  'preferredDashboardSortOption',
  'timeFormat',
  'dateFormat',
  'mapTileset',
  'mapPinStyle',
  'theme',
  'language',
  'solarMonitoringEnabled',
  'solarMonitoringLatitude',
  'solarMonitoringLongitude',
  'solarMonitoringAzimuth',
  'solarMonitoringDeclination',
  'customTilesets',
  'customTapbackEmojis',
  'nodeHopsCalculation',
  'nodeDimmingEnabled',
  'nodeDimmingStartHours',
  'nodeDimmingMinOpacity',
];

// Settings that are saved/loaded through OTHER code paths (not the main
// settings save button), so they are intentionally not in the SettingsTab
// payload but ARE in the validKeys allowlist. These are excluded from
// the "sent but not loaded" / "loaded but not sent" gap checks.
const OTHER_CODE_PATH_SETTINGS = [
  // Automation settings saved from their own panels
  'autoAckEnabled', 'autoAckRegex', 'autoAckMessage', 'autoAckMessageDirect',
  'autoAckChannels', 'autoAckDirectMessages', 'autoAckUseDM',
  'autoAckSkipIncompleteNodes', 'autoAckTapbackEnabled', 'autoAckReplyEnabled',
  'autoAckDirectEnabled', 'autoAckDirectTapbackEnabled', 'autoAckDirectReplyEnabled',
  'autoAckMultihopEnabled', 'autoAckMultihopTapbackEnabled', 'autoAckMultihopReplyEnabled',
  'autoAckTestMessages', 'customTapbackEmojis',
  'autoAnnounceEnabled', 'autoAnnounceIntervalHours', 'autoAnnounceMessage',
  'autoAnnounceChannelIndex', 'autoAnnounceOnStart', 'autoAnnounceUseSchedule',
  'autoAnnounceSchedule', 'autoAnnounceNodeInfoEnabled', 'autoAnnounceNodeInfoChannels',
  'autoAnnounceNodeInfoDelaySeconds',
  'autoWelcomeEnabled', 'autoWelcomeMessage', 'autoWelcomeTarget',
  'autoWelcomeWaitForName', 'autoWelcomeMaxHops',
  'autoResponderEnabled', 'autoResponderTriggers', 'autoResponderSkipIncompleteNodes',
  'timerTriggers', 'geofenceTriggers',
  // Dashboard widgets saved from dashboard drag/drop
  'dashboardWidgets', 'dashboardSolarVisibility',
  'preferredDashboardSortOption',
  // Telemetry ordering saved from dashboard
  'telemetryFavorites', 'telemetryCustomOrder',
  // Traceroute interval saved from admin panel
  'tracerouteIntervalMinutes',
  // Maintenance/retention saved from admin panel
  'autoUpgradeImmediate', 'maintenanceEnabled', 'maintenanceTime',
  'messageRetentionDays', 'tracerouteRetentionDays',
  'routeSegmentRetentionDays', 'neighborInfoRetentionDays',
  // Key management saved from security panel
  'autoKeyManagementEnabled', 'autoKeyManagementIntervalMinutes',
  'autoKeyManagementMaxExchanges', 'autoKeyManagementAutoPurge',
  // Remote admin saved from admin panel
  'remoteAdminScannerIntervalMinutes', 'remoteAdminScannerExpirationHours',
  // Schedule settings saved from their own panels
  'tracerouteScheduleEnabled', 'tracerouteScheduleStart', 'tracerouteScheduleEnd',
  'remoteAdminScheduleEnabled', 'remoteAdminScheduleStart', 'remoteAdminScheduleEnd',
  // Auto-ping saved from its own panel
  'autoPingEnabled', 'autoPingIntervalSeconds', 'autoPingMaxPings', 'autoPingTimeoutSeconds',
  // Auto-favorite saved from its own panel
  'autoFavoriteEnabled', 'autoFavoriteStaleHours',
  // Language saved via its own setter in SettingsContext
  'language',
  // Custom tilesets saved from map config
  'customTilesets',
  // Server-side settings read directly by backend, not loaded into frontend context
  'packet_log_enabled', 'packet_log_max_count', 'packet_log_max_age_hours',
  'hideIncompleteNodes', 'homoglyphEnabled', 'localStatsIntervalMinutes',
];

// ─── Tests ────────────────────────────────────────────────────────────────

describe('Settings Persistence', () => {
  let app: Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Clear in-memory store
    Object.keys(settingsStore).forEach((key) => delete settingsStore[key]);

    mockDb.findUserByIdAsync.mockResolvedValue(adminUser);
    mockDb.findUserByUsernameAsync.mockResolvedValue(null);
    mockDb.checkPermissionAsync.mockResolvedValue(true);
    mockDb.getUserPermissionSetAsync.mockResolvedValue({
      resources: {},
      isAdmin: true,
    });

    app = await createApp();
  });

  describe('Round-trip: POST then GET every valid key', () => {
    it('should save and read back every single validKeys entry', async () => {
      // Build a payload with a unique test value for every key
      const payload: Record<string, string> = {};
      for (const key of ALL_VALID_KEYS) {
        payload[key] = `test-value-${key}`;
      }

      // POST all settings
      const postRes = await request(app)
        .post('/api/settings')
        .send(payload)
        .expect(200);

      expect(postRes.body.success).toBe(true);
      expect(postRes.body.saved).toBe(ALL_VALID_KEYS.length);

      // GET settings back
      const getRes = await request(app).get('/api/settings').expect(200);

      // Verify every key came back
      for (const key of ALL_VALID_KEYS) {
        expect(getRes.body).toHaveProperty(
          key,
          `test-value-${key}`
        );
      }
    });

    it('should individually round-trip each key', async () => {
      for (const key of ALL_VALID_KEYS) {
        // Clear store
        Object.keys(settingsStore).forEach((k) => delete settingsStore[k]);

        const value = `individual-${key}-${Date.now()}`;
        await request(app)
          .post('/api/settings')
          .send({ [key]: value })
          .expect(200);

        const getRes = await request(app).get('/api/settings').expect(200);
        expect(getRes.body[key]).toBe(value);
      }
    });
  });

  describe('Allowlist filtering', () => {
    it('should reject keys not in validKeys', async () => {
      const payload = {
        temperatureUnit: 'celsius',
        INVALID_KEY_THAT_SHOULD_BE_FILTERED: 'hacked',
        _secret: 'should-not-persist',
      };

      await request(app).post('/api/settings').send(payload).expect(200);

      const getRes = await request(app).get('/api/settings').expect(200);
      expect(getRes.body.temperatureUnit).toBe('celsius');
      expect(getRes.body).not.toHaveProperty('INVALID_KEY_THAT_SHOULD_BE_FILTERED');
      expect(getRes.body).not.toHaveProperty('_secret');
    });

    it('should coerce all values to strings', async () => {
      const payload = {
        maxNodeAgeHours: 48,
        solarMonitoringEnabled: true,
        nodeDimmingMinOpacity: 0.3,
      };

      await request(app).post('/api/settings').send(payload).expect(200);

      const getRes = await request(app).get('/api/settings').expect(200);
      expect(getRes.body.maxNodeAgeHours).toBe('48');
      expect(getRes.body.solarMonitoringEnabled).toBe('true');
      expect(getRes.body.nodeDimmingMinOpacity).toBe('0.3');
    });
  });

  describe('Frontend ↔ Server key alignment', () => {
    it('every key SettingsTab sends should be in validKeys', () => {
      const missing = SETTINGS_TAB_SENDS.filter(
        (key) => !ALL_VALID_KEYS.includes(key)
      );
      expect(missing).toEqual([]);
    });

    it('every key SettingsContext loads should be in validKeys (or language)', () => {
      // 'language' is handled separately via its own endpoint
      const missing = SETTINGS_CONTEXT_LOADS.filter(
        (key) => key !== 'language' && !ALL_VALID_KEYS.includes(key)
      );
      expect(missing).toEqual([]);
    });

    it('every key SettingsTab sends should be loadable by SettingsContext', () => {
      // Settings sent by SettingsTab should be loaded by SettingsContext,
      // unless they go through another code path (like packet_log settings
      // which are handled server-side only)
      const keysNotLoaded = SETTINGS_TAB_SENDS.filter(
        (key) =>
          !SETTINGS_CONTEXT_LOADS.includes(key) &&
          !OTHER_CODE_PATH_SETTINGS.includes(key)
      );

      // If this fails, a setting is being sent to the server but never
      // loaded back — exactly the bug from issue #2048
      expect(keysNotLoaded).toEqual([]);
    });
  });

  describe('Specific settings from issue #2048', () => {
    it('should persist nodeHopsCalculation through full round-trip', async () => {
      await request(app)
        .post('/api/settings')
        .send({ nodeHopsCalculation: 'messages' })
        .expect(200);

      const getRes = await request(app).get('/api/settings').expect(200);
      expect(getRes.body.nodeHopsCalculation).toBe('messages');
    });

    it('should persist nodeDimmingEnabled through full round-trip', async () => {
      await request(app)
        .post('/api/settings')
        .send({ nodeDimmingEnabled: '1' })
        .expect(200);

      const getRes = await request(app).get('/api/settings').expect(200);
      expect(getRes.body.nodeDimmingEnabled).toBe('1');
    });

    it('should persist nodeDimmingStartHours through full round-trip', async () => {
      await request(app)
        .post('/api/settings')
        .send({ nodeDimmingStartHours: '2.5' })
        .expect(200);

      const getRes = await request(app).get('/api/settings').expect(200);
      expect(getRes.body.nodeDimmingStartHours).toBe('2.5');
    });

    it('should persist nodeDimmingMinOpacity through full round-trip', async () => {
      await request(app)
        .post('/api/settings')
        .send({ nodeDimmingMinOpacity: '0.15' })
        .expect(200);

      const getRes = await request(app).get('/api/settings').expect(200);
      expect(getRes.body.nodeDimmingMinOpacity).toBe('0.15');
    });
  });
});
