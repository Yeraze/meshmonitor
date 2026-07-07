/**
 * Multi-Database Notifications Repository Tests
 *
 * Validates NotificationsRepository against SQLite, PostgreSQL, and MySQL backends
 * using the shared test factory from test-utils.ts.
 *
 * SQLite: always runs (in-memory)
 * PostgreSQL: requires test container on port 5433 (skipped if unavailable)
 * MySQL: requires test container on port 3307 (skipped if unavailable)
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from 'vitest';
import { NotificationsRepository, NotificationPreferences } from './notifications.js';
import { ALL_SOURCES } from './base.js';
import {
  TestBackend,
  createPostgresBackend,
  createMysqlBackend,
  clearTable,
  postgresAvailable,
  mysqlAvailable,
} from './test-utils.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

const POSTGRES_CREATE = `
  DROP TABLE IF EXISTS read_messages CASCADE;
  DROP TABLE IF EXISTS messages CASCADE;
  DROP TABLE IF EXISTS user_notification_preferences CASCADE;
  DROP TABLE IF EXISTS push_subscriptions CASCADE;
  DROP TABLE IF EXISTS users CASCADE;
  DROP TABLE IF EXISTS nodes CASCADE;

  CREATE TABLE nodes (
    "nodeNum" BIGINT PRIMARY KEY,
    "longName" TEXT,
    "shortName" TEXT,
    "macAddr" TEXT,
    "hwModel" TEXT,
    "role" TEXT,
    "firmwareVersion" TEXT,
    "hasDefaultChannel" BOOLEAN DEFAULT FALSE,
    "numOnlineLocalNodes" INTEGER,
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    altitude DOUBLE PRECISION,
    snr DOUBLE PRECISION,
    "lastHeard" BIGINT,
    "isOnline" BOOLEAN DEFAULT FALSE,
    "uptimeSeconds" BIGINT,
    "airUtilTx" DOUBLE PRECISION,
    "channelUtilization" DOUBLE PRECISION,
    "hopsAway" INTEGER,
    "isFavorite" BOOLEAN DEFAULT FALSE,
    "isIgnored" BOOLEAN DEFAULT FALSE,
    "outboundMessage" TEXT,
    "nodeId" TEXT,
    "viaMqtt" BOOLEAN DEFAULT FALSE,
    "createdAt" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" BIGINT NOT NULL DEFAULT 0,
    "publicKey" TEXT,
    "inferredKey" BOOLEAN DEFAULT FALSE,
    "isManaged" BOOLEAN DEFAULT FALSE,
    "keyMismatch" BOOLEAN DEFAULT FALSE
  );

  CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    "passwordHash" TEXT,
    email TEXT,
    "displayName" TEXT,
    "authMethod" TEXT NOT NULL DEFAULT 'local',
    "oidcSubject" TEXT UNIQUE,
    "isAdmin" BOOLEAN NOT NULL DEFAULT FALSE,
    "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
    "passwordLocked" BOOLEAN DEFAULT FALSE,
    "mfaEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
    "mfaSecret" TEXT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL
  );

  CREATE TABLE push_subscriptions (
    id SERIAL PRIMARY KEY,
    "userId" INTEGER REFERENCES users(id) ON DELETE CASCADE,
    "sourceId" TEXT NOT NULL DEFAULT '',
    endpoint TEXT NOT NULL,
    "p256dhKey" TEXT NOT NULL,
    "authKey" TEXT NOT NULL,
    "userAgent" TEXT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "lastUsedAt" BIGINT,
    UNIQUE("userId", endpoint, "sourceId")
  );

  CREATE TABLE user_notification_preferences (
    id SERIAL PRIMARY KEY,
    "userId" INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    "sourceId" TEXT NOT NULL DEFAULT '',
    "notifyOnMessage" BOOLEAN DEFAULT TRUE,
    "notifyOnDirectMessage" BOOLEAN DEFAULT TRUE,
    "notifyOnChannelMessage" BOOLEAN DEFAULT FALSE,
    "notifyOnEmoji" BOOLEAN DEFAULT FALSE,
    "notifyOnNewNode" BOOLEAN DEFAULT TRUE,
    "notifyOnTraceroute" BOOLEAN DEFAULT TRUE,
    "notifyOnInactiveNode" BOOLEAN DEFAULT FALSE,
    "notifyOnLowBattery" BOOLEAN DEFAULT FALSE,
    "lowBatteryThreshold" INTEGER DEFAULT 20,
    "lowBatteryVoltageThreshold" INTEGER DEFAULT 3300,
    "notifyOnServerEvents" BOOLEAN DEFAULT FALSE,
    "prefixWithNodeName" BOOLEAN DEFAULT FALSE,
    "appriseEnabled" BOOLEAN DEFAULT TRUE,
    "appriseUrls" TEXT,
    "enabledChannels" TEXT,
    "monitoredNodes" TEXT,
    "whitelist" TEXT,
    "blacklist" TEXT,
    "notifyOnMqtt" BOOLEAN DEFAULT TRUE,
    "mutedChannels" TEXT,
    "mutedDMs" TEXT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    UNIQUE("userId", "sourceId")
  );

  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    "fromNodeNum" BIGINT NOT NULL,
    "toNodeNum" BIGINT NOT NULL,
    "fromNodeId" TEXT NOT NULL,
    "toNodeId" TEXT NOT NULL,
    text TEXT NOT NULL,
    channel INTEGER NOT NULL DEFAULT 0,
    portnum INTEGER,
    "requestId" INTEGER,
    timestamp BIGINT NOT NULL,
    "rxTime" BIGINT,
    "hopStart" INTEGER,
    "hopLimit" INTEGER,
    "relayNode" BIGINT,
    "replyId" INTEGER,
    emoji INTEGER,
    "viaMqtt" BOOLEAN,
    "rxSnr" DOUBLE PRECISION,
    "rxRssi" DOUBLE PRECISION,
    "sourceId" TEXT
  );

  CREATE TABLE read_messages (
    id SERIAL PRIMARY KEY,
    "userId" INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    "messageId" TEXT NOT NULL,
    "readAt" BIGINT NOT NULL,
    UNIQUE ("messageId", "userId")
  );
`;

const MYSQL_CREATE = `
  SET FOREIGN_KEY_CHECKS = 0;
  DROP TABLE IF EXISTS read_messages;
  DROP TABLE IF EXISTS messages;
  DROP TABLE IF EXISTS user_notification_preferences;
  DROP TABLE IF EXISTS push_subscriptions;
  DROP TABLE IF EXISTS users;
  DROP TABLE IF EXISTS nodes;
  SET FOREIGN_KEY_CHECKS = 1;

  CREATE TABLE nodes (
    nodeNum BIGINT PRIMARY KEY,
    longName TEXT,
    shortName TEXT,
    macAddr TEXT,
    hwModel TEXT,
    role TEXT,
    firmwareVersion TEXT,
    hasDefaultChannel BOOLEAN DEFAULT FALSE,
    numOnlineLocalNodes INTEGER,
    latitude DOUBLE,
    longitude DOUBLE,
    altitude DOUBLE,
    snr DOUBLE,
    lastHeard BIGINT,
    isOnline BOOLEAN DEFAULT FALSE,
    uptimeSeconds BIGINT,
    airUtilTx DOUBLE,
    channelUtilization DOUBLE,
    hopsAway INTEGER,
    isFavorite BOOLEAN DEFAULT FALSE,
    isIgnored BOOLEAN DEFAULT FALSE,
    outboundMessage TEXT,
    nodeId TEXT,
    viaMqtt BOOLEAN DEFAULT FALSE,
    createdAt BIGINT NOT NULL DEFAULT 0,
    updatedAt BIGINT NOT NULL DEFAULT 0,
    publicKey TEXT,
    inferredKey BOOLEAN DEFAULT FALSE,
    isManaged BOOLEAN DEFAULT FALSE,
    keyMismatch BOOLEAN DEFAULT FALSE
  );

  CREATE TABLE users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(255) NOT NULL UNIQUE,
    passwordHash VARCHAR(255),
    email VARCHAR(255),
    displayName VARCHAR(255),
    authMethod VARCHAR(32) NOT NULL DEFAULT 'local',
    oidcSubject VARCHAR(255) UNIQUE,
    isAdmin BOOLEAN NOT NULL DEFAULT FALSE,
    isActive BOOLEAN NOT NULL DEFAULT TRUE,
    passwordLocked BOOLEAN DEFAULT FALSE,
    mfaEnabled BOOLEAN NOT NULL DEFAULT FALSE,
    mfaSecret TEXT,
    createdAt BIGINT NOT NULL,
    updatedAt BIGINT NOT NULL
  );

  CREATE TABLE push_subscriptions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    userId INTEGER REFERENCES users(id) ON DELETE CASCADE,
    sourceId VARCHAR(64) NOT NULL DEFAULT '',
    endpoint TEXT NOT NULL,
    p256dhKey VARCHAR(512) NOT NULL,
    authKey VARCHAR(128) NOT NULL,
    userAgent VARCHAR(512),
    createdAt BIGINT NOT NULL,
    updatedAt BIGINT NOT NULL,
    lastUsedAt BIGINT,
    UNIQUE KEY unique_user_endpoint_source (userId, endpoint(255), sourceId)
  );

  CREATE TABLE user_notification_preferences (
    id INT AUTO_INCREMENT PRIMARY KEY,
    userId INTEGER NOT NULL,
    sourceId VARCHAR(64) NOT NULL DEFAULT '',
    UNIQUE KEY uniq_user_source (userId, sourceId),
    notifyOnMessage BOOLEAN DEFAULT TRUE,
    notifyOnDirectMessage BOOLEAN DEFAULT TRUE,
    notifyOnChannelMessage BOOLEAN DEFAULT FALSE,
    notifyOnEmoji BOOLEAN DEFAULT FALSE,
    notifyOnNewNode BOOLEAN DEFAULT TRUE,
    notifyOnTraceroute BOOLEAN DEFAULT TRUE,
    notifyOnInactiveNode BOOLEAN DEFAULT FALSE,
    notifyOnLowBattery BOOLEAN DEFAULT FALSE,
    lowBatteryThreshold INT DEFAULT 20,
    lowBatteryVoltageThreshold INT DEFAULT 3300,
    notifyOnServerEvents BOOLEAN DEFAULT FALSE,
    prefixWithNodeName BOOLEAN DEFAULT FALSE,
    appriseEnabled BOOLEAN DEFAULT TRUE,
    appriseUrls TEXT,
    enabledChannels TEXT,
    monitoredNodes TEXT,
    whitelist TEXT,
    blacklist TEXT,
    notifyOnMqtt BOOLEAN DEFAULT TRUE,
    mutedChannels TEXT,
    mutedDMs TEXT,
    createdAt BIGINT NOT NULL,
    updatedAt BIGINT NOT NULL,
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE messages (
    id VARCHAR(64) PRIMARY KEY,
    fromNodeNum BIGINT NOT NULL,
    toNodeNum BIGINT NOT NULL,
    fromNodeId VARCHAR(64) NOT NULL,
    toNodeId VARCHAR(64) NOT NULL,
    \`text\` TEXT NOT NULL,
    channel INTEGER NOT NULL DEFAULT 0,
    portnum INTEGER,
    requestId INTEGER,
    timestamp BIGINT NOT NULL,
    rxTime BIGINT,
    hopStart INTEGER,
    hopLimit INTEGER,
    relayNode BIGINT,
    replyId INTEGER,
    emoji INTEGER,
    viaMqtt BOOLEAN,
    rxSnr DOUBLE,
    rxRssi DOUBLE,
    sourceId VARCHAR(36)
  );

  CREATE TABLE read_messages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    userId INTEGER NOT NULL,
    messageId VARCHAR(64) NOT NULL,
    readAt BIGINT NOT NULL,
    UNIQUE KEY unique_message_user (messageId, userId),
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
  );
`;

// Default test preferences
function makeDefaultPrefs(overrides: Partial<NotificationPreferences> = {}): NotificationPreferences {
  return {
    enableWebPush: false,
    enableApprise: false,
    enabledChannels: [],
    enableDirectMessages: false,
    notifyOnEmoji: false,
    notifyOnMqtt: false,
    notifyOnNewNode: false,
    notifyOnTraceroute: false,
    notifyOnInactiveNode: false,
    notifyOnLowBattery: false,
    lowBatteryThreshold: 20,
    lowBatteryVoltageThreshold: 3300,
    notifyOnServerEvents: false,
    prefixWithNodeName: false,
    monitoredNodes: [],
    whitelist: [],
    blacklist: [],
    appriseUrls: [],
    ...overrides,
  };
}

// SQL to insert a test user per backend
function insertUserSql(backend: TestBackend, id: number, username: string): string {
  const now = Date.now();
  if (backend.dbType === 'sqlite') {
    return `INSERT INTO users (id, username, password_hash, auth_provider, is_admin, is_active, mfa_enabled, created_at, updated_at) VALUES (${id}, '${username}', 'hash', 'local', 0, 1, 0, ${now}, ${now})`;
  } else if (backend.dbType === 'postgres') {
    return `INSERT INTO users (id, username, "passwordHash", "authMethod", "isAdmin", "isActive", "mfaEnabled", "createdAt", "updatedAt") VALUES (${id}, '${username}', 'hash', 'local', FALSE, TRUE, FALSE, ${now}, ${now})`;
  } else {
    return `INSERT INTO users (id, username, passwordHash, authMethod, isAdmin, isActive, mfaEnabled, createdAt, updatedAt) VALUES (${id}, '${username}', 'hash', 'local', FALSE, TRUE, FALSE, ${now}, ${now})`;
  }
}

// SQL to insert a test message per backend
function insertMessageSql(backend: TestBackend, id: string, channel: number, portnum: number, timestamp: number, fromNodeId: string = '!node1', toNodeId: string = '!node2'): string {
  if (backend.dbType === 'sqlite') {
    return `INSERT INTO messages (id, fromNodeNum, toNodeNum, fromNodeId, toNodeId, text, channel, portnum, timestamp, createdAt) VALUES ('${id}', 1, 2, '${fromNodeId}', '${toNodeId}', 'test', ${channel}, ${portnum}, ${timestamp}, ${timestamp})`;
  } else if (backend.dbType === 'postgres') {
    return `INSERT INTO messages (id, "fromNodeNum", "toNodeNum", "fromNodeId", "toNodeId", text, channel, portnum, timestamp) VALUES ('${id}', 1, 2, '${fromNodeId}', '${toNodeId}', 'test', ${channel}, ${portnum}, ${timestamp})`;
  } else {
    return `INSERT INTO messages (id, fromNodeNum, toNodeNum, fromNodeId, toNodeId, \`text\`, channel, portnum, timestamp) VALUES ('${id}', 1, 2, '${fromNodeId}', '${toNodeId}', 'test', ${channel}, ${portnum}, ${timestamp})`;
  }
}

// SQL to insert a test message tagged with a sourceId (per-source tests, #3712)
function insertMessageWithSourceSql(backend: TestBackend, id: string, channel: number, portnum: number, timestamp: number, sourceId: string, fromNodeId: string = '!node1', toNodeId: string = '!node2'): string {
  if (backend.dbType === 'sqlite') {
    return `INSERT INTO messages (id, fromNodeNum, toNodeNum, fromNodeId, toNodeId, text, channel, portnum, timestamp, createdAt, sourceId) VALUES ('${id}', 1, 2, '${fromNodeId}', '${toNodeId}', 'test', ${channel}, ${portnum}, ${timestamp}, ${timestamp}, '${sourceId}')`;
  } else if (backend.dbType === 'postgres') {
    return `INSERT INTO messages (id, "fromNodeNum", "toNodeNum", "fromNodeId", "toNodeId", text, channel, portnum, timestamp, "sourceId") VALUES ('${id}', 1, 2, '${fromNodeId}', '${toNodeId}', 'test', ${channel}, ${portnum}, ${timestamp}, '${sourceId}')`;
  } else {
    return `INSERT INTO messages (id, fromNodeNum, toNodeNum, fromNodeId, toNodeId, \`text\`, channel, portnum, timestamp, sourceId) VALUES ('${id}', 1, 2, '${fromNodeId}', '${toNodeId}', 'test', ${channel}, ${portnum}, ${timestamp}, '${sourceId}')`;
  }
}

// SQL to insert a text message flagged as received via MQTT (viaMqtt = true).
// Used to assert the excludeMqtt unread filter (#3787).
function insertMqttMessageSql(backend: TestBackend, id: string, channel: number, timestamp: number): string {
  if (backend.dbType === 'sqlite') {
    return `INSERT INTO messages (id, fromNodeNum, toNodeNum, fromNodeId, toNodeId, text, channel, portnum, timestamp, createdAt, viaMqtt) VALUES ('${id}', 1, 2, '!node1', '!node2', 'test', ${channel}, 1, ${timestamp}, ${timestamp}, 1)`;
  } else if (backend.dbType === 'postgres') {
    return `INSERT INTO messages (id, "fromNodeNum", "toNodeNum", "fromNodeId", "toNodeId", text, channel, portnum, timestamp, "viaMqtt") VALUES ('${id}', 1, 2, '!node1', '!node2', 'test', ${channel}, 1, ${timestamp}, true)`;
  } else {
    return `INSERT INTO messages (id, fromNodeNum, toNodeNum, fromNodeId, toNodeId, \`text\`, channel, portnum, timestamp, viaMqtt) VALUES ('${id}', 1, 2, '!node1', '!node2', 'test', ${channel}, 1, ${timestamp}, true)`;
  }
}

// SQL to insert a node (needed for foreign keys in messages for sqlite)
function insertNodeSql(backend: TestBackend, nodeNum: number): string {
  const now = Date.now();
  if (backend.dbType === 'sqlite') {
    const nodeId = `!${nodeNum.toString(16).padStart(8, '0')}`;
    return `INSERT OR IGNORE INTO nodes (nodeNum, nodeId, sourceId, createdAt, updatedAt) VALUES (${nodeNum}, '${nodeId}', 'default', ${now}, ${now})`;
  } else if (backend.dbType === 'postgres') {
    return `INSERT INTO nodes ("nodeNum", "createdAt", "updatedAt") VALUES (${nodeNum}, ${now}, ${now}) ON CONFLICT DO NOTHING`;
  } else {
    return `INSERT IGNORE INTO nodes (nodeNum, createdAt, updatedAt) VALUES (${nodeNum}, ${now}, ${now})`;
  }
}

/**
 * Shared test suite that runs against any backend.
 */
function runNotificationsTests(getBackend: () => TestBackend) {
  let repo: NotificationsRepository;

  beforeEach(async () => {
    const backend = getBackend();
    if (!backend.available) return;
    repo = new NotificationsRepository(backend.drizzleDb, backend.dbType);
    // Insert test nodes for message foreign keys
    await backend.exec(insertNodeSql(backend, 1));
    await backend.exec(insertNodeSql(backend, 2));
  });

  // ============ PUSH SUBSCRIPTIONS ============

  describe('Push Subscriptions', () => {
    it('saveSubscription and getUserSubscriptions - save and retrieve', async () => {
      const backend = getBackend();
      if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

      await backend.exec(insertUserSql(backend, 1, 'testuser'));

      await repo.saveSubscription({
        userId: 1,
        sourceId: 'src-test',
        endpoint: 'https://push.example.com/sub1',
        p256dhKey: 'key-p256dh-1',
        authKey: 'key-auth-1',
      });

      const subs = await repo.getUserSubscriptions(1);
      expect(subs).toHaveLength(1);
      expect(subs[0].endpoint).toBe('https://push.example.com/sub1');
      expect(subs[0].p256dhKey).toBe('key-p256dh-1');
      expect(subs[0].authKey).toBe('key-auth-1');
      expect(subs[0].userId).toBe(1);
    });

    it('saveSubscription - upserts on duplicate endpoint', async () => {
      const backend = getBackend();
      if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

      await backend.exec(insertUserSql(backend, 1, 'testuser'));

      await repo.saveSubscription({
        userId: 1,
        sourceId: 'src-test',
        endpoint: 'https://push.example.com/sub1',
        p256dhKey: 'key-old',
        authKey: 'auth-old',
      });

      await repo.saveSubscription({
        userId: 1,
        sourceId: 'src-test',
        endpoint: 'https://push.example.com/sub1',
        p256dhKey: 'key-new',
        authKey: 'auth-new',
      });

      const subs = await repo.getUserSubscriptions(1);
      expect(subs).toHaveLength(1);
      expect(subs[0].p256dhKey).toBe('key-new');
      expect(subs[0].authKey).toBe('auth-new');
    });

    it('getUserSubscriptions - returns empty array for user with no subscriptions', async () => {
      const backend = getBackend();
      if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

      const subs = await repo.getUserSubscriptions(999);
      expect(subs).toEqual([]);
    });

    it('getUserSubscriptions - returns all when userId is null', async () => {
      const backend = getBackend();
      if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

      await backend.exec(insertUserSql(backend, 1, 'user1'));
      await backend.exec(insertUserSql(backend, 2, 'user2'));

      await repo.saveSubscription({
        userId: 1,
        sourceId: 'src-test',
        endpoint: 'https://push.example.com/a',
        p256dhKey: 'k1',
        authKey: 'a1',
      });
      await repo.saveSubscription({
        userId: 2,
        sourceId: 'src-test',
        endpoint: 'https://push.example.com/b',
        p256dhKey: 'k2',
        authKey: 'a2',
      });

      const subs = await repo.getUserSubscriptions(null);
      expect(subs.length).toBeGreaterThanOrEqual(2);
    });

    it('removeSubscription - removes by endpoint', async () => {
      const backend = getBackend();
      if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

      await backend.exec(insertUserSql(backend, 1, 'testuser'));

      await repo.saveSubscription({
        userId: 1,
        sourceId: 'src-test',
        endpoint: 'https://push.example.com/to-remove',
        p256dhKey: 'k1',
        authKey: 'a1',
      });
      await repo.saveSubscription({
        userId: 1,
        sourceId: 'src-test',
        endpoint: 'https://push.example.com/to-keep',
        p256dhKey: 'k2',
        authKey: 'a2',
      });

      await repo.removeSubscription('https://push.example.com/to-remove');

      const subs = await repo.getUserSubscriptions(1);
      expect(subs).toHaveLength(1);
      expect(subs[0].endpoint).toBe('https://push.example.com/to-keep');
    });

    it('removeSubscription - no error when endpoint does not exist', async () => {
      const backend = getBackend();
      if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

      await expect(repo.removeSubscription('https://nonexistent.example.com')).resolves.not.toThrow();
    });

    it('getAllSubscriptions - returns all subscriptions', async () => {
      const backend = getBackend();
      if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

      await backend.exec(insertUserSql(backend, 1, 'user1'));
      await backend.exec(insertUserSql(backend, 2, 'user2'));

      await repo.saveSubscription({ userId: 1, sourceId: 'src-test', endpoint: 'https://a.com', p256dhKey: 'k1', authKey: 'a1' });
      await repo.saveSubscription({ userId: 2, sourceId: 'src-test', endpoint: 'https://b.com', p256dhKey: 'k2', authKey: 'a2' });

      const all = await repo.getAllSubscriptions();
      expect(all.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ============ USER NOTIFICATION PREFERENCES ============

  describe('User Notification Preferences', () => {
    it('saveUserPreferences and getUserPreferences - save and retrieve', async () => {
      const backend = getBackend();
      if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

      await backend.exec(insertUserSql(backend, 1, 'testuser'));

      const prefs = makeDefaultPrefs({
        enableWebPush: true,
        enableApprise: true,
        notifyOnNewNode: true,
        notifyOnLowBattery: true,
        lowBatteryThreshold: 15,
        appriseUrls: ['http://apprise.example.com'],
        monitoredNodes: ['!node1', '!node2'],
        enabledChannels: [0, 1],
      });

      const saved = await repo.saveUserPreferences(1, prefs);
      expect(saved).toBe(true);

      const result = await repo.getUserPreferences(1);
      expect(result).not.toBeNull();
      expect(result!.enableWebPush).toBe(true);
      expect(result!.enableApprise).toBe(true);
      expect(result!.notifyOnNewNode).toBe(true);
      expect(result!.notifyOnLowBattery).toBe(true);
      expect(result!.lowBatteryThreshold).toBe(15);
      expect(result!.appriseUrls).toEqual(['http://apprise.example.com']);
      expect(result!.monitoredNodes).toEqual(['!node1', '!node2']);
      expect(result!.enabledChannels).toEqual([0, 1]);
    });

    it('saveUserPreferences - upserts on duplicate userId', async () => {
      const backend = getBackend();
      if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

      await backend.exec(insertUserSql(backend, 1, 'testuser'));

      await repo.saveUserPreferences(1, makeDefaultPrefs({ enableWebPush: true }));
      await repo.saveUserPreferences(1, makeDefaultPrefs({ enableWebPush: false, enableApprise: true }));

      const result = await repo.getUserPreferences(1);
      expect(result).not.toBeNull();
      expect(result!.enableWebPush).toBe(false);
      expect(result!.enableApprise).toBe(true);
    });

    it('getUserPreferences - returns null for nonexistent user', async () => {
      const backend = getBackend();
      if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

      const result = await repo.getUserPreferences(999);
      expect(result).toBeNull();
    });

    it('getUserPreferences - returns null for invalid userId', async () => {
      const backend = getBackend();
      if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

      const result = await repo.getUserPreferences(-1);
      expect(result).toBeNull();

      const result2 = await repo.getUserPreferences(0);
      expect(result2).toBeNull();
    });

    it('saveUserPreferences - returns false for invalid userId', async () => {
      const backend = getBackend();
      if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

      const saved = await repo.saveUserPreferences(-1, makeDefaultPrefs());
      expect(saved).toBe(false);
    });
  });

  // ============ getUsersWithServiceEnabled ============

  describe('getUsersWithServiceEnabled', () => {
    it('returns user IDs with web_push enabled', async () => {
      const backend = getBackend();
      if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

      await backend.exec(insertUserSql(backend, 1, 'user1'));
      await backend.exec(insertUserSql(backend, 2, 'user2'));
      await backend.exec(insertUserSql(backend, 3, 'user3'));

      await repo.saveUserPreferences(1, makeDefaultPrefs({ enableWebPush: true }));
      await repo.saveUserPreferences(2, makeDefaultPrefs({ enableWebPush: false }));
      await repo.saveUserPreferences(3, makeDefaultPrefs({ enableWebPush: true }));

      const userIds = await repo.getUsersWithServiceEnabled('web_push');
      expect(userIds).toContain(1);
      expect(userIds).not.toContain(2);
      expect(userIds).toContain(3);
    });

    it('returns user IDs with apprise enabled', async () => {
      const backend = getBackend();
      if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

      await backend.exec(insertUserSql(backend, 1, 'user1'));
      await backend.exec(insertUserSql(backend, 2, 'user2'));

      await repo.saveUserPreferences(1, makeDefaultPrefs({ enableApprise: true }));
      await repo.saveUserPreferences(2, makeDefaultPrefs({ enableApprise: false }));

      const userIds = await repo.getUsersWithServiceEnabled('apprise');
      expect(userIds).toContain(1);
      expect(userIds).not.toContain(2);
    });

    it('returns empty array when no users have service enabled', async () => {
      const backend = getBackend();
      if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

      const userIds = await repo.getUsersWithServiceEnabled('web_push');
      expect(userIds).toEqual([]);
    });
  });

  // ============ getUsersWithAppriseEnabled ============

  describe('getUsersWithAppriseEnabled', () => {
    it('returns user IDs with apprise enabled (convenience method)', async () => {
      const backend = getBackend();
      if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

      await backend.exec(insertUserSql(backend, 1, 'user1'));
      await backend.exec(insertUserSql(backend, 2, 'user2'));

      await repo.saveUserPreferences(1, makeDefaultPrefs({ enableApprise: true }));
      await repo.saveUserPreferences(2, makeDefaultPrefs({ enableApprise: false }));

      const userIds = await repo.getUsersWithAppriseEnabled();
      expect(userIds).toContain(1);
      expect(userIds).not.toContain(2);
    });
  });

  // ============ getUsersWithLowBatteryNotifications ============

  describe('getUsersWithLowBatteryNotifications', () => {
    it('returns users with low-battery notifications and an active channel, including threshold and monitored nodes', async () => {
      const backend = getBackend();
      if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

      await backend.exec(insertUserSql(backend, 1, 'user1'));
      await backend.exec(insertUserSql(backend, 2, 'user2'));
      await backend.exec(insertUserSql(backend, 3, 'user3'));

      // user1: enabled + web push on, custom threshold + monitored nodes
      await repo.saveUserPreferences(1, makeDefaultPrefs({
        enableWebPush: true,
        notifyOnLowBattery: true,
        lowBatteryThreshold: 10,
        monitoredNodes: ['!node1'],
      }));
      // user2: low battery on but no active channel (web push + apprise both off) → excluded
      await repo.saveUserPreferences(2, makeDefaultPrefs({
        enableWebPush: false,
        enableApprise: false,
        notifyOnLowBattery: true,
      }));
      // user3: low battery off → excluded
      await repo.saveUserPreferences(3, makeDefaultPrefs({
        enableApprise: true,
        notifyOnLowBattery: false,
      }));

      const users = await repo.getUsersWithLowBatteryNotifications();
      const user1 = users.find((u) => u.userId === 1);
      expect(user1).toBeDefined();
      expect(user1!.lowBatteryThreshold).toBe(10);
      expect(JSON.parse(user1!.monitoredNodes || '[]')).toEqual(['!node1']);
      expect(users.find((u) => u.userId === 2)).toBeUndefined();
      expect(users.find((u) => u.userId === 3)).toBeUndefined();
    });

    // Regression for #3884: the reporter uses Apprise ONLY (no web push). The
    // entry query gates on `or(notifyOnMessage[=enableWebPush], appriseEnabled)`,
    // so an Apprise-only user with low battery enabled must still be returned —
    // the previous test only covered a web-push user, leaving this path unproven.
    it('includes an Apprise-only user (no web push) with low-battery enabled (#3884)', async () => {
      const backend = getBackend();
      if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

      await backend.exec(insertUserSql(backend, 1, 'apprise_user'));
      await repo.saveUserPreferences(1, makeDefaultPrefs({
        enableWebPush: false,       // no web push subscription/channel
        enableApprise: true,        // ...but Apprise is active
        notifyOnLowBattery: true,
        lowBatteryVoltageThreshold: 4100,
        monitoredNodes: ['mc:src-a:deadbeefcafe'],
      }));

      const users = await repo.getUsersWithLowBatteryNotifications();
      const user = users.find((u) => u.userId === 1);
      expect(user).toBeDefined();
      expect(user!.lowBatteryVoltageThreshold).toBe(4100);
      expect(JSON.parse(user!.monitoredNodes || '[]')).toEqual(['mc:src-a:deadbeefcafe']);
    });

    it('returns empty array when no users have low-battery notifications enabled', async () => {
      const backend = getBackend();
      if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

      const users = await repo.getUsersWithLowBatteryNotifications();
      expect(users).toEqual([]);
    });
  });

  // ============ markChannelMessagesAsRead ============

  describe('getUnreadCountsByChannelAsync — excludeMqtt (#3787)', () => {
    it('counts MQTT messages by default but excludes them when excludeMqtt is set', async () => {
      const backend = getBackend();
      if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

      await backend.exec(insertUserSql(backend, 1, 'testuser'));
      // Two RF (non-MQTT) text messages and one MQTT-bridged message on channel 0.
      await backend.exec(insertMessageSql(backend, 'rf1', 0, 1, 1000));
      await backend.exec(insertMessageSql(backend, 'rf2', 0, 1, 2000));
      await backend.exec(insertMqttMessageSql(backend, 'mqtt1', 0, 3000));

      // Default: all three unread messages counted.
      const all = await repo.getUnreadCountsByChannelAsync(1, undefined, ALL_SOURCES, false);
      expect(all[0]).toBe(3);

      // excludeMqtt: the MQTT-bridged message is dropped from the count, so the
      // sidebar dot and per-channel badge stay in sync with the hidden-MQTT view.
      const rfOnly = await repo.getUnreadCountsByChannelAsync(1, undefined, ALL_SOURCES, true);
      expect(rfOnly[0]).toBe(2);
    });
  });

  describe('markChannelMessagesAsRead', () => {
    it('marks channel messages as read for a user', async () => {
      const backend = getBackend();
      if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

      await backend.exec(insertUserSql(backend, 1, 'testuser'));
      // Insert messages on channel 0 with portnum 1 (text messages)
      await backend.exec(insertMessageSql(backend, 'msg1', 0, 1, 1000));
      await backend.exec(insertMessageSql(backend, 'msg2', 0, 1, 2000));
      // Insert message on different channel
      await backend.exec(insertMessageSql(backend, 'msg3', 1, 1, 3000));
      // Insert message with different portnum (not text)
      await backend.exec(insertMessageSql(backend, 'msg4', 0, 2, 4000));

      const count = await repo.markChannelMessagesAsRead(0, 1);
      // Should mark msg1 and msg2 (channel 0, portnum 1)
      expect(count).toBe(2);
    });

    it('marks channel messages with beforeTimestamp filter', async () => {
      const backend = getBackend();
      if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

      await backend.exec(insertUserSql(backend, 1, 'testuser'));
      await backend.exec(insertMessageSql(backend, 'msg1', 0, 1, 1000));
      await backend.exec(insertMessageSql(backend, 'msg2', 0, 1, 2000));
      await backend.exec(insertMessageSql(backend, 'msg3', 0, 1, 3000));

      const count = await repo.markChannelMessagesAsRead(0, 1, 2000);
      // Should mark msg1 and msg2 (timestamp <= 2000)
      expect(count).toBe(2);
    });

    it('returns 0 when no messages match', async () => {
      const backend = getBackend();
      if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

      await backend.exec(insertUserSql(backend, 1, 'testuser'));

      const count = await repo.markChannelMessagesAsRead(99, 1);
      expect(count).toBe(0);
    });

    it('uses userId 0 when null is passed', async () => {
      const backend = getBackend();
      if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

      // For SQLite, userId 0 doesn't need to exist (no FK constraint enforced by default)
      // For PG/MySQL, we need a user with id 0 or skip this specific behavior test
      // The method itself handles null -> 0 conversion, so we just verify no error
      await backend.exec(insertMessageSql(backend, 'msg1', 0, 1, 1000));

      // This should not throw, even with null userId
      // userId maps to 0 internally, which may or may not satisfy FK constraints
      const count = await repo.markChannelMessagesAsRead(0, null);
      expect(typeof count).toBe('number');
    });

    // #3712: marking a channel slot read must not bleed across sources that
    // share the same slot number (e.g. an MQTT bridge and a radio source both
    // using slot 2).
    it('is source-scoped — does not mark other sources\' messages read', async () => {
      const backend = getBackend();
      if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

      await backend.exec(insertUserSql(backend, 1, 'testuser'));
      // Two sources, same slot 2.
      await backend.exec(insertMessageWithSourceSql(backend, 'src-a-1', 2, 1, 1000, 'source-a'));
      await backend.exec(insertMessageWithSourceSql(backend, 'src-a-2', 2, 1, 2000, 'source-a'));
      await backend.exec(insertMessageWithSourceSql(backend, 'src-b-1', 2, 1, 3000, 'source-b'));

      const marked = await repo.markChannelMessagesAsRead(2, 1, undefined, 'source-a');
      // Only source-a's two messages are marked.
      expect(marked).toBe(2);

      // source-b's slot-2 message must remain unread (still markable).
      const markedB = await repo.markChannelMessagesAsRead(2, 1, undefined, 'source-b');
      expect(markedB).toBe(1);
    });

    it('without sourceId, marks across all sources (legacy behaviour)', async () => {
      const backend = getBackend();
      if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

      await backend.exec(insertUserSql(backend, 1, 'testuser'));
      await backend.exec(insertMessageWithSourceSql(backend, 'all-a', 3, 1, 1000, 'source-a'));
      await backend.exec(insertMessageWithSourceSql(backend, 'all-b', 3, 1, 2000, 'source-b'));

      const marked = await repo.markChannelMessagesAsRead(3, 1);
      expect(marked).toBe(2);
    });
  });
}

// --- SQLite Backend ---
describe('NotificationsRepository - SQLite Backend', () => {
  let backend: TestBackend;

  beforeEach(() => {
    const t = createTestDb();
    backend = {
      dbType: 'sqlite',
      drizzleDb: t.db,
      exec: async (sql: string) => { t.sqlite.exec(sql); },
      close: async () => { t.close(); },
      available: true,
    };
  });

  afterEach(async () => {
    await backend.close();
  });

  runNotificationsTests(() => backend);
});

// --- PostgreSQL Backend ---
describe.skipIf(!postgresAvailable)('NotificationsRepository - PostgreSQL Backend', () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await createPostgresBackend(POSTGRES_CREATE);
    if (backend.available) {
      console.log('✓ PostgreSQL connection established for notifications tests');
    } else {
      console.log(`⚠ ${backend.skipReason}`);
    }
  });

  afterAll(async () => {
    if (backend) {
      await backend.close();
    }
  });

  beforeEach(async () => {
    if (!backend.available) return;
    // Clear tables in dependency order
    await clearTable(backend, 'read_messages');
    await clearTable(backend, 'messages');
    await clearTable(backend, 'user_notification_preferences');
    await clearTable(backend, 'push_subscriptions');
    await clearTable(backend, 'users');
    await clearTable(backend, 'nodes');
  });

  runNotificationsTests(() => backend);
});

// --- MySQL Backend ---
describe.skipIf(!mysqlAvailable)('NotificationsRepository - MySQL Backend', () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await createMysqlBackend(MYSQL_CREATE);
    if (backend.available) {
      console.log('✓ MySQL connection established for notifications tests');
    } else {
      console.log(`⚠ ${backend.skipReason}`);
    }
  });

  afterAll(async () => {
    if (backend) {
      await backend.close();
    }
  });

  beforeEach(async () => {
    if (!backend.available) return;
    // Clear tables in dependency order - MySQL needs SET FOREIGN_KEY_CHECKS
    await backend.exec('SET FOREIGN_KEY_CHECKS = 0');
    await clearTable(backend, 'read_messages');
    await clearTable(backend, 'messages');
    await clearTable(backend, 'user_notification_preferences');
    await clearTable(backend, 'push_subscriptions');
    await clearTable(backend, 'users');
    await clearTable(backend, 'nodes');
    await backend.exec('SET FOREIGN_KEY_CHECKS = 1');
  });

  runNotificationsTests(() => backend);
});
