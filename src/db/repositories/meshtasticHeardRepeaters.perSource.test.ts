/**
 * MeshtasticHeardRepeatersRepository — unit + per-source isolation tests
 * (Delivery Diagnostics epic #4816, Phase 4 WP1 — Meshtastic Heard-By).
 *
 * The `meshtastic_heard_repeaters` table (migration 152) carries a
 * `sourceId` on every row. These tests assert recording/dedup/max-SNR
 * behaviour and that queries never leak across sources. Runs against SQLite
 * via `createTestDb()` — PG/MySQL DDL is covered separately by
 * `152_create_meshtastic_heard_repeaters.pgmysql.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { MeshtasticHeardRepeatersRepository } from './meshtasticHeardRepeaters.js';
import * as schema from '../schema/index.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

const HEARD_AT = 1_700_000_000_000;

describe('MeshtasticHeardRepeatersRepository', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: MeshtasticHeardRepeatersRepository;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    repo = new MeshtasticHeardRepeatersRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => {
    db.close();
  });

  it('recordHeardRepeater requires a sourceId', async () => {
    await expect(
      repo.recordHeardRepeater({
        sourceId: '',
        messageId: 'm1',
        relayByte: 0xa3,
        heardAt: HEARD_AT,
      }),
    ).rejects.toThrow(/sourceId/);
  });

  it('recordHeardRepeater requires a messageId', async () => {
    await expect(
      repo.recordHeardRepeater({
        sourceId: 'src-a',
        messageId: '',
        relayByte: 0xa3,
        heardAt: HEARD_AT,
      }),
    ).rejects.toThrow(/messageId/);
  });

  it('getHeardRepeatersForMessage requires a sourceId and a messageId', async () => {
    await expect(repo.getHeardRepeatersForMessage('m1', '')).rejects.toThrow(/sourceId/);
    await expect(repo.getHeardRepeatersForMessage('', 'src-a')).rejects.toThrow(/messageId/);
  });

  it('inserts a new heard-repeater row and returns it', async () => {
    const row = await repo.recordHeardRepeater({
      sourceId: 'src-a',
      messageId: 'm1',
      relayByte: 0xa3,
      snr: -5.25,
      heardAt: HEARD_AT,
    });
    expect(row).toMatchObject({
      sourceId: 'src-a',
      messageId: 'm1',
      relayByte: 0xa3,
      snr: -5.25,
    });

    const all = await repo.getHeardRepeatersForMessage('m1', 'src-a');
    expect(all).toHaveLength(1);
    expect(all[0].relayByte).toBe(0xa3);
    expect(all[0].snr).toBe(-5.25);
  });

  it('dedups on (sourceId, messageId, relayByte) and keeps the max SNR', async () => {
    await repo.recordHeardRepeater({
      sourceId: 'src-a', messageId: 'm1', relayByte: 0xa3, snr: -9.5, heardAt: HEARD_AT,
    });
    const merged = await repo.recordHeardRepeater({
      sourceId: 'src-a', messageId: 'm1', relayByte: 0xa3, snr: -3.25, heardAt: HEARD_AT + 1000,
    });
    expect(merged.snr).toBe(-3.25);
    expect(merged.heardAt).toBe(HEARD_AT + 1000);

    const lower = await repo.recordHeardRepeater({
      sourceId: 'src-a', messageId: 'm1', relayByte: 0xa3, snr: -12, heardAt: HEARD_AT + 2000,
    });
    expect(lower.snr).toBe(-3.25); // max retained
    expect(lower.heardAt).toBe(HEARD_AT + 2000); // heardAt still refreshed

    const all = await repo.getHeardRepeatersForMessage('m1', 'src-a');
    expect(all).toHaveLength(1);
    expect(all[0].snr).toBe(-3.25);
  });

  it('handles a null SNR without clobbering an existing value', async () => {
    await repo.recordHeardRepeater({
      sourceId: 'src-a', messageId: 'm1', relayByte: 0xa3, snr: 8, heardAt: HEARD_AT,
    });
    const merged = await repo.recordHeardRepeater({
      sourceId: 'src-a', messageId: 'm1', relayByte: 0xa3, snr: null, heardAt: HEARD_AT + 10,
    });
    expect(merged.snr).toBe(8);
  });

  it('getHeardRepeatersForMessage is scoped by sourceId', async () => {
    await repo.recordHeardRepeater({ sourceId: 'src-a', messageId: 'm1', relayByte: 0xa3, snr: 5, heardAt: HEARD_AT });
    await repo.recordHeardRepeater({ sourceId: 'src-b', messageId: 'm1', relayByte: 0xa3, snr: 5, heardAt: HEARD_AT });

    const a = await repo.getHeardRepeatersForMessage('m1', 'src-a');
    const b = await repo.getHeardRepeatersForMessage('m1', 'src-b');
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a.every(r => r.sourceId === 'src-a')).toBe(true);
    expect(b.every(r => r.sourceId === 'src-b')).toBe(true);

    // Same (messageId, relayByte) in two sources are distinct rows.
    await repo.recordHeardRepeater({ sourceId: 'src-a', messageId: 'm1', relayByte: 0x7f, snr: 1, heardAt: HEARD_AT });
    expect(await repo.getHeardRepeatersForMessage('m1', 'src-a')).toHaveLength(2);
    expect(await repo.getHeardRepeatersForMessage('m1', 'src-b')).toHaveLength(1);
  });

  it('getHeardRepeatersForMessage orders by SNR descending', async () => {
    await repo.recordHeardRepeater({ sourceId: 'src-a', messageId: 'm1', relayByte: 0xa3, snr: 2, heardAt: HEARD_AT });
    await repo.recordHeardRepeater({ sourceId: 'src-a', messageId: 'm1', relayByte: 0x7f, snr: 9, heardAt: HEARD_AT });
    await repo.recordHeardRepeater({ sourceId: 'src-a', messageId: 'm1', relayByte: 0xbc, snr: 5, heardAt: HEARD_AT });
    const all = await repo.getHeardRepeatersForMessage('m1', 'src-a');
    expect(all.map(r => r.relayByte)).toEqual([0x7f, 0xbc, 0xa3]);
  });

  it('getHeardRepeatersForMessage scopes by both sourceId and messageId (different message, same source)', async () => {
    await repo.recordHeardRepeater({ sourceId: 'src-a', messageId: 'm1', relayByte: 0xa3, snr: 5, heardAt: HEARD_AT });
    await repo.recordHeardRepeater({ sourceId: 'src-a', messageId: 'm2', relayByte: 0xa3, snr: 5, heardAt: HEARD_AT });

    expect(await repo.getHeardRepeatersForMessage('m1', 'src-a')).toHaveLength(1);
    expect(await repo.getHeardRepeatersForMessage('m2', 'src-a')).toHaveLength(1);
    expect(await repo.getHeardRepeatersForMessage('m3', 'src-a')).toHaveLength(0);
  });
});
