/**
 * migratePermissionsForChannelMoves — source scope (#5183).
 *
 * Channel slots are per source. The migration used to read and rewrite
 * `channel_N` grants for EVERY source, and re-insert them WITHOUT their
 * `sourceId`, so a move detected on one source turned a grant scoped to that
 * source into a global grant on all of them. Runs against the real migrated
 * SQLite schema.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { AuthRepository } from './auth.js';
import * as schema from '../schema/index.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

describe('AuthRepository.migratePermissionsForChannelMoves source scope (#5183)', () => {
  let sqlite: ReturnType<typeof createTestDb>['sqlite'];
  let db: BetterSQLite3Database<typeof schema>;
  let repo: AuthRepository;
  let userId: number;

  const grant = (resource: string, sourceId: string | null) =>
    sqlite
      .prepare('INSERT INTO permissions (user_id, resource, can_view_on_map, can_read, can_write, granted_at, sourceId) VALUES (?, ?, 0, 1, 0, ?, ?)')
      .run(userId, resource, Date.now(), sourceId);

  const rows = () =>
    (sqlite.prepare('SELECT resource, sourceId FROM permissions WHERE user_id = ? ORDER BY resource, sourceId').all(userId) as Array<{ resource: string; sourceId: string | null }>);

  beforeEach(() => {
    const t = createTestDb();
    sqlite = t.sqlite;
    db = t.db;
    repo = new AuthRepository(db, 'sqlite');
    const now = Date.now();
    userId = Number(
      sqlite
        .prepare("INSERT INTO users (username, password_hash, auth_provider, is_admin, is_active, created_at, updated_at) VALUES ('u', 'x', 'local', 0, 1, ?, ?)")
        .run(now, now).lastInsertRowid,
    );
  });

  afterEach(() => sqlite.close());

  it('moves only the named source\'s grants', async () => {
    grant('channel_3', 'src-a');
    grant('channel_3', 'src-b');

    await repo.migratePermissionsForChannelMoves([{ from: 3, to: 5 }], 'src-a');

    expect(rows()).toEqual([
      { resource: 'channel_3', sourceId: 'src-b' },
      { resource: 'channel_5', sourceId: 'src-a' },
    ]);
  });

  it('keeps the sourceId on a moved grant instead of turning it global', async () => {
    grant('channel_1', 'src-a');

    await repo.migratePermissionsForChannelMoves([{ from: 1, to: 2 }], 'src-a');

    expect(rows()).toEqual([{ resource: 'channel_2', sourceId: 'src-a' }]);
  });

  it('swaps within one source and leaves the other untouched', async () => {
    grant('channel_1', 'src-a');
    grant('channel_2', 'src-b');

    await repo.migratePermissionsForChannelMoves([{ from: 1, to: 2 }, { from: 2, to: 1 }], 'src-a');

    expect(rows()).toEqual([
      { resource: 'channel_2', sourceId: 'src-a' },
      { resource: 'channel_2', sourceId: 'src-b' },
    ]);
  });

  it('without a source, still preserves each row\'s own sourceId', async () => {
    grant('channel_4', 'src-a');
    grant('channel_4', null);

    await repo.migratePermissionsForChannelMoves([{ from: 4, to: 6 }]);

    expect(rows()).toEqual([
      { resource: 'channel_6', sourceId: null },
      { resource: 'channel_6', sourceId: 'src-a' },
    ]);
  });
});
