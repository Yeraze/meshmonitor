/**
 * MeshCore "heard repeaters" repository — unit + per-source isolation tests
 * (#3700).
 *
 * The `meshcore_heard_repeaters` table (migration 102) carries a `sourceId` on
 * every row. These tests assert recording/dedup/max-SNR behaviour and that
 * queries never leak across sources.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { MeshCoreRepository } from './meshcore.js';
import * as schema from '../schema/index.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

const HEARD_AT = 1_700_000_000_000;

describe('MeshCoreRepository — heard-repeaters', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: MeshCoreRepository;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    repo = new MeshCoreRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => {
    db.close();
  });

  it('recordHeardRepeater requires a sourceId', async () => {
    await expect(
      repo.recordHeardRepeater({
        sourceId: '',
        messageId: 'm1',
        repeaterHash: 'a3',
        heardAt: HEARD_AT,
      }),
    ).rejects.toThrow(/sourceId/);
  });

  it('inserts a new heard-repeater row and returns it', async () => {
    const row = await repo.recordHeardRepeater({
      sourceId: 'src-a',
      messageId: 'm1',
      repeaterHash: 'a3',
      repeaterName: 'Repeater Alpha',
      snr: 5,
      heardAt: HEARD_AT,
    });
    expect(row).toMatchObject({
      sourceId: 'src-a',
      messageId: 'm1',
      repeaterHash: 'a3',
      repeaterName: 'Repeater Alpha',
      snr: 5,
    });

    const all = await repo.getHeardRepeatersForMessage('m1', 'src-a');
    expect(all).toHaveLength(1);
    expect(all[0].repeaterHash).toBe('a3');
  });

  it('dedups on (sourceId, messageId, repeaterHash) and keeps the max SNR', async () => {
    await repo.recordHeardRepeater({
      sourceId: 'src-a', messageId: 'm1', repeaterHash: 'a3', snr: 3, heardAt: HEARD_AT,
    });
    const merged = await repo.recordHeardRepeater({
      sourceId: 'src-a', messageId: 'm1', repeaterHash: 'a3', snr: 7, heardAt: HEARD_AT + 1000,
    });
    expect(merged.snr).toBe(7);

    const lower = await repo.recordHeardRepeater({
      sourceId: 'src-a', messageId: 'm1', repeaterHash: 'a3', snr: 1, heardAt: HEARD_AT + 2000,
    });
    expect(lower.snr).toBe(7); // max retained

    const all = await repo.getHeardRepeatersForMessage('m1', 'src-a');
    expect(all).toHaveLength(1);
    expect(all[0].snr).toBe(7);
  });

  it('fills in a repeaterName on a later echo when it becomes known', async () => {
    await repo.recordHeardRepeater({
      sourceId: 'src-a', messageId: 'm1', repeaterHash: 'a3', repeaterName: null, snr: 2, heardAt: HEARD_AT,
    });
    const merged = await repo.recordHeardRepeater({
      sourceId: 'src-a', messageId: 'm1', repeaterHash: 'a3', repeaterName: 'Alpha', snr: 2, heardAt: HEARD_AT + 10,
    });
    expect(merged.repeaterName).toBe('Alpha');
  });

  it('handles a null SNR without clobbering an existing value', async () => {
    await repo.recordHeardRepeater({
      sourceId: 'src-a', messageId: 'm1', repeaterHash: 'a3', snr: 8, heardAt: HEARD_AT,
    });
    const merged = await repo.recordHeardRepeater({
      sourceId: 'src-a', messageId: 'm1', repeaterHash: 'a3', snr: null, heardAt: HEARD_AT + 10,
    });
    expect(merged.snr).toBe(8);
  });

  it('getHeardRepeatersForMessage is scoped by sourceId', async () => {
    await repo.recordHeardRepeater({ sourceId: 'src-a', messageId: 'm1', repeaterHash: 'a3', snr: 5, heardAt: HEARD_AT });
    await repo.recordHeardRepeater({ sourceId: 'src-b', messageId: 'm1', repeaterHash: 'a3', snr: 5, heardAt: HEARD_AT });

    const a = await repo.getHeardRepeatersForMessage('m1', 'src-a');
    const b = await repo.getHeardRepeatersForMessage('m1', 'src-b');
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a.every(r => r.sourceId === 'src-a')).toBe(true);
    expect(b.every(r => r.sourceId === 'src-b')).toBe(true);

    // Same (messageId, repeaterHash) in two sources are distinct rows.
    await repo.recordHeardRepeater({ sourceId: 'src-a', messageId: 'm1', repeaterHash: '7f', snr: 1, heardAt: HEARD_AT });
    expect(await repo.getHeardRepeatersForMessage('m1', 'src-a')).toHaveLength(2);
    expect(await repo.getHeardRepeatersForMessage('m1', 'src-b')).toHaveLength(1);
  });

  it('getHeardRepeatersForMessage orders by SNR descending', async () => {
    await repo.recordHeardRepeater({ sourceId: 'src-a', messageId: 'm1', repeaterHash: 'a3', snr: 2, heardAt: HEARD_AT });
    await repo.recordHeardRepeater({ sourceId: 'src-a', messageId: 'm1', repeaterHash: '7f', snr: 9, heardAt: HEARD_AT });
    await repo.recordHeardRepeater({ sourceId: 'src-a', messageId: 'm1', repeaterHash: 'bc', snr: 5, heardAt: HEARD_AT });
    const all = await repo.getHeardRepeatersForMessage('m1', 'src-a');
    expect(all.map(r => r.repeaterHash)).toEqual(['7f', 'bc', 'a3']);
  });

  it('getHeardRepeatersForMessages groups by messageId and is source-scoped', async () => {
    await repo.recordHeardRepeater({ sourceId: 'src-a', messageId: 'm1', repeaterHash: 'a3', snr: 5, heardAt: HEARD_AT });
    await repo.recordHeardRepeater({ sourceId: 'src-a', messageId: 'm1', repeaterHash: '7f', snr: 3, heardAt: HEARD_AT });
    await repo.recordHeardRepeater({ sourceId: 'src-a', messageId: 'm2', repeaterHash: 'bc', snr: 1, heardAt: HEARD_AT });
    await repo.recordHeardRepeater({ sourceId: 'src-b', messageId: 'm1', repeaterHash: 'a3', snr: 5, heardAt: HEARD_AT });

    const grouped = await repo.getHeardRepeatersForMessages(['m1', 'm2', 'm3'], 'src-a');
    expect(Object.keys(grouped).sort()).toEqual(['m1', 'm2']);
    expect(grouped['m1']).toHaveLength(2);
    expect(grouped['m2']).toHaveLength(1);
    expect(grouped['m3']).toBeUndefined();
    // src-b row excluded.
    expect(grouped['m1'].every(r => r.sourceId === 'src-a')).toBe(true);
  });

  it('getHeardRepeatersForMessages returns {} for an empty id list', async () => {
    const grouped = await repo.getHeardRepeatersForMessages([], 'src-a');
    expect(grouped).toEqual({});
  });
});
