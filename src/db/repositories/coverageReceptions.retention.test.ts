/**
 * CoverageReceptionsRepository — retention purge tests (Coverage Report epic
 * #5277, Phase 1 WP1). `purgeOlderThan` is the single seam a future
 * saved-survey exemption (P4) attaches to, and is global by design (not
 * scoped by source) even though every row carries a sourceId.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  CoverageReceptionsRepository,
  type RecordCoverageReceptionParams,
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
});
