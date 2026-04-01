/**
 * Multi-Database Auth Repository Tests
 *
 * Validates AuthRepository against SQLite, PostgreSQL, and MySQL backends
 * using the shared test factory from test-utils.ts.
 *
 * SQLite: always runs (in-memory)
 * PostgreSQL: requires test container on port 5433 (skipped if unavailable)
 * MySQL: requires test container on port 3307 (skipped if unavailable)
 *
 * Note: validateApiToken and generateAndCreateApiToken are not tested here
 * because bcrypt is too slow for unit tests.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from 'vitest';
import * as schema from '../schema/index.js';
import { AuthRepository } from './auth.js';
import {
  TestBackend,
  createSqliteBackend,
  createPostgresBackend,
  createMysqlBackend,
  clearTable,
} from './test-utils.js';

// SQL for creating all auth tables per backend (no FK constraints in tests)
// SQLite uses snake_case column names; PostgreSQL/MySQL use camelCase
const SQLITE_CREATE = `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT,
    email TEXT,
    display_name TEXT,
    auth_provider TEXT NOT NULL DEFAULT 'local',
    oidc_subject TEXT,
    is_admin INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    password_locked INTEGER DEFAULT 0,
    mfa_enabled INTEGER NOT NULL DEFAULT 0,
    mfa_secret TEXT,
    mfa_backup_codes TEXT,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    resource TEXT NOT NULL,
    can_view_on_map INTEGER NOT NULL DEFAULT 0,
    can_read INTEGER NOT NULL DEFAULT 0,
    can_write INTEGER NOT NULL DEFAULT 0,
    granted_at INTEGER NOT NULL,
    granted_by INTEGER
  );
  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expire INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT,
    action TEXT NOT NULL,
    resource TEXT,
    details TEXT,
    ip_address TEXT,
    user_agent TEXT,
    timestamp INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS api_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    expires_at INTEGER,
    created_by INTEGER,
    revoked_at INTEGER,
    revoked_by INTEGER
  )
`;

const POSTGRES_CREATE = `
  DROP TABLE IF EXISTS api_tokens CASCADE;
  DROP TABLE IF EXISTS audit_log CASCADE;
  DROP TABLE IF EXISTS permissions CASCADE;
  DROP TABLE IF EXISTS sessions CASCADE;
  DROP TABLE IF EXISTS users CASCADE;
  CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    "passwordHash" TEXT,
    email TEXT,
    "displayName" TEXT,
    "authMethod" TEXT NOT NULL DEFAULT 'local',
    "oidcSubject" TEXT UNIQUE,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "passwordLocked" BOOLEAN DEFAULT false,
    "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "mfaSecret" TEXT,
    "mfaBackupCodes" TEXT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "lastLoginAt" BIGINT
  );
  CREATE TABLE permissions (
    id SERIAL PRIMARY KEY,
    "userId" INTEGER NOT NULL,
    resource TEXT NOT NULL,
    "canViewOnMap" BOOLEAN NOT NULL DEFAULT false,
    "canRead" BOOLEAN NOT NULL DEFAULT false,
    "canWrite" BOOLEAN NOT NULL DEFAULT false,
    "canDelete" BOOLEAN NOT NULL DEFAULT false,
    "grantedAt" BIGINT,
    "grantedBy" INTEGER
  );
  CREATE TABLE sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expire BIGINT NOT NULL
  );
  CREATE TABLE audit_log (
    id SERIAL PRIMARY KEY,
    "userId" INTEGER,
    username TEXT,
    action TEXT NOT NULL,
    resource TEXT,
    details TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    timestamp BIGINT NOT NULL
  );
  CREATE TABLE api_tokens (
    id SERIAL PRIMARY KEY,
    "userId" INTEGER NOT NULL,
    name TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" BIGINT NOT NULL,
    "lastUsedAt" BIGINT,
    "expiresAt" BIGINT,
    "createdBy" INTEGER,
    "revokedAt" BIGINT,
    "revokedBy" INTEGER
  )
`;

const MYSQL_CREATE = `
  SET FOREIGN_KEY_CHECKS = 0;
  DROP TABLE IF EXISTS api_tokens;
  DROP TABLE IF EXISTS audit_log;
  DROP TABLE IF EXISTS permissions;
  DROP TABLE IF EXISTS sessions;
  DROP TABLE IF EXISTS users;
  SET FOREIGN_KEY_CHECKS = 1;
  CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(255) NOT NULL UNIQUE,
    passwordHash VARCHAR(255),
    email VARCHAR(255),
    displayName VARCHAR(255),
    authMethod VARCHAR(32) NOT NULL DEFAULT 'local',
    oidcSubject VARCHAR(255) UNIQUE,
    isAdmin BOOLEAN NOT NULL DEFAULT false,
    isActive BOOLEAN NOT NULL DEFAULT true,
    passwordLocked BOOLEAN DEFAULT false,
    mfaEnabled BOOLEAN NOT NULL DEFAULT false,
    mfaSecret TEXT,
    mfaBackupCodes TEXT,
    createdAt BIGINT NOT NULL,
    updatedAt BIGINT NOT NULL,
    lastLoginAt BIGINT
  );
  CREATE TABLE permissions (
    id SERIAL PRIMARY KEY,
    userId INT NOT NULL,
    resource VARCHAR(64) NOT NULL,
    canViewOnMap BOOLEAN NOT NULL DEFAULT false,
    canRead BOOLEAN NOT NULL DEFAULT false,
    canWrite BOOLEAN NOT NULL DEFAULT false,
    canDelete BOOLEAN NOT NULL DEFAULT false,
    grantedAt BIGINT,
    grantedBy INT
  );
  CREATE TABLE sessions (
    sid VARCHAR(255) PRIMARY KEY,
    sess TEXT NOT NULL,
    expire BIGINT NOT NULL
  );
  CREATE TABLE audit_log (
    id SERIAL PRIMARY KEY,
    userId INT,
    username VARCHAR(255),
    action VARCHAR(128) NOT NULL,
    resource VARCHAR(64),
    details TEXT,
    ipAddress VARCHAR(64),
    userAgent VARCHAR(512),
    timestamp BIGINT NOT NULL
  );
  CREATE TABLE api_tokens (
    id SERIAL PRIMARY KEY,
    userId INT NOT NULL,
    name VARCHAR(255) NOT NULL,
    tokenHash VARCHAR(255) NOT NULL UNIQUE,
    prefix VARCHAR(32) NOT NULL,
    isActive BOOLEAN NOT NULL DEFAULT true,
    createdAt BIGINT NOT NULL,
    lastUsedAt BIGINT,
    expiresAt BIGINT,
    createdBy INT,
    revokedAt BIGINT,
    revokedBy INT
  )
`;

const ALL_TABLES = ['api_tokens', 'audit_log', 'permissions', 'sessions', 'users'];

/** Helper to build a minimal CreateUserInput */
function makeUser(username: string, overrides: Record<string, any> = {}) {
  const now = Date.now();
  return {
    username,
    passwordHash: '$2b$12$somehash',
    authMethod: 'local' as const,
    isAdmin: false,
    isActive: true,
    createdAt: now,
    updatedAt: now, // omitted for SQLite by createUser internally
    ...overrides,
  };
}

/**
 * Shared test suite that runs against any backend.
 */
function runAuthTests(getBackend: () => TestBackend) {
  let repo: AuthRepository;

  beforeEach(() => {
    const backend = getBackend();
    if (!backend.available) return;
    repo = new AuthRepository(backend.drizzleDb, backend.dbType);
  });

  // ============ USERS ============

  it('createUser and getUserById - insert and retrieve', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const userId = await repo.createUser(makeUser('alice'));
    expect(userId).toBeGreaterThan(0);

    const user = await repo.getUserById(userId);
    expect(user).not.toBeNull();
    expect(user!.username).toBe('alice');
    expect(user!.authMethod).toBe('local');
    expect(user!.isAdmin).toBe(false);
    expect(user!.isActive).toBe(true);
  });

  it('getUserById - returns null for missing user', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const result = await repo.getUserById(99999);
    expect(result).toBeNull();
  });

  it('getUserByUsername - finds user by username', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    await repo.createUser(makeUser('bob'));
    const user = await repo.getUserByUsername('bob');
    expect(user).not.toBeNull();
    expect(user!.username).toBe('bob');
  });

  it('getUserByUsername - returns null for unknown username', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const result = await repo.getUserByUsername('nonexistent');
    expect(result).toBeNull();
  });

  it('getUserByOidcSubject - finds user by OIDC subject', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    await repo.createUser(makeUser('oidc_user', { authMethod: 'oidc', oidcSubject: 'sub|12345' }));
    const user = await repo.getUserByOidcSubject('sub|12345');
    expect(user).not.toBeNull();
    expect(user!.username).toBe('oidc_user');
  });

  it('getAllUsers - returns all users', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    expect(await repo.getUserCount()).toBe(0);

    await repo.createUser(makeUser('user1'));
    await repo.createUser(makeUser('user2'));
    await repo.createUser(makeUser('user3'));

    const users = await repo.getAllUsers();
    expect(users).toHaveLength(3);
    const names = users.map(u => u.username).sort();
    expect(names).toEqual(['user1', 'user2', 'user3']);
  });

  it('updateUser - updates user fields', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const userId = await repo.createUser(makeUser('carol', { email: 'old@example.com' }));
    await repo.updateUser(userId, { email: 'new@example.com', isAdmin: true });

    const updated = await repo.getUserById(userId);
    expect(updated!.email).toBe('new@example.com');
    expect(updated!.isAdmin).toBe(true);
  });

  it('deleteUser - removes user and returns true', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const userId = await repo.createUser(makeUser('dave'));
    const deleted = await repo.deleteUser(userId);
    expect(deleted).toBe(true);

    const user = await repo.getUserById(userId);
    expect(user).toBeNull();
  });

  it('deleteUser - returns false for nonexistent user', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const result = await repo.deleteUser(99999);
    expect(result).toBe(false);
  });

  it('getUserCount - returns correct count', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    expect(await repo.getUserCount()).toBe(0);
    await repo.createUser(makeUser('u1'));
    await repo.createUser(makeUser('u2'));
    expect(await repo.getUserCount()).toBe(2);
  });

  // ============ PERMISSIONS ============

  it('createPermission and getPermissionsForUser - insert and retrieve', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const userId = await repo.createUser(makeUser('permuser'));
    const permId = await repo.createPermission({
      userId,
      resource: 'channel_0',
      canRead: true,
      canWrite: false,
    });
    expect(permId).toBeGreaterThan(0);

    const perms = await repo.getPermissionsForUser(userId);
    expect(perms).toHaveLength(1);
    expect(perms[0].resource).toBe('channel_0');
    expect(perms[0].canRead).toBe(true);
    expect(perms[0].canWrite).toBe(false);
  });

  it('getPermissionsForUser - returns empty for user with no permissions', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const userId = await repo.createUser(makeUser('noperms'));
    const perms = await repo.getPermissionsForUser(userId);
    expect(perms).toHaveLength(0);
  });

  it('deletePermissionsForUser - removes all permissions for user', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const userId = await repo.createUser(makeUser('permuser2'));
    await repo.createPermission({ userId, resource: 'channel_0', canRead: true });
    await repo.createPermission({ userId, resource: 'channel_1', canRead: true });

    const deleted = await repo.deletePermissionsForUser(userId);
    expect(deleted).toBe(2);

    const perms = await repo.getPermissionsForUser(userId);
    expect(perms).toHaveLength(0);
  });

  // ============ API TOKENS ============

  it('createApiToken and getApiTokenByHash - insert and lookup', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const userId = await repo.createUser(makeUser('tokenuser'));
    const now = Date.now();
    const tokenId = await repo.createApiToken({
      userId,
      name: 'Test Token',
      tokenHash: 'hash_abc123',
      prefix: 'mm_v1_ab',
      isActive: true,
      createdAt: now,
    });
    expect(tokenId).toBeGreaterThan(0);

    const token = await repo.getApiTokenByHash('hash_abc123');
    expect(token).not.toBeNull();
    expect(token!.userId).toBe(userId);
    expect(token!.name).toBe('Test Token');
    expect(token!.isActive).toBe(true);
  });

  it('getApiTokenByHash - returns null for unknown hash', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const result = await repo.getApiTokenByHash('no_such_hash');
    expect(result).toBeNull();
  });

  it('getApiTokensForUser - returns tokens for user', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const userId = await repo.createUser(makeUser('tokenuser2'));
    const now = Date.now();
    await repo.createApiToken({ userId, name: 'Token A', tokenHash: 'hash_A', prefix: 'mm_v1_aa', isActive: true, createdAt: now });
    await repo.createApiToken({ userId, name: 'Token B', tokenHash: 'hash_B', prefix: 'mm_v1_bb', isActive: false, createdAt: now });

    const tokens = await repo.getApiTokensForUser(userId);
    expect(tokens).toHaveLength(2);
  });

  it('updateApiTokenLastUsed - updates timestamp', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const userId = await repo.createUser(makeUser('tokenuser3'));
    const now = Date.now();
    const tokenId = await repo.createApiToken({ userId, name: 'Token', tokenHash: 'hash_C', prefix: 'mm_v1_cc', isActive: true, createdAt: now });

    await repo.updateApiTokenLastUsed(tokenId);

    const token = await repo.getApiTokenByHash('hash_C');
    expect(token!.lastUsedAt).not.toBeNull();
    expect(token!.lastUsedAt).toBeGreaterThan(0);
  });

  it('deleteApiToken - removes token and returns true', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const userId = await repo.createUser(makeUser('tokenuser4'));
    const now = Date.now();
    const tokenId = await repo.createApiToken({ userId, name: 'Token', tokenHash: 'hash_D', prefix: 'mm_v1_dd', isActive: true, createdAt: now });

    const deleted = await repo.deleteApiToken(tokenId);
    expect(deleted).toBe(true);

    const token = await repo.getApiTokenByHash('hash_D');
    expect(token).toBeNull();
  });

  it('deleteApiToken - returns false for nonexistent token', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const result = await repo.deleteApiToken(99999);
    expect(result).toBe(false);
  });

  it('revokeApiToken - sets isActive=false and records revokedAt/revokedBy', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const userId = await repo.createUser(makeUser('tokenuser5'));
    const now = Date.now();
    const tokenId = await repo.createApiToken({ userId, name: 'Token', tokenHash: 'hash_E', prefix: 'mm_v1_ee', isActive: true, createdAt: now });

    const revoked = await repo.revokeApiToken(tokenId, userId);
    expect(revoked).toBe(true);

    const token = await repo.getApiTokenByHash('hash_E');
    expect(token!.isActive).toBe(false);
    expect(token!.revokedAt).toBeGreaterThan(0);
    expect(token!.revokedBy).toBe(userId);
  });

  it('revokeApiToken - returns false for already-revoked token', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const userId = await repo.createUser(makeUser('tokenuser6'));
    const now = Date.now();
    const tokenId = await repo.createApiToken({ userId, name: 'Token', tokenHash: 'hash_F', prefix: 'mm_v1_ff', isActive: false, createdAt: now });

    const result = await repo.revokeApiToken(tokenId, userId);
    expect(result).toBe(false);
  });

  it('revokeAllUserApiTokens - revokes all active tokens for user', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const userId = await repo.createUser(makeUser('tokenuser7'));
    const adminId = await repo.createUser(makeUser('admin'));
    const now = Date.now();
    await repo.createApiToken({ userId, name: 'Token 1', tokenHash: 'hash_G1', prefix: 'mm_v1_g1', isActive: true, createdAt: now });
    await repo.createApiToken({ userId, name: 'Token 2', tokenHash: 'hash_G2', prefix: 'mm_v1_g2', isActive: true, createdAt: now });

    const count = await repo.revokeAllUserApiTokens(userId, adminId);
    expect(count).toBe(2);

    const tokens = await repo.getApiTokensForUser(userId);
    tokens.forEach(t => expect(t.isActive).toBe(false));
  });

  it('getUserActiveApiToken - returns active token info', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const userId = await repo.createUser(makeUser('tokenuser8'));
    const now = Date.now();
    await repo.createApiToken({ userId, name: 'Active Token', tokenHash: 'hash_H', prefix: 'mm_v1_hh', isActive: true, createdAt: now });

    const info = await repo.getUserActiveApiToken(userId);
    expect(info).not.toBeNull();
    expect(info!.prefix).toBe('mm_v1_hh');
    expect(info!.isActive).toBe(true);
  });

  it('getUserActiveApiToken - returns null when no active tokens', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const userId = await repo.createUser(makeUser('tokenuser9'));
    const result = await repo.getUserActiveApiToken(userId);
    expect(result).toBeNull();
  });

  // ============ AUDIT LOG ============

  it('createAuditLogEntry and getAuditLogEntries - insert and retrieve', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const now = Date.now();
    const entryId = await repo.createAuditLogEntry({
      userId: null,
      username: 'admin',
      action: 'login',
      resource: null,
      details: 'Successful login',
      ipAddress: '127.0.0.1',
      userAgent: 'TestAgent/1.0',
      timestamp: now,
    });
    expect(entryId).toBeGreaterThan(0);

    const entries = await repo.getAuditLogEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe('login');
    expect(entries[0].username).toBe('admin');
  });

  it('getAuditLogEntries - respects limit and offset', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const base = Date.now();
    for (let i = 0; i < 5; i++) {
      await repo.createAuditLogEntry({ userId: null, action: `action_${i}`, resource: null, details: null, ipAddress: null, userAgent: null, timestamp: base + i * 100 });
    }

    const limited = await repo.getAuditLogEntries(3);
    expect(limited).toHaveLength(3);

    const offset = await repo.getAuditLogEntries(10, 2);
    expect(offset).toHaveLength(3); // 5 total, skip 2
  });

  it('cleanupOldAuditLogs - removes old entries', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const now = Date.now();
    const old = now - (100 * 24 * 60 * 60 * 1000); // 100 days ago
    const recent = now - (10 * 24 * 60 * 60 * 1000); // 10 days ago

    await repo.createAuditLogEntry({ userId: null, action: 'old_action', resource: null, details: null, ipAddress: null, userAgent: null, timestamp: old });
    await repo.createAuditLogEntry({ userId: null, action: 'recent_action', resource: null, details: null, ipAddress: null, userAgent: null, timestamp: recent });

    const deleted = await repo.cleanupOldAuditLogs(90); // 90-day cutoff
    expect(deleted).toBe(1);

    const remaining = await repo.getAuditLogEntries();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].action).toBe('recent_action');
  });

  // ============ SESSIONS ============

  it('setSession and getSession - create and retrieve', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const now = Date.now();
    await repo.setSession('sess_abc', JSON.stringify({ userId: 1 }), now + 3600000);

    const session = await repo.getSession('sess_abc');
    expect(session).not.toBeNull();
    expect(session!.sid).toBe('sess_abc');
    expect(JSON.parse(session!.sess)).toEqual({ userId: 1 });
    expect(session!.expire).toBeGreaterThan(now);
  });

  it('getSession - returns null for missing session', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const result = await repo.getSession('nonexistent_session');
    expect(result).toBeNull();
  });

  it('setSession - upsert updates existing session', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const now = Date.now();
    await repo.setSession('sess_xyz', '{"v": 1}', now + 1000);
    await repo.setSession('sess_xyz', '{"v": 2}', now + 2000);

    const session = await repo.getSession('sess_xyz');
    expect(JSON.parse(session!.sess)).toEqual({ v: 2 });
    expect(session!.expire).toBe(now + 2000);
  });

  it('deleteSession - removes session', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const now = Date.now();
    await repo.setSession('del_sess', '{}', now + 1000);
    await repo.deleteSession('del_sess');

    const result = await repo.getSession('del_sess');
    expect(result).toBeNull();
  });

  it('cleanupExpiredSessions - removes expired sessions', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const now = Date.now();
    await repo.setSession('expired_1', '{}', now - 10000); // expired
    await repo.setSession('expired_2', '{}', now - 5000);  // expired
    await repo.setSession('valid_1', '{}', now + 100000);  // valid

    const cleaned = await repo.cleanupExpiredSessions();
    expect(cleaned).toBe(2);

    const remaining = await repo.getSession('valid_1');
    expect(remaining).not.toBeNull();
    expect(await repo.getSession('expired_1')).toBeNull();
    expect(await repo.getSession('expired_2')).toBeNull();
  });
}

// --- SQLite Backend ---
describe('AuthRepository - SQLite Backend', () => {
  let backend: TestBackend;

  beforeEach(() => {
    backend = createSqliteBackend(SQLITE_CREATE);
  });

  afterEach(async () => {
    await backend.close();
  });

  runAuthTests(() => backend);
});

// --- PostgreSQL Backend ---
describe('AuthRepository - PostgreSQL Backend', () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await createPostgresBackend(POSTGRES_CREATE);
    if (backend.available) {
      console.log('✓ PostgreSQL connection established for auth tests');
    } else {
      console.log(`⚠ ${backend.skipReason}`);
    }
  });

  afterAll(async () => {
    if (backend) await backend.close();
  });

  beforeEach(async () => {
    if (!backend.available) return;
    // Clear in reverse FK order
    for (const table of ALL_TABLES) {
      await clearTable(backend, table);
    }
  });

  runAuthTests(() => backend);
});

// --- MySQL Backend ---
describe('AuthRepository - MySQL Backend', () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await createMysqlBackend(MYSQL_CREATE);
    if (backend.available) {
      console.log('✓ MySQL connection established for auth tests');
    } else {
      console.log(`⚠ ${backend.skipReason}`);
    }
  });

  afterAll(async () => {
    if (backend) await backend.close();
  });

  beforeEach(async () => {
    if (!backend.available) return;
    for (const table of ALL_TABLES) {
      await clearTable(backend, table);
    }
  });

  runAuthTests(() => backend);
});
