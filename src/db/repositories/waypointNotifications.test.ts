/**
 * The waypoint alert dedupe ledger (#4750), against real SQLite.
 *
 * The service's own suite mocks this repository, so this is where the storage
 * behaviour that makes dedupe work is actually exercised: does a recorded row
 * come back, does it stay scoped to one user and one source, and does a
 * cleared waypoint alert again.
 *
 * It also pins the large-`waypointId` question raised in review on PR #5228.
 * Meshtastic waypoint ids are `uint32`, so ids above 2^31 - 1 are legal, while
 * the SQLite column is declared `INTEGER` (BIGINT on PostgreSQL/MySQL, covered
 * by the migration suite). SQLite's INTEGER is a variable-width type that
 * stores up to 8 bytes and better-sqlite3 hands back an exact JS number below
 * 2^53, so no truncation is expected — but "expected" is not "tested", and a
 * silent 32-bit wrap here would mean a waypoint that never stops alerting.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WaypointNotificationsRepository } from './waypointNotifications.js';
import { createSqliteBackend, type TestBackend } from './test-utils.js';

/** Mirrors migration 165's SQLite DDL. */
const CREATE_TABLES = `
  CREATE TABLE waypoint_notifications (
    user_id INTEGER NOT NULL,
    source_id TEXT NOT NULL,
    waypoint_id INTEGER NOT NULL,
    notified_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, source_id, waypoint_id)
  );
  CREATE INDEX idx_waypoint_notifications_source_waypoint
    ON waypoint_notifications (source_id, waypoint_id);
`;

const SOURCE = 'src-a';

describe('WaypointNotificationsRepository (SQLite)', () => {
  let backend: TestBackend;
  let repo: WaypointNotificationsRepository;

  beforeEach(() => {
    backend = createSqliteBackend(CREATE_TABLES);
    repo = new WaypointNotificationsRepository(backend.drizzleDb, 'sqlite');
  });

  afterEach(async () => {
    await backend.close();
  });

  it('reports nobody notified on an empty ledger', async () => {
    expect(await repo.getNotifiedUserIdsAsync(SOURCE, 42, [1, 2])).toEqual(new Set());
  });

  it('returns an empty set for an empty user list without querying', async () => {
    expect(await repo.getNotifiedUserIdsAsync(SOURCE, 42, [])).toEqual(new Set());
  });

  it('remembers a user it recorded', async () => {
    await repo.markNotifiedAsync(1, SOURCE, 42);
    expect(await repo.getNotifiedUserIdsAsync(SOURCE, 42, [1, 2])).toEqual(new Set([1]));
  });

  it('keeps one user\'s record from silencing another', async () => {
    await repo.markNotifiedAsync(1, SOURCE, 42);
    const notified = await repo.getNotifiedUserIdsAsync(SOURCE, 42, [1, 2, 3]);
    expect(notified.has(2)).toBe(false);
    expect(notified.has(3)).toBe(false);
  });

  it('scopes the record to one source', async () => {
    await repo.markNotifiedAsync(1, SOURCE, 42);
    expect(await repo.getNotifiedUserIdsAsync('src-b', 42, [1])).toEqual(new Set());
  });

  it('scopes the record to one waypoint id, so a recreated waypoint alerts', async () => {
    await repo.markNotifiedAsync(1, SOURCE, 42);
    // The same place and name, recreated — a new id, therefore new to the user.
    expect(await repo.getNotifiedUserIdsAsync(SOURCE, 43, [1])).toEqual(new Set());
  });

  it('is idempotent — a repeat record is a no-op, not a crash', async () => {
    await repo.markNotifiedAsync(1, SOURCE, 42);
    await expect(repo.markNotifiedAsync(1, SOURCE, 42)).resolves.toBeUndefined();
    expect(await repo.getNotifiedUserIdsAsync(SOURCE, 42, [1])).toEqual(new Set([1]));
  });

  describe('clearForWaypointAsync', () => {
    it('lets a reused waypoint id alert again', async () => {
      await repo.markNotifiedAsync(1, SOURCE, 42);
      await repo.clearForWaypointAsync(SOURCE, 42);
      expect(await repo.getNotifiedUserIdsAsync(SOURCE, 42, [1])).toEqual(new Set());
    });

    it('clears every user at once', async () => {
      await repo.markNotifiedAsync(1, SOURCE, 42);
      await repo.markNotifiedAsync(2, SOURCE, 42);
      await repo.clearForWaypointAsync(SOURCE, 42);
      expect(await repo.getNotifiedUserIdsAsync(SOURCE, 42, [1, 2])).toEqual(new Set());
    });

    it('leaves other waypoints and other sources alone', async () => {
      await repo.markNotifiedAsync(1, SOURCE, 42);
      await repo.markNotifiedAsync(1, SOURCE, 43);
      await repo.markNotifiedAsync(1, 'src-b', 42);
      await repo.clearForWaypointAsync(SOURCE, 42);
      expect(await repo.getNotifiedUserIdsAsync(SOURCE, 43, [1])).toEqual(new Set([1]));
      expect(await repo.getNotifiedUserIdsAsync('src-b', 42, [1])).toEqual(new Set([1]));
    });
  });

  describe('large waypoint ids (review, PR #5228)', () => {
    // Above 2^31 - 1 — legal for a uint32 waypoint id, and the value a 32-bit
    // wrap would mangle.
    const BIG = 3_000_000_000;
    const MAX_UINT32 = 4_294_967_295;

    it('round-trips an id above the 32-bit signed range', async () => {
      await repo.markNotifiedAsync(1, SOURCE, BIG);
      expect(await repo.getNotifiedUserIdsAsync(SOURCE, BIG, [1])).toEqual(new Set([1]));
    });

    it('round-trips the largest uint32', async () => {
      await repo.markNotifiedAsync(1, SOURCE, MAX_UINT32);
      expect(await repo.getNotifiedUserIdsAsync(SOURCE, MAX_UINT32, [1])).toEqual(new Set([1]));
    });

    it('does not confuse a large id with its 32-bit truncation', async () => {
      // If the column wrapped, BIG would collide with its signed-32-bit
      // reading and this waypoint would read as already-notified.
      await repo.markNotifiedAsync(1, SOURCE, BIG);
      const wrapped = BIG | 0; // -1294967296
      expect(await repo.getNotifiedUserIdsAsync(SOURCE, wrapped, [1])).toEqual(new Set());
    });

    it('clears a large id correctly', async () => {
      await repo.markNotifiedAsync(1, SOURCE, MAX_UINT32);
      await repo.clearForWaypointAsync(SOURCE, MAX_UINT32);
      expect(await repo.getNotifiedUserIdsAsync(SOURCE, MAX_UINT32, [1])).toEqual(new Set());
    });
  });

  describe('fail-closed reads', () => {
    it('reports everyone as notified when the ledger cannot be read', async () => {
      // A broken ledger must suppress alerts, not flood: reading it as "nobody
      // has been notified" would re-alert every user on every rebroadcast.
      await backend.exec('DROP TABLE waypoint_notifications');
      expect(await repo.getNotifiedUserIdsAsync(SOURCE, 42, [1, 2, 3])).toEqual(new Set([1, 2, 3]));
    });

    it('swallows a write failure rather than breaking ingest', async () => {
      await backend.exec('DROP TABLE waypoint_notifications');
      await expect(repo.markNotifiedAsync(1, SOURCE, 42)).resolves.toBeUndefined();
    });

    it('swallows a clear failure rather than breaking a delete', async () => {
      await backend.exec('DROP TABLE waypoint_notifications');
      await expect(repo.clearForWaypointAsync(SOURCE, 42)).resolves.toBeUndefined();
    });
  });
});
