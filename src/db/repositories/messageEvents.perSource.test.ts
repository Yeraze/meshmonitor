/**
 * MessageEventsRepository — unit + per-source isolation tests (#4816 Phase 3
 * WP1).
 *
 * The `message_events` table (migration 151) carries a `sourceId` on every
 * row. These tests assert recording/terminal-dedup behaviour and that
 * queries never leak across sources. Runs against SQLite via `createTestDb()`
 * — PG/MySQL DDL is covered separately by
 * `151_create_message_events.pgmysql.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { MessageEventsRepository } from './messageEvents.js';
import * as schema from '../schema/index.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

const TS = 1_700_000_000_000;

describe('MessageEventsRepository', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: MessageEventsRepository;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    repo = new MessageEventsRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => {
    db.close();
  });

  it('recordEvent requires a sourceId', async () => {
    await expect(
      repo.recordEvent({
        sourceId: '',
        messageId: 'msg-1',
        eventType: 'submitted',
        provenance: 'reported',
        timestamp: TS,
      }),
    ).rejects.toThrow(/sourceId/);
  });

  it('recordEvent requires a messageId', async () => {
    await expect(
      repo.recordEvent({
        sourceId: 'src-a',
        messageId: '',
        eventType: 'submitted',
        provenance: 'reported',
        timestamp: TS,
      }),
    ).rejects.toThrow(/messageId/);
  });

  it('getEventsForMessage requires a sourceId and a messageId', async () => {
    await expect(repo.getEventsForMessage('', 'msg-1')).rejects.toThrow(/sourceId/);
    await expect(repo.getEventsForMessage('src-a', '')).rejects.toThrow(/messageId/);
  });

  it('records a single event and reads it back', async () => {
    await repo.recordEvent({
      sourceId: 'src-a',
      messageId: 'msg-1',
      eventType: 'submitted',
      provenance: 'reported',
      timestamp: TS,
    });

    const events = await repo.getEventsForMessage('src-a', 'msg-1');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sourceId: 'src-a',
      messageId: 'msg-1',
      eventType: 'submitted',
      provenance: 'reported',
      detail: null,
      timestamp: TS,
    });
    expect(typeof events[0].id).toBe('number');
    expect(typeof events[0].createdAt).toBe('number');
  });

  it('getEventsForMessage returns events in chronological ascending order', async () => {
    await repo.recordEvent({
      sourceId: 'src-a', messageId: 'msg-1', eventType: 'confirmed', provenance: 'reported', timestamp: TS + 3000,
    });
    await repo.recordEvent({
      sourceId: 'src-a', messageId: 'msg-1', eventType: 'submitted', provenance: 'reported', timestamp: TS,
    });
    await repo.recordEvent({
      sourceId: 'src-a', messageId: 'msg-1', eventType: 'retry', provenance: 'reported', timestamp: TS + 1000, detail: '{"attempt":1}',
    });

    const events = await repo.getEventsForMessage('src-a', 'msg-1');
    expect(events.map(e => e.eventType)).toEqual(['submitted', 'retry', 'confirmed']);
    expect(events.map(e => e.timestamp)).toEqual([TS, TS + 1000, TS + 3000]);
  });

  it('events for source A are invisible to source B', async () => {
    await repo.recordEvent({
      sourceId: 'src-a', messageId: 'msg-1', eventType: 'submitted', provenance: 'reported', timestamp: TS,
    });
    await repo.recordEvent({
      sourceId: 'src-b', messageId: 'msg-1', eventType: 'submitted', provenance: 'reported', timestamp: TS,
    });

    const a = await repo.getEventsForMessage('src-a', 'msg-1');
    const b = await repo.getEventsForMessage('src-b', 'msg-1');
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a.every(e => e.sourceId === 'src-a')).toBe(true);
    expect(b.every(e => e.sourceId === 'src-b')).toBe(true);
  });

  it('a terminal event type recorded twice results in exactly one row', async () => {
    await repo.recordEvent({
      sourceId: 'src-a', messageId: 'msg-1', eventType: 'delivered', provenance: 'reported', timestamp: TS,
    });
    await repo.recordEvent({
      sourceId: 'src-a', messageId: 'msg-1', eventType: 'delivered', provenance: 'reported', timestamp: TS + 5000, detail: '{"ackFromNode":123}',
    });

    const events = await repo.getEventsForMessage('src-a', 'msg-1');
    const delivered = events.filter(e => e.eventType === 'delivered');
    expect(delivered).toHaveLength(1);
    // First write wins — the dedup guard is a no-op on the duplicate, so the
    // original timestamp/detail is preserved.
    expect(delivered[0].timestamp).toBe(TS);
    expect(delivered[0].detail).toBeNull();
  });

  it.each(['submitted', 'sent_to_radio', 'delivered', 'confirmed', 'routing_error', 'timeout'] as const)(
    'dedups the terminal event type %s',
    async (eventType) => {
      await repo.recordEvent({
        sourceId: 'src-a', messageId: 'msg-1', eventType, provenance: 'reported', timestamp: TS,
      });
      await repo.recordEvent({
        sourceId: 'src-a', messageId: 'msg-1', eventType, provenance: 'reported', timestamp: TS + 10,
      });
      const events = await repo.getEventsForMessage('src-a', 'msg-1');
      expect(events.filter(e => e.eventType === eventType)).toHaveLength(1);
    },
  );

  it('retry is allowed to repeat with distinct detail', async () => {
    await repo.recordEvent({
      sourceId: 'src-a', messageId: 'msg-1', eventType: 'retry', provenance: 'reported', timestamp: TS, detail: '{"attempt":1}',
    });
    await repo.recordEvent({
      sourceId: 'src-a', messageId: 'msg-1', eventType: 'retry', provenance: 'reported', timestamp: TS + 1000, detail: '{"attempt":2}',
    });
    await repo.recordEvent({
      sourceId: 'src-a', messageId: 'msg-1', eventType: 'retry', provenance: 'reported', timestamp: TS + 2000, detail: '{"attempt":3}',
    });

    const events = await repo.getEventsForMessage('src-a', 'msg-1');
    const retries = events.filter(e => e.eventType === 'retry');
    expect(retries).toHaveLength(3);
    expect(retries.map(r => r.detail)).toEqual(['{"attempt":1}', '{"attempt":2}', '{"attempt":3}']);
  });

  it('getEventsForMessage scopes by both sourceId and messageId (different message, same source)', async () => {
    await repo.recordEvent({
      sourceId: 'src-a', messageId: 'msg-1', eventType: 'submitted', provenance: 'reported', timestamp: TS,
    });
    await repo.recordEvent({
      sourceId: 'src-a', messageId: 'msg-2', eventType: 'submitted', provenance: 'reported', timestamp: TS,
    });

    expect(await repo.getEventsForMessage('src-a', 'msg-1')).toHaveLength(1);
    expect(await repo.getEventsForMessage('src-a', 'msg-2')).toHaveLength(1);
    expect(await repo.getEventsForMessage('src-a', 'msg-3')).toHaveLength(0);
  });
});
