/**
 * Settings Persistence Tests
 *
 * Verifies that EVERY setting in VALID_SETTINGS_KEYS can be saved via
 * POST /api/settings and read back via GET /api/settings. Both the server
 * and this test import from the same shared constant
 * (src/server/constants/settings.ts).
 *
 * The test also reads the frontend source files (SettingsTab.tsx and
 * SettingsContext.tsx) and regex-extracts which keys they actually
 * reference. This catches desyncs automatically — if a developer adds a
 * setting to the frontend but forgets the server allowlist, this test
 * fails without anyone needing to update a hardcoded list.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { Express } from 'express';
import session from 'express-session';
import request from 'supertest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { VALID_SETTINGS_KEYS } from './constants/settings.js';

// ─── Database mock ────────────────────────────────────────────────────────
// In-memory store that mimics setSetting / getAllSettings round-trip
const settingsStore: Record<string, string> = {};

vi.mock('../services/database.js', () => ({
  default: {
    drizzleDbType: 'sqlite',
    getAllSettings: vi.fn(() => ({ ...settingsStore })),
    setSettings: vi.fn((settings: Record<string, string>) => {
      Object.assign(settingsStore, settings);
    }),
    setSetting: vi.fn((key: string, value: string) => {
      settingsStore[key] = value;
    }),
    getSetting: vi.fn((key: string) => settingsStore[key] ?? null),
    deleteAllSettings: vi.fn(() => {
      Object.keys(settingsStore).forEach((k) => delete settingsStore[k]);
    }),
    handleAutoWelcomeEnabled: vi.fn(() => 0),
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
  setSettings: ReturnType<typeof vi.fn>;
  setSetting: ReturnType<typeof vi.fn>;
  getSetting: ReturnType<typeof vi.fn>;
  deleteAllSettings: ReturnType<typeof vi.fn>;
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

// Import the REAL settings router — this is what server.ts mounts
import settingsRoutes from './routes/settingsRoutes.js';

/** Build an Express app that mounts the real settings routes */
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

  // Inject authenticated admin session + req.user (needed by the real handler)
  app.use((req, _res, next) => {
    req.session.userId = adminUser.id;
    req.session.username = adminUser.username;
    (req as any).user = adminUser;
    next();
  });

  // Mount the real settings router at /api/settings
  app.use('/api/settings', settingsRoutes);

  return app;
}

// ─── The canonical list of ALL valid settings ─────────────────────────────
// Imported from the shared constant — single source of truth for server.ts
// and this test file.
const ALL_VALID_KEYS: readonly string[] = VALID_SETTINGS_KEYS;

/**
 * Generate a valid test value for a given settings key.
 *
 * The real POST handler validates certain keys (regex patterns, channel
 * indices, JSON triggers, numeric ranges, etc.), so we need values that
 * pass validation rather than naive `test-value-${key}` strings.
 */
function validTestValue(key: string, suffix = ''): string {
  // Keys with specific validation requirements
  const VALID_VALUES: Record<string, string> = {
    autoAckRegex: 'hello',
    autoAckChannels: '0,1',
    inactiveNodeThresholdHours: '24',
    inactiveNodeCheckIntervalMinutes: '60',
    inactiveNodeCooldownHours: '24',
    autoResponderTriggers: JSON.stringify([
      { id: '1', trigger: 'test', responseType: 'text', response: 'hi' },
    ]),
    timerTriggers: JSON.stringify([
      {
        id: '1',
        name: 'test',
        cronExpression: '0 * * * *',
        responseType: 'text',
        response: 'hi',
        enabled: true,
      },
    ]),
    geofenceTriggers: JSON.stringify([
      {
        id: '1',
        name: 'test',
        shape: { type: 'circle', center: { lat: 40, lng: -74 }, radiusKm: 1 },
        event: 'entry',
        responseType: 'text',
        response: 'entered',
        channel: 0,
        enabled: true,
      },
    ]),
    customTilesets: JSON.stringify([]),
    telemetryFavorites: JSON.stringify(['temperature']),
    telemetryCustomOrder: JSON.stringify(['temperature', 'humidity']),
    dashboardWidgets: JSON.stringify([]),
    autoAnnounceSchedule: JSON.stringify({ start: '08:00', end: '18:00' }),
    autoAnnounceNodeInfoChannels: '0',
  };

  if (key in VALID_VALUES) {
    return VALID_VALUES[key];
  }

  // Default: a plain string value that won't trip any validator
  return `test-${key}${suffix}`;
}

// ─── Dynamic source extraction ────────────────────────────────────────────
// Instead of hardcoded arrays, we read the frontend source files at test
// time and regex-extract which settings keys they actually reference.
// This catches desyncs between frontend code and the server allowlist.

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SRC_ROOT = resolve(__dirname, '..');

/**
 * Extract property keys from the `const settings = { ... }` object literal
 * inside SettingsTab.tsx's handleSave function.
 *
 * Matches lines like: `keyName: someValue,`
 */
function extractSettingsTabSends(): string[] {
  const source = readFileSync(
    resolve(SRC_ROOT, 'components/SettingsTab.tsx'),
    'utf-8'
  );

  // Find the `const settings = {` block inside handleSave
  const handleSaveMatch = source.match(
    /const handleSave[\s\S]*?const settings\s*=\s*\{([\s\S]*?)\};/
  );
  if (!handleSaveMatch) {
    throw new Error(
      'Could not find `const settings = { ... }` in SettingsTab.tsx handleSave. ' +
      'Has the save pattern changed? Update this regex.'
    );
  }

  const block = handleSaveMatch[1];
  const keys: string[] = [];
  // Match each `keyName:` property (word chars before the colon)
  for (const match of block.matchAll(/^\s+(\w+)\s*:/gm)) {
    keys.push(match[1]);
  }

  if (keys.length === 0) {
    throw new Error(
      'Extracted 0 keys from SettingsTab.tsx handleSave settings object. ' +
      'The regex may need updating.'
    );
  }

  return keys;
}

/**
 * Extract setting keys from SettingsContext.tsx's loadServerSettings function.
 *
 * Matches `settings.keyName` property accesses between the
 * `loadServerSettings` function declaration and the
 * "Settings loaded from server" log line.
 */
function extractSettingsContextLoads(): string[] {
  const source = readFileSync(
    resolve(SRC_ROOT, 'contexts/SettingsContext.tsx'),
    'utf-8'
  );

  // Extract the loadServerSettings function body up to the completion log
  const fnMatch = source.match(
    /const loadServerSettings[\s\S]*?Settings loaded from server/
  );
  if (!fnMatch) {
    throw new Error(
      'Could not find loadServerSettings function in SettingsContext.tsx. ' +
      'Has the function been renamed or the log message changed?'
    );
  }

  const fnBody = fnMatch[0];
  const keys = new Set<string>();
  // Match `settings.keyName` — word boundary ensures we don't match
  // sub-properties or method calls
  for (const match of fnBody.matchAll(/settings\.(\w+)/g)) {
    keys.add(match[1]);
  }

  if (keys.size === 0) {
    throw new Error(
      'Extracted 0 keys from SettingsContext.tsx loadServerSettings. ' +
      'The regex may need updating.'
    );
  }

  return [...keys];
}

// Extract at module load — test will fail fast if patterns change
const SETTINGS_TAB_SENDS = extractSettingsTabSends();
const SETTINGS_CONTEXT_LOADS = extractSettingsContextLoads();

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
      // Build a payload with a valid test value for every key
      const payload: Record<string, string> = {};
      for (const key of ALL_VALID_KEYS) {
        payload[key] = validTestValue(key);
      }

      // POST all settings via the REAL route handler
      const postRes = await request(app)
        .post('/api/settings')
        .send(payload)
        .expect(200);

      expect(postRes.body.success).toBe(true);
      expect(Object.keys(postRes.body.settings).length).toBe(ALL_VALID_KEYS.length);

      // GET settings back
      const getRes = await request(app).get('/api/settings').expect(200);

      // Verify every key came back with the value we sent
      for (const key of ALL_VALID_KEYS) {
        expect(getRes.body).toHaveProperty(key, validTestValue(key));
      }
    });

    it('should individually round-trip each key', async () => {
      for (const key of ALL_VALID_KEYS) {
        // Clear store
        Object.keys(settingsStore).forEach((k) => delete settingsStore[k]);

        const value = validTestValue(key);
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

  describe('Frontend ↔ Server key alignment (extracted from source)', () => {
    it('extraction should find a reasonable number of keys', () => {
      // Sanity check — if these drop to 0 the regex broke
      expect(SETTINGS_TAB_SENDS.length).toBeGreaterThan(20);
      expect(SETTINGS_CONTEXT_LOADS.length).toBeGreaterThan(20);
    });

    it('every key SettingsTab sends should be in VALID_SETTINGS_KEYS', () => {
      const missing = SETTINGS_TAB_SENDS.filter(
        (key) => !ALL_VALID_KEYS.includes(key)
      );
      expect(missing).toEqual([]);
    });

    it('every key SettingsContext loads should be in VALID_SETTINGS_KEYS (or language)', () => {
      // 'language' is handled separately via its own endpoint
      const missing = SETTINGS_CONTEXT_LOADS.filter(
        (key) => key !== 'language' && !ALL_VALID_KEYS.includes(key)
      );
      expect(missing).toEqual([]);
    });

    it('every key SettingsTab sends should be loaded by SettingsContext or be server-only', () => {
      // Settings the UI sends to the server should either be loaded back
      // by SettingsContext OR be explicitly server-only (read by backend
      // directly, never reflected to frontend state).
      //
      // Server-only settings are those in VALID_SETTINGS_KEYS that the
      // SettingsTab sends but SettingsContext does NOT load. We keep a
      // small allowlist of known server-only keys so we can distinguish
      // "intentionally not loaded" from "accidentally forgotten" (#2048).
      const SERVER_ONLY_SETTINGS = [
        // Packet log settings — backend reads directly
        'packet_log_enabled', 'packet_log_max_count', 'packet_log_max_age_hours',
        // Node visibility — backend reads directly
        'hideIncompleteNodes',
        // Homoglyph detection — backend reads directly
        'homoglyphEnabled',
        // Local stats interval — backend reads directly
        'localStatsIntervalMinutes',
      ];

      const keysNotLoaded = SETTINGS_TAB_SENDS.filter(
        (key) =>
          !SETTINGS_CONTEXT_LOADS.includes(key) &&
          !SERVER_ONLY_SETTINGS.includes(key)
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
