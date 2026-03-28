/**
 * Auth Repository - Permission Migration Tests
 *
 * Tests migratePermissionsForChannelMoves() which handles:
 * - Simple permission moves (channel_A → channel_B)
 * - Permission swaps (channel_A ↔ channel_B)
 * - Multiple simultaneous moves
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { AuthRepository } from './auth.js';
import * as schema from '../schema/index.js';

describe('AuthRepository.migratePermissionsForChannelMoves', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: AuthRepository;

  beforeEach(() => {
    db = new Database(':memory:');

    // Create users table
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        email TEXT,
        display_name TEXT,
        is_admin INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1,
        auth_provider TEXT NOT NULL DEFAULT 'local',
        external_id TEXT,
        mfa_secret TEXT,
        mfa_enabled INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_login INTEGER
      )
    `);

    // Create permissions table with CHECK constraint matching production schema (migration 006)
    db.exec(`
      CREATE TABLE permissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        resource TEXT NOT NULL,
        can_view_on_map INTEGER NOT NULL DEFAULT 0,
        can_read INTEGER NOT NULL DEFAULT 1,
        can_write INTEGER NOT NULL DEFAULT 0,
        granted_at INTEGER,
        granted_by INTEGER,
        UNIQUE(user_id, resource),
        CHECK (resource IN (
          'dashboard', 'nodes', 'messages', 'settings',
          'configuration', 'info', 'automation', 'connection',
          'traceroute', 'audit', 'security', 'themes',
          'channel_0', 'channel_1', 'channel_2', 'channel_3',
          'channel_4', 'channel_5', 'channel_6', 'channel_7',
          'nodes_private', 'meshcore', 'packetmonitor'
        ))
      )
    `);

    // Create test users
    db.exec(`
      INSERT INTO users (id, username, password_hash, is_admin, auth_provider, created_at, updated_at)
      VALUES (1, 'user1', 'hash', 0, 'local', ${Date.now()}, ${Date.now()});
      INSERT INTO users (id, username, password_hash, is_admin, auth_provider, created_at, updated_at)
      VALUES (2, 'user2', 'hash', 0, 'local', ${Date.now()}, ${Date.now()});
    `);

    drizzleDb = drizzle(db, { schema });
    repo = new AuthRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => {
    db.close();
  });

  const addPermission = (userId: number, resource: string, canRead: boolean, canWrite: boolean) => {
    db.exec(`
      INSERT INTO permissions (user_id, resource, can_read, can_write, granted_at)
      VALUES (${userId}, '${resource}', ${canRead ? 1 : 0}, ${canWrite ? 1 : 0}, ${Date.now()})
    `);
  };

  const getPermission = (userId: number, resource: string): { can_read: number; can_write: number } | undefined => {
    return db.prepare('SELECT can_read, can_write FROM permissions WHERE user_id = ? AND resource = ?')
      .get(userId, resource) as any;
  };

  const countPermissions = (resource: string): number => {
    const row = db.prepare('SELECT COUNT(*) as count FROM permissions WHERE resource = ?').get(resource) as any;
    return row.count;
  };

  it('should handle empty moves array', async () => {
    addPermission(1, 'channel_0', true, false);
    await repo.migratePermissionsForChannelMoves([]);
    expect(getPermission(1, 'channel_0')).toBeDefined();
  });

  it('should move permissions from one channel to another', async () => {
    addPermission(1, 'channel_1', true, true);
    addPermission(2, 'channel_1', true, false);
    addPermission(1, 'channel_2', true, false); // Should not be affected

    await repo.migratePermissionsForChannelMoves([{ from: 1, to: 3 }]);

    expect(getPermission(1, 'channel_1')).toBeUndefined();
    expect(getPermission(2, 'channel_1')).toBeUndefined();
    expect(getPermission(1, 'channel_3')?.can_read).toBe(1);
    expect(getPermission(1, 'channel_3')?.can_write).toBe(1);
    expect(getPermission(2, 'channel_3')?.can_read).toBe(1);
    expect(getPermission(2, 'channel_3')?.can_write).toBe(0);
    expect(getPermission(1, 'channel_2')).toBeDefined(); // Unchanged
  });

  it('should swap permissions between two channels', async () => {
    addPermission(1, 'channel_1', true, true);   // user1 has read+write on ch1
    addPermission(1, 'channel_4', true, false);   // user1 has read-only on ch4

    await repo.migratePermissionsForChannelMoves([
      { from: 1, to: 4 },
      { from: 4, to: 1 },
    ]);

    // Permissions should be swapped
    expect(getPermission(1, 'channel_1')?.can_read).toBe(1);
    expect(getPermission(1, 'channel_1')?.can_write).toBe(0); // Was ch4's permission
    expect(getPermission(1, 'channel_4')?.can_read).toBe(1);
    expect(getPermission(1, 'channel_4')?.can_write).toBe(1); // Was ch1's permission
  });

  it('should handle swap when one channel has no permissions', async () => {
    addPermission(1, 'channel_1', true, true);
    // No permissions on channel_4

    await repo.migratePermissionsForChannelMoves([
      { from: 1, to: 4 },
      { from: 4, to: 1 },
    ]);

    expect(getPermission(1, 'channel_1')).toBeUndefined();
    expect(getPermission(1, 'channel_4')?.can_write).toBe(1);
  });

  it('should not affect non-channel permissions', async () => {
    addPermission(1, 'channel_1', true, true);
    addPermission(1, 'messages', true, false);
    addPermission(1, 'dashboard', true, false);

    await repo.migratePermissionsForChannelMoves([{ from: 1, to: 5 }]);

    expect(getPermission(1, 'messages')).toBeDefined();
    expect(getPermission(1, 'dashboard')).toBeDefined();
    expect(getPermission(1, 'channel_5')).toBeDefined();
  });

  it('should handle multiple users with swapped channels', async () => {
    addPermission(1, 'channel_0', true, true);
    addPermission(2, 'channel_0', true, false);
    addPermission(1, 'channel_2', false, false);
    addPermission(2, 'channel_2', true, true);

    await repo.migratePermissionsForChannelMoves([
      { from: 0, to: 2 },
      { from: 2, to: 0 },
    ]);

    // User 1: ch0 had rw, ch2 had none → now ch0 has none, ch2 has rw
    expect(getPermission(1, 'channel_0')?.can_read).toBe(0);   // Was ch2's
    expect(getPermission(1, 'channel_2')?.can_write).toBe(1);  // Was ch0's
    // User 2: ch0 had r, ch2 had rw → now ch0 has rw, ch2 has r
    expect(getPermission(2, 'channel_0')?.can_write).toBe(1);  // Was ch2's
    expect(getPermission(2, 'channel_2')?.can_write).toBe(0);  // Was ch0's
  });

  it('should handle mix of swaps and simple moves', async () => {
    addPermission(1, 'channel_0', true, true);
    addPermission(1, 'channel_1', true, false);
    addPermission(1, 'channel_3', true, true);

    await repo.migratePermissionsForChannelMoves([
      { from: 0, to: 1 },  // Swap 0 ↔ 1
      { from: 1, to: 0 },
      { from: 3, to: 5 },  // Simple move 3 → 5
    ]);

    expect(getPermission(1, 'channel_0')?.can_write).toBe(0);  // Was ch1's (read-only)
    expect(getPermission(1, 'channel_1')?.can_write).toBe(1);  // Was ch0's (read+write)
    expect(getPermission(1, 'channel_3')).toBeUndefined();      // Moved away
    expect(getPermission(1, 'channel_5')?.can_write).toBe(1);  // Was ch3's
  });
});
