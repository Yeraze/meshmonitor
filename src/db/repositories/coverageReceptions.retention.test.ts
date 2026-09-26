/**
 * CoverageReceptionsRepository — retention purge tests (Coverage Report epic
 * #5277, Phase 1 WP1 + Phase 4b WP1). `purgeOlderThan` is the single seam a
 * saved-survey exemption attaches to, and is global by design (not scoped by
 * source) even though every row carries a sourceId.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  CoverageReceptionsRepository,
  type RecordCoverageReceptionParams,
  type CoverageRetentionExemptionWindow,
} from './coverageReceptions.js';
import * as schema from '../schema/index.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

const NOW = 1_760_000_000_000;

function makeReception(overrides: Partial<RecordCoverageReceptionParams> = {}): RecordCoverageReceptionParams {
  return {
    sourceId: 'src-a',
    protocol: 'meshtastic',
    receiverKind: 'local',
    receiverId: '!aaaaaaaa',
    receiverNodeNum: 0xaaaaaaaa,
    receiverLatitude: 40.0,
    receiverLongitude: -105.0,
    senderId: '!bbbbbbbb',
    senderNodeNum: 0xbbbbbbbb,
    packetKey: '100',
    packetId: 100,
    pathKey: 'r0:h0',
    latitude: 40.1,
    longitude: -105.1,
    altitude: null,
    precisionBits: null,
    snr: 5.5,
    rssi: -80,
    hopStart: 3,
    hopLimit: 3,
    hopsAway: 0,
    relayNode: 0,
    transportMechanism: 0,
    channel: 0,
    rxTime: Math.floor(NOW / 1000),
    receivedAt: NOW,
    ...overrides,
  };
}

describe('CoverageReceptionsRepository — retention purge', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: CoverageReceptionsRepository;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    repo = new CoverageReceptionsRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => {
    db.close();
  });

  it('purgeOlderThan removes only receivedAt < cutoff rows, across sources, and returns the count', async () => {
    await repo.recordReception(makeReception({ sourceId: 'src-a', pathKey: 'old-a', receivedAt: NOW - 10_000 }));
    await repo.recordReception(makeReception({ sourceId: 'src-b', pathKey: 'old-b', receivedAt: NOW - 5_000 }));
    await repo.recordReception(makeReception({ sourceId: 'src-a', pathKey: 'new-a', receivedAt: NOW }));
    await repo.recordReception(makeReception({ sourceId: 'src-b', pathKey: 'new-b', receivedAt: NOW + 1000 }));

    const deleted = await repo.purgeOlderThan(NOW - 1000);
    expect(deleted).toBe(2);

    const remaining = await repo.getReceptions({
      sourceIds: ['src-a', 'src-b'], sinceMs: 0, untilMs: NOW + 10_000, pageSize: 100,
    });
    expect(remaining.items.map((r) => r.pathKey).sort()).toEqual(['new-a', 'new-b']);
  });

  it('a cutoff equal to receivedAt does not delete that row (strict less-than)', async () => {
    await repo.recordReception(makeReception({ pathKey: 'boundary', receivedAt: NOW }));
    const deleted = await repo.purgeOlderThan(NOW);
    expect(deleted).toBe(0);
  });

  it('returns 0 when nothing qualifies', async () => {
    await repo.recordReception(makeReception({ pathKey: 'keep', receivedAt: NOW }));
    const deleted = await repo.purgeOlderThan(NOW - 1_000_000);
    expect(deleted).toBe(0);
  });

  it('an empty (or omitted) exemptions list is exactly P1 behaviour', async () => {
    await repo.recordReception(makeReception({ pathKey: 'old', receivedAt: NOW - 10_000 }));
    const deleted = await repo.purgeOlderThan(NOW - 1000, []);
    expect(deleted).toBe(1);
  });
});

describe('CoverageReceptionsRepository — purgeOlderThan with survey exemption windows (#5277 Phase 4b WP1)', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: CoverageReceptionsRepository;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    repo = new CoverageReceptionsRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => {
    db.close();
  });

  it('a row inside a survey window survives the sweep even though it is older than the cutoff', async () => {
    await repo.recordReception(makeReception({
      senderId: '!survey01', pathKey: 'in-window', receivedAt: NOW - 100_000,
    }));
    const exemptions: CoverageRetentionExemptionWindow[] = [
      { senderId: '!survey01', startAt: NOW - 200_000, endAt: NOW - 50_000 },
    ];

    const deleted = await repo.purgeOlderThan(NOW - 1000, exemptions);
    expect(deleted).toBe(0);

    const remaining = await repo.getReceptions({ sourceIds: ['src-a'], sinceMs: 0, untilMs: NOW, pageSize: 100 });
    expect(remaining.items.map((r) => r.pathKey)).toEqual(['in-window']);
  });

  it('the same sender OUTSIDE the exempted window is still purged', async () => {
    await repo.recordReception(makeReception({
      senderId: '!survey01', pathKey: 'before-window', receivedAt: NOW - 300_000,
    }));
    const exemptions: CoverageRetentionExemptionWindow[] = [
      { senderId: '!survey01', startAt: NOW - 200_000, endAt: NOW - 50_000 },
    ];

    const deleted = await repo.purgeOlderThan(NOW - 1000, exemptions);
    expect(deleted).toBe(1);
  });

  it('a DIFFERENT sender inside the same time window is still purged (exemption is sender-scoped)', async () => {
    await repo.recordReception(makeReception({
      senderId: '!other-sender', pathKey: 'wrong-sender', receivedAt: NOW - 100_000,
    }));
    const exemptions: CoverageRetentionExemptionWindow[] = [
      { senderId: '!survey01', startAt: NOW - 200_000, endAt: NOW - 50_000 },
    ];

    const deleted = await repo.purgeOlderThan(NOW - 1000, exemptions);
    expect(deleted).toBe(1);
  });

  it('the exemption applies across every source for that sender + window', async () => {
    await repo.recordReception(makeReception({
      sourceId: 'src-a', senderId: '!survey01', pathKey: 'src-a-row', receivedAt: NOW - 100_000,
    }));
    await repo.recordReception(makeReception({
      sourceId: 'src-b', senderId: '!survey01', pathKey: 'src-b-row', receivedAt: NOW - 100_000,
    }));
    const exemptions: CoverageRetentionExemptionWindow[] = [
      { senderId: '!survey01', startAt: NOW - 200_000, endAt: NOW - 50_000 },
    ];

    const deleted = await repo.purgeOlderThan(NOW - 1000, exemptions);
    expect(deleted).toBe(0);
  });

  it('a live survey past its cap stops exempting (the caller passes the already-resolved effective end)', async () => {
    // Simulates coverageRetentionService calling getExemptionWindows(now), which resolves
    // a lapsed live survey's window to end at startAt + LIVE_MAX rather than "now".
    await repo.recordReception(makeReception({
      senderId: '!lapsed01', pathKey: 'after-cap', receivedAt: NOW - 10_000,
    }));
    const exemptions: CoverageRetentionExemptionWindow[] = [
      // Effective end resolved well before this row's receivedAt — the row falls
      // outside the exemption window and gets purged like any other old row.
      { senderId: '!lapsed01', startAt: NOW - 100_000, endAt: NOW - 50_000 },
    ];

    const deleted = await repo.purgeOlderThan(NOW - 1000, exemptions);
    expect(deleted).toBe(1);
  });

  it('several exemption windows for several surveys all apply at once', async () => {
    await repo.recordReception(makeReception({ senderId: '!s1', pathKey: 's1-in', receivedAt: NOW - 100_000 }));
    await repo.recordReception(makeReception({ senderId: '!s2', pathKey: 's2-in', receivedAt: NOW - 300_000 }));
    await repo.recordReception(makeReception({ senderId: '!s3', pathKey: 's3-purged', receivedAt: NOW - 500_000 }));
    const exemptions: CoverageRetentionExemptionWindow[] = [
      { senderId: '!s1', startAt: NOW - 200_000, endAt: NOW - 50_000 },
      { senderId: '!s2', startAt: NOW - 400_000, endAt: NOW - 250_000 },
    ];

    const deleted = await repo.purgeOlderThan(NOW - 1000, exemptions);
    expect(deleted).toBe(1);

    const remaining = await repo.getReceptions({ sourceIds: ['src-a'], sinceMs: 0, untilMs: NOW, pageSize: 100 });
    expect(remaining.items.map((r) => r.pathKey).sort()).toEqual(['s1-in', 's2-in']);
  });
});

describe('CoverageReceptionsRepository — exportSurveyReceptions (#5277 Phase 4b WP1, backup U3)', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: CoverageReceptionsRepository;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    repo = new CoverageReceptionsRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => {
    db.close();
  });

  it('returns [] immediately when there are no windows', async () => {
    await repo.recordReception(makeReception({ pathKey: 'p1' }));
    expect(await repo.exportSurveyReceptions([])).toEqual([]);
  });

  it('returns only rows inside a window, with the id column omitted', async () => {
    await repo.recordReception(makeReception({ senderId: '!survey01', pathKey: 'in-window', receivedAt: NOW - 100_000 }));
    await repo.recordReception(makeReception({ senderId: '!survey01', pathKey: 'out-of-window', receivedAt: NOW - 500_000 }));
    await repo.recordReception(makeReception({ senderId: '!other', pathKey: 'other-sender', receivedAt: NOW - 100_000 }));

    const rows = await repo.exportSurveyReceptions([
      { senderId: '!survey01', startAt: NOW - 200_000, endAt: NOW - 50_000 },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].pathKey).toBe('in-window');
    expect('id' in rows[0]).toBe(false);
  });

  it('spans every source for the same sender + window', async () => {
    await repo.recordReception(makeReception({
      sourceId: 'src-a', senderId: '!survey01', pathKey: 'src-a-row', receivedAt: NOW - 100_000,
    }));
    await repo.recordReception(makeReception({
      sourceId: 'src-b', senderId: '!survey01', pathKey: 'src-b-row', receivedAt: NOW - 100_000,
    }));

    const rows = await repo.exportSurveyReceptions([
      { senderId: '!survey01', startAt: NOW - 200_000, endAt: NOW - 50_000 },
    ]);
    expect(rows.map((r) => r.pathKey).sort()).toEqual(['src-a-row', 'src-b-row']);
  });

  it('unions rows from multiple windows', async () => {
    await repo.recordReception(makeReception({ senderId: '!s1', pathKey: 's1-in', receivedAt: NOW - 100_000 }));
    await repo.recordReception(makeReception({ senderId: '!s2', pathKey: 's2-in', receivedAt: NOW - 300_000 }));

    const rows = await repo.exportSurveyReceptions([
      { senderId: '!s1', startAt: NOW - 200_000, endAt: NOW - 50_000 },
      { senderId: '!s2', startAt: NOW - 400_000, endAt: NOW - 250_000 },
    ]);
    expect(rows.map((r) => r.pathKey).sort()).toEqual(['s1-in', 's2-in']);
  });
});
