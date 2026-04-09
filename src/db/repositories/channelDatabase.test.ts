/**
 * Multi-Database Channel Database Repository Tests
 *
 * Validates ChannelDatabaseRepository against SQLite, PostgreSQL, and MySQL backends
 * using the shared test factory from test-utils.ts.
 *
 * SQLite: always runs (in-memory)
 * PostgreSQL: requires test container on port 5433 (skipped if unavailable)
 * MySQL: requires test container on port 3307 (skipped if unavailable)
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from 'vitest';
import * as schema from '../schema/index.js';
import { ChannelDatabaseRepository } from './channelDatabase.js';
import {
  TestBackend,
  createSqliteBackend,
  createPostgresBackend,
  createMysqlBackend,
  clearTable,
  postgresAvailable,
  mysqlAvailable,
} from './test-utils.js';

// ============ TABLE CREATION SQL ============

const SQLITE_CREATE = `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    auth_provider TEXT NOT NULL DEFAULT 'local',
    mfa_enabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS channel_database (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    psk TEXT NOT NULL,
    psk_length INTEGER NOT NULL DEFAULT 32,
    description TEXT,
    is_enabled INTEGER NOT NULL DEFAULT 1,
    enforce_name_validation INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    decrypted_packet_count INTEGER NOT NULL DEFAULT 0,
    last_decrypted_at INTEGER,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    sourceId TEXT
  );

  CREATE TABLE IF NOT EXISTS channel_database_permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_database_id INTEGER NOT NULL REFERENCES channel_database(id) ON DELETE CASCADE,
    can_view_on_map INTEGER NOT NULL DEFAULT 0,
    can_read INTEGER NOT NULL DEFAULT 0,
    granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    granted_at INTEGER NOT NULL,
    UNIQUE(user_id, channel_database_id)
  );
`;

const POSTGRES_CREATE = `
  DROP TABLE IF EXISTS channel_database_permissions CASCADE;
  DROP TABLE IF EXISTS channel_database CASCADE;
  DROP TABLE IF EXISTS users CASCADE;

  CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    "passwordHash" TEXT NOT NULL,
    "isAdmin" BOOLEAN NOT NULL DEFAULT FALSE,
    "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
    "authProvider" TEXT NOT NULL DEFAULT 'local',
    "mfaEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL
  );

  CREATE TABLE channel_database (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    psk TEXT NOT NULL,
    "pskLength" INTEGER NOT NULL DEFAULT 32,
    description TEXT,
    "isEnabled" BOOLEAN NOT NULL DEFAULT TRUE,
    "enforceNameValidation" BOOLEAN NOT NULL DEFAULT FALSE,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "decryptedPacketCount" INTEGER NOT NULL DEFAULT 0,
    "lastDecryptedAt" BIGINT,
    "createdBy" INTEGER REFERENCES users(id) ON DELETE SET NULL,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "sourceId" TEXT
  );

  CREATE TABLE channel_database_permissions (
    id SERIAL PRIMARY KEY,
    "userId" INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    "channelDatabaseId" INTEGER NOT NULL REFERENCES channel_database(id) ON DELETE CASCADE,
    "canViewOnMap" BOOLEAN NOT NULL DEFAULT FALSE,
    "canRead" BOOLEAN NOT NULL DEFAULT FALSE,
    "grantedBy" INTEGER REFERENCES users(id) ON DELETE SET NULL,
    "grantedAt" BIGINT NOT NULL,
    UNIQUE("userId", "channelDatabaseId")
  );
`;

const MYSQL_CREATE = `
  SET FOREIGN_KEY_CHECKS = 0;
  DROP TABLE IF EXISTS channel_database_permissions;
  DROP TABLE IF EXISTS channel_database;
  DROP TABLE IF EXISTS users;
  SET FOREIGN_KEY_CHECKS = 1;

  CREATE TABLE users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(255) NOT NULL UNIQUE,
    passwordHash VARCHAR(255) NOT NULL,
    isAdmin BOOLEAN NOT NULL DEFAULT FALSE,
    isActive BOOLEAN NOT NULL DEFAULT TRUE,
    authProvider VARCHAR(255) NOT NULL DEFAULT 'local',
    mfaEnabled BOOLEAN NOT NULL DEFAULT FALSE,
    createdAt BIGINT NOT NULL,
    updatedAt BIGINT NOT NULL
  );

  CREATE TABLE channel_database (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    psk VARCHAR(255) NOT NULL,
    pskLength INT NOT NULL DEFAULT 32,
    description TEXT,
    isEnabled BOOLEAN NOT NULL DEFAULT TRUE,
    enforceNameValidation BOOLEAN NOT NULL DEFAULT FALSE,
    sortOrder INT NOT NULL DEFAULT 0,
    decryptedPacketCount INT NOT NULL DEFAULT 0,
    lastDecryptedAt BIGINT,
    createdBy INT,
    createdAt BIGINT NOT NULL,
    updatedAt BIGINT NOT NULL,
    sourceId VARCHAR(36),
    FOREIGN KEY (createdBy) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE channel_database_permissions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    userId INT NOT NULL,
    channelDatabaseId INT NOT NULL,
    canViewOnMap BOOLEAN NOT NULL DEFAULT FALSE,
    canRead BOOLEAN NOT NULL DEFAULT FALSE,
    grantedBy INT,
    grantedAt BIGINT NOT NULL,
    UNIQUE(userId, channelDatabaseId),
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (channelDatabaseId) REFERENCES channel_database(id) ON DELETE CASCADE,
    FOREIGN KEY (grantedBy) REFERENCES users(id) ON DELETE SET NULL
  );
`;

// ============ USER INSERT SQL ============

function insertUserSql(dbType: string): string {
  const now = Date.now();
  switch (dbType) {
    case 'sqlite':
      return `INSERT INTO users (username, password_hash, is_admin, is_active, auth_provider, mfa_enabled, created_at, updated_at)
              VALUES ('testuser', 'hash123', 1, 1, 'local', 0, ${now}, ${now})`;
    case 'postgres':
      return `INSERT INTO users (username, "passwordHash", "isAdmin", "isActive", "authProvider", "mfaEnabled", "createdAt", "updatedAt")
              VALUES ('testuser', 'hash123', TRUE, TRUE, 'local', FALSE, ${now}, ${now})`;
    case 'mysql':
      return `INSERT INTO users (username, passwordHash, isAdmin, isActive, authProvider, mfaEnabled, createdAt, updatedAt)
              VALUES ('testuser', 'hash123', TRUE, TRUE, 'local', FALSE, ${now}, ${now})`;
    default:
      throw new Error(`Unknown dbType: ${dbType}`);
  }
}

/**
 * Shared test suite that runs against any backend.
 */
function runChannelDbTests(getBackend: () => TestBackend) {
  let repo: ChannelDatabaseRepository;
  let testUserId: number;

  beforeEach(async () => {
    const backend = getBackend();
    if (!backend.available) return;
    repo = new ChannelDatabaseRepository(backend.drizzleDb, backend.dbType);

    // Insert a test user for FK references
    await backend.exec(insertUserSql(backend.dbType));
    // The first inserted user gets id=1 (auto-increment)
    testUserId = 1;
  });

  // --- Channel CRUD ---

  it('createAsync / getByIdAsync - create and retrieve a channel', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const id = await repo.createAsync({
      name: 'TestChannel',
      psk: 'dGVzdHBzaw==',
      pskLength: 32,
      description: 'A test channel',
      isEnabled: true,
    });

    expect(id).toBeGreaterThan(0);

    const channel = await repo.getByIdAsync(id);
    expect(channel).not.toBeNull();
    expect(channel!.name).toBe('TestChannel');
    expect(channel!.psk).toBe('dGVzdHBzaw==');
    expect(channel!.pskLength).toBe(32);
    expect(channel!.description).toBe('A test channel');
    expect(channel!.isEnabled).toBe(true);
    expect(channel!.enforceNameValidation).toBe(false);
    expect(channel!.sortOrder).toBe(0);
    expect(channel!.decryptedPacketCount).toBe(0);
    expect(channel!.lastDecryptedAt).toBeNull();
  });

  it('getByIdAsync - returns null for non-existent id', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const result = await repo.getByIdAsync(99999);
    expect(result).toBeNull();
  });

  it('getAllAsync / getEnabledAsync - list all vs enabled only', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.createAsync({ name: 'Ch1', psk: 'cHNrMQ==', pskLength: 16, isEnabled: true });
    await repo.createAsync({ name: 'Ch2', psk: 'cHNrMg==', pskLength: 16, isEnabled: false });
    await repo.createAsync({ name: 'Ch3', psk: 'cHNrMw==', pskLength: 32, isEnabled: true });

    const all = await repo.getAllAsync();
    expect(all.length).toBe(3);

    const enabled = await repo.getEnabledAsync();
    expect(enabled.length).toBe(2);
    expect(enabled.every(c => c.isEnabled)).toBe(true);
  });

  it('updateAsync - update name, psk, and enabled status', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const id = await repo.createAsync({ name: 'Original', psk: 'b3Jp', pskLength: 16 });

    await repo.updateAsync(id, {
      name: 'Updated',
      psk: 'dXBk',
      isEnabled: false,
    });

    const updated = await repo.getByIdAsync(id);
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe('Updated');
    expect(updated!.psk).toBe('dXBk');
    expect(updated!.isEnabled).toBe(false);
  });

  it('deleteAsync - delete an entry', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const id = await repo.createAsync({ name: 'ToDelete', psk: 'ZGVs', pskLength: 16 });
    expect(await repo.getByIdAsync(id)).not.toBeNull();

    await repo.deleteAsync(id);
    expect(await repo.getByIdAsync(id)).toBeNull();
  });

  it('incrementDecryptedCountAsync - increments counter atomically', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const id = await repo.createAsync({ name: 'Counter', psk: 'Y250', pskLength: 16 });

    await repo.incrementDecryptedCountAsync(id);
    await repo.incrementDecryptedCountAsync(id);
    await repo.incrementDecryptedCountAsync(id);

    const channel = await repo.getByIdAsync(id);
    expect(channel).not.toBeNull();
    expect(channel!.decryptedPacketCount).toBe(3);
    expect(channel!.lastDecryptedAt).not.toBeNull();
  });

  it('reorderAsync - update sort orders for multiple entries', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const id1 = await repo.createAsync({ name: 'First', psk: 'MQ==', pskLength: 16 });
    const id2 = await repo.createAsync({ name: 'Second', psk: 'Mg==', pskLength: 16 });
    const id3 = await repo.createAsync({ name: 'Third', psk: 'Mw==', pskLength: 16 });

    await repo.reorderAsync([
      { id: id1, sortOrder: 3 },
      { id: id2, sortOrder: 1 },
      { id: id3, sortOrder: 2 },
    ]);

    const all = await repo.getAllAsync();
    // getAllAsync orders by sortOrder asc, then id asc
    expect(all[0].name).toBe('Second');
    expect(all[0].sortOrder).toBe(1);
    expect(all[1].name).toBe('Third');
    expect(all[1].sortOrder).toBe(2);
    expect(all[2].name).toBe('First');
    expect(all[2].sortOrder).toBe(3);
  });

  // --- Permission Methods ---

  it('setPermissionAsync / getPermissionAsync - create and retrieve permission', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const channelId = await repo.createAsync({ name: 'PermCh', psk: 'cGVybQ==', pskLength: 16 });

    await repo.setPermissionAsync({
      userId: testUserId,
      channelDatabaseId: channelId,
      canViewOnMap: true,
      canRead: true,
    });

    const perm = await repo.getPermissionAsync(testUserId, channelId);
    expect(perm).not.toBeNull();
    expect(perm!.userId).toBe(testUserId);
    expect(perm!.channelDatabaseId).toBe(channelId);
    expect(perm!.canViewOnMap).toBe(true);
    expect(perm!.canRead).toBe(true);
  });

  it('setPermissionAsync - upserts existing permission', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const channelId = await repo.createAsync({ name: 'UpsertCh', psk: 'dXBz', pskLength: 16 });

    await repo.setPermissionAsync({
      userId: testUserId,
      channelDatabaseId: channelId,
      canViewOnMap: false,
      canRead: true,
    });

    // Update the permission
    await repo.setPermissionAsync({
      userId: testUserId,
      channelDatabaseId: channelId,
      canViewOnMap: true,
      canRead: false,
    });

    const perm = await repo.getPermissionAsync(testUserId, channelId);
    expect(perm).not.toBeNull();
    expect(perm!.canViewOnMap).toBe(true);
    expect(perm!.canRead).toBe(false);
  });

  it('getPermissionAsync - returns null for non-existent permission', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const result = await repo.getPermissionAsync(testUserId, 99999);
    expect(result).toBeNull();
  });

  it('getPermissionsForUserAsync - returns all permissions for a user', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const ch1 = await repo.createAsync({ name: 'UserPerm1', psk: 'MQ==', pskLength: 16 });
    const ch2 = await repo.createAsync({ name: 'UserPerm2', psk: 'Mg==', pskLength: 16 });

    await repo.setPermissionAsync({
      userId: testUserId,
      channelDatabaseId: ch1,
      canViewOnMap: true,
      canRead: true,
    });
    await repo.setPermissionAsync({
      userId: testUserId,
      channelDatabaseId: ch2,
      canViewOnMap: false,
      canRead: true,
    });

    const perms = await repo.getPermissionsForUserAsync(testUserId);
    expect(perms.length).toBe(2);
  });

  it('getPermissionsForChannelAsync - returns all permissions for a channel', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const channelId = await repo.createAsync({ name: 'ChPerm', psk: 'Y2g=', pskLength: 16 });

    await repo.setPermissionAsync({
      userId: testUserId,
      channelDatabaseId: channelId,
      canViewOnMap: true,
      canRead: true,
    });

    const perms = await repo.getPermissionsForChannelAsync(channelId);
    expect(perms.length).toBe(1);
    expect(perms[0].userId).toBe(testUserId);
  });

  it('deletePermissionAsync - removes a specific permission', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const channelId = await repo.createAsync({ name: 'DelPerm', psk: 'ZGVs', pskLength: 16 });

    await repo.setPermissionAsync({
      userId: testUserId,
      channelDatabaseId: channelId,
      canViewOnMap: true,
      canRead: true,
    });

    expect(await repo.getPermissionAsync(testUserId, channelId)).not.toBeNull();

    await repo.deletePermissionAsync(testUserId, channelId);

    expect(await repo.getPermissionAsync(testUserId, channelId)).toBeNull();
  });
}

// --- SQLite Backend ---
describe('ChannelDatabaseRepository - SQLite Backend', () => {
  let backend: TestBackend;

  beforeEach(() => {
    backend = createSqliteBackend(SQLITE_CREATE);
  });

  afterEach(async () => {
    await backend.close();
  });

  runChannelDbTests(() => backend);
});

// --- PostgreSQL Backend ---
describe.skipIf(!postgresAvailable)('ChannelDatabaseRepository - PostgreSQL Backend', () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await createPostgresBackend(POSTGRES_CREATE);
    if (backend.available) {
      console.log('✓ PostgreSQL connection established for channel database tests');
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
    // Clear in correct order for FK constraints
    await clearTable(backend, 'channel_database_permissions');
    await clearTable(backend, 'channel_database');
    await clearTable(backend, 'users');
  });

  runChannelDbTests(() => backend);
});

// --- MySQL Backend ---
describe.skipIf(!mysqlAvailable)('ChannelDatabaseRepository - MySQL Backend', () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await createMysqlBackend(MYSQL_CREATE);
    if (backend.available) {
      console.log('✓ MySQL connection established for channel database tests');
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
    // Must disable FK checks for MySQL truncate, or clear in order
    await backend.exec('SET FOREIGN_KEY_CHECKS = 0');
    await clearTable(backend, 'channel_database_permissions');
    await clearTable(backend, 'channel_database');
    await clearTable(backend, 'users');
    await backend.exec('SET FOREIGN_KEY_CHECKS = 1');
  });

  runChannelDbTests(() => backend);
});
