/**
 * CoverageReceptionsRepository — per-source isolation tests (Coverage Report
 * epic #5277, Phase 1 WP1). Asserts that reads scoped to source A never
 * return source B's rows, and that `deleteForSource`/`deleteAll` only touch
 * what they claim to.
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

describe('CoverageReceptionsRepository — per-source isolation', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: CoverageReceptionsRepository;

  beforeEach(async () => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    repo = new CoverageReceptionsRepository(drizzleDb, 'sqlite');

    await repo.recordReception(makeReception({ sourceId: 'src-a', receiverId: '!aaaaaaaa', senderId: '!bbbbbbbb', pathKey: 'a1' }));
    await repo.recordReception(makeReception({ sourceId: 'src-a', receiverId: '!aaaaaaaa', senderId: '!bbbbbbbb', pathKey: 'a2' }));
    await repo.recordReception(makeReception({ sourceId: 'src-b', receiverId: '!eeeeeeee', senderId: '!ffffffff', pathKey: 'b1' }));
  });

  afterEach(() => {
    db.close();
  });

  it('getReceptions scoped to A never returns B', async () => {
    const page = await repo.getReceptions({ sourceIds: ['src-a'], sinceMs: 0, untilMs: NOW + 1, pageSize: 10 });
    expect(page.items).toHaveLength(2);
    expect(page.items.every((r) => r.sourceId === 'src-a')).toBe(true);
  });

  it('getReceivers scoped to A never returns B', async () => {
    const receivers = await repo.getReceivers({ sourceIds: ['src-a'], sinceMs: 0 });
    expect(receivers).toHaveLength(1);
    expect(receivers[0].sourceId).toBe('src-a');
  });

  it('getSenderSummary scoped to A never returns B', async () => {
    const senders = await repo.getSenderSummary({ sourceIds: ['src-a'], sinceMs: 0, untilMs: NOW + 1, limit: 10 });
    expect(senders).toHaveLength(1);
    expect(senders[0].sourceId).toBe('src-a');
  });

  it('querying with sources=[B] as an "A-only" user returns nothing (route-level intersection simulated here at the repo boundary)', async () => {
    // The repo itself has no permission notion — this asserts that asking
    // only for B, while A also has data, returns exactly B's rows and none
    // of A's (i.e. scoping is a real filter, not a a no-op).
    const page = await repo.getReceptions({ sourceIds: ['src-b'], sinceMs: 0, untilMs: NOW + 1, pageSize: 10 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0].sourceId).toBe('src-b');
  });

  it('deleteForSource("src-a") removes only A, leaving B intact', async () => {
    const deleted = await repo.deleteForSource('src-a');
    expect(deleted).toBe(2);

    const aPage = await repo.getReceptions({ sourceIds: ['src-a'], sinceMs: 0, untilMs: NOW + 1, pageSize: 10 });
    expect(aPage.items).toHaveLength(0);

    const bPage = await repo.getReceptions({ sourceIds: ['src-b'], sinceMs: 0, untilMs: NOW + 1, pageSize: 10 });
    expect(bPage.items).toHaveLength(1);
  });

  it('deleteForSource throws on an empty sourceId', async () => {
    await expect(repo.deleteForSource('')).rejects.toThrow(/sourceId/);
  });

  it('deleteAll empties the table across every source', async () => {
    const deleted = await repo.deleteAll();
    expect(deleted).toBe(3);

    const aPage = await repo.getReceptions({ sourceIds: ['src-a'], sinceMs: 0, untilMs: NOW + 1, pageSize: 10 });
    const bPage = await repo.getReceptions({ sourceIds: ['src-b'], sinceMs: 0, untilMs: NOW + 1, pageSize: 10 });
    expect(aPage.items).toHaveLength(0);
    expect(bPage.items).toHaveLength(0);
  });
});
