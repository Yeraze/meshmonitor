/**
 * CoverageReceptionsRepository — cross-dialect coverage on PostgreSQL and
 * MySQL (Coverage Report epic #5277, Phase 1 WP1).
 *
 * Per the spec, the table is created with the migration-172 runners
 * (`runMigration172Postgres`/`runMigration172Mysql`), NOT hand-written DDL —
 * this suite is the one place that matters, since a drift between the real
 * migration and a hand-rolled `CREATE TABLE` would otherwise go unnoticed.
 * Each backend gets its OWN isolated database (`isolationKey: 'covrx'`) so
 * this suite can run concurrently with any other PG/MySQL suite without a
 * fixture-table race (see CLAUDE.md "PG/MySQL fixture races").
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2';
import type pg from 'pg';
import type mysql from 'mysql2/promise';
import * as schema from '../schema/index.js';
import {
  CoverageReceptionsRepository,
  type RecordCoverageReceptionParams,
} from './coverageReceptions.js';
import { runMigration172Postgres, runMigration172Mysql } from '../../server/migrations/172_create_coverage_receptions.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from './test-utils.js';

const NOW = 1_760_000_000_000;
// Above 2^31 (unsigned 32-bit Meshtastic node numbers routinely exceed the
// signed 32-bit INT range PG/MySQL INTEGER would silently truncate).
const BIG_NODE_NUM = 0xaabbccdd; // 2,864,434,397

function makeReception(overrides: Partial<RecordCoverageReceptionParams> = {}): RecordCoverageReceptionParams {
  return {
    sourceId: 'src-a',
    protocol: 'meshtastic',
    receiverKind: 'local',
    receiverId: '!aabbccdd',
    receiverNodeNum: BIG_NODE_NUM,
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

interface Ctx {
  repo: CoverageReceptionsRepository;
  clear: () => Promise<void>;
}

/** Behaviours that must hold identically on every dialect. */
function runSharedTests(getCtx: () => Ctx) {
  it('dedupes on the full unique key: a duplicate returns false and adds no row', async () => {
    const { repo } = getCtx();
    expect(await repo.recordReception(makeReception())).toBe(true);
    expect(await repo.recordReception(makeReception())).toBe(false);

    const page = await repo.getReceptions({ sourceIds: ['src-a'], sinceMs: 0, untilMs: NOW + 1, pageSize: 10 });
    expect(page.items).toHaveLength(1);
  });

  it('a different pathKey survives as its own row', async () => {
    const { repo } = getCtx();
    await repo.recordReception(makeReception({ pathKey: 'r0:h0' }));
    await repo.recordReception(makeReception({ pathKey: 'r5:h1' }));

    const page = await repo.getReceptions({ sourceIds: ['src-a'], sinceMs: 0, untilMs: NOW + 1, pageSize: 10 });
    expect(page.items).toHaveLength(2);
  });

  it('window + hops query: filters by [sinceMs,untilMs] and hopsMode', async () => {
    const { repo } = getCtx();
    await repo.recordReception(makeReception({ pathKey: 'p0', hopsAway: 0, receivedAt: NOW }));
    await repo.recordReception(makeReception({ pathKey: 'p1', hopsAway: 1, receivedAt: NOW + 1000 }));
    await repo.recordReception(makeReception({ pathKey: 'p-out-of-window', hopsAway: 0, receivedAt: NOW + 100_000 }));

    const page = await repo.getReceptions({
      sourceIds: ['src-a'], sinceMs: NOW, untilMs: NOW + 2000, hops: 1, hopsMode: 'max', pageSize: 10,
    });
    expect(page.items.map((r) => r.pathKey).sort()).toEqual(['p0', 'p1']);
  });

  it('BIGINT nodeNum above 2^31 round-trips as a number', async () => {
    const { repo } = getCtx();
    await repo.recordReception(makeReception({ receiverNodeNum: BIG_NODE_NUM, senderNodeNum: BIG_NODE_NUM }));

    const page = await repo.getReceptions({ sourceIds: ['src-a'], sinceMs: 0, untilMs: NOW + 1, pageSize: 10 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0].receiverNodeNum).toBe(BIG_NODE_NUM);
    expect(page.items[0].senderNodeNum).toBe(BIG_NODE_NUM);
    expect(typeof page.items[0].receiverNodeNum).toBe('number');
  });

  it('getReceivers groups distinct receivers and returns the latest snapshot', async () => {
    const { repo } = getCtx();
    await repo.recordReception(makeReception({ receiverId: '!aabbccdd', pathKey: 'p1', receivedAt: NOW }));
    await repo.recordReception(makeReception({
      receiverId: '!aabbccdd', pathKey: 'p2', receivedAt: NOW + 5000,
      receiverLatitude: null, receiverLongitude: null,
    }));

    const receivers = await repo.getReceivers({ sourceIds: ['src-a'], sinceMs: 0 });
    expect(receivers).toHaveLength(1);
    expect(receivers[0].lastReceivedAt).toBe(NOW + 5000);
    expect(receivers[0].receiverLatitude).toBe(40.0);
    expect(receivers[0].receiverLongitude).toBe(-105.0);
    expect(receivers[0].receptionCount).toBe(2);
  });

  it('getReceivers with untilMs excludes rows outside the window and keeps the in-window snapshot (#5277 Phase 4b WP2)', async () => {
    const { repo } = getCtx();
    await repo.recordReception(makeReception({
      receiverId: '!aabbccdd', pathKey: 'p1', receivedAt: NOW,
      receiverLatitude: 40.0, receiverLongitude: -105.0,
    }));
    await repo.recordReception(makeReception({
      receiverId: '!aabbccdd', pathKey: 'p2', receivedAt: NOW + 50_000,
      receiverLatitude: 41.0, receiverLongitude: -106.0,
    }));

    const bounded = await repo.getReceivers({ sourceIds: ['src-a'], sinceMs: 0, untilMs: NOW + 1000 });
    expect(bounded).toHaveLength(1);
    expect(bounded[0].lastReceivedAt).toBe(NOW);
    expect(bounded[0].receiverLatitude).toBe(40.0);
    expect(bounded[0].receiverLongitude).toBe(-105.0);
    expect(bounded[0].receptionCount).toBe(1);

    const unbounded = await repo.getReceivers({ sourceIds: ['src-a'], sinceMs: 0 });
    expect(unbounded).toHaveLength(1);
    expect(unbounded[0].lastReceivedAt).toBe(NOW + 50_000);
    expect(unbounded[0].receptionCount).toBe(2);
  });

  it('getReceivers batches the snapshot follow-up across the 200-chunk boundary (Decision D9)', async () => {
    const { repo } = getCtx();
    const total = 250;
    for (let i = 0; i < total; i++) {
      await repo.recordReception(makeReception({
        receiverId: `!${i.toString(16).padStart(8, '0')}`,
        receiverNodeNum: i,
        pathKey: `p-${i}`,
        receiverLatitude: 40 + i * 0.001,
        receiverLongitude: -105 - i * 0.001,
      }));
    }

    const receivers = await repo.getReceivers({ sourceIds: ['src-a'], sinceMs: 0 });
    expect(receivers).toHaveLength(total);
    for (const r of receivers) {
      const i = Number(r.receiverNodeNum);
      expect(r.receiverLatitude).toBeCloseTo(40 + i * 0.001, 6);
      expect(r.receiverLongitude).toBeCloseTo(-105 - i * 0.001, 6);
      expect(r.receptionCount).toBe(1);
    }
  });

  it('getReceptions with a receiverFilter: include on one source never leaks the same receiverId on another', async () => {
    const { repo } = getCtx();
    await repo.recordReception(makeReception({ sourceId: 'src-a', receiverId: '!shared', pathKey: 'pa' }));
    await repo.recordReception(makeReception({ sourceId: 'src-b', receiverId: '!shared', pathKey: 'pb' }));

    const page = await repo.getReceptions({
      sourceIds: ['src-a', 'src-b'], sinceMs: 0, untilMs: NOW + 1, pageSize: 10,
      receiverFilter: [{ sourceId: 'src-a', mode: 'include', receiverIds: ['!not-shared'] }],
    });
    // src-a is constrained to an id that doesn't match; src-b is unconstrained.
    expect(page.items.map((r) => r.sourceId)).toEqual(['src-b']);
  });

  it('getReceptions drops a receiverFilter entry for a non-permitted source', async () => {
    const { repo } = getCtx();
    await repo.recordReception(makeReception({ sourceId: 'src-a', receiverId: '!a1', pathKey: 'a1' }));

    const page = await repo.getReceptions({
      sourceIds: ['src-a'], sinceMs: 0, untilMs: NOW + 1, pageSize: 10,
      receiverFilter: [{ sourceId: 'src-b', mode: 'include', receiverIds: ['!nope'] }],
    });
    expect(page.items.map((r) => r.receiverId)).toEqual(['!a1']);
  });

  it('purgeOlderThan deletes only rows before the cutoff, across sources', async () => {
    const { repo } = getCtx();
    await repo.recordReception(makeReception({ sourceId: 'src-a', pathKey: 'old', receivedAt: NOW - 10_000 }));
    await repo.recordReception(makeReception({ sourceId: 'src-b', pathKey: 'new', receivedAt: NOW }));

    const deleted = await repo.purgeOlderThan(NOW - 1000);
    expect(deleted).toBe(1);

    const remaining = await repo.getReceptions({
      sourceIds: ['src-a', 'src-b'], sinceMs: 0, untilMs: NOW + 1000, pageSize: 10,
    });
    expect(remaining.items.map((r) => r.pathKey)).toEqual(['new']);
  });

  it('round-trips a 64-hex MeshCore row (#5277 Phase 3 WP2 §2.4: repository unchanged)', async () => {
    const { repo } = getCtx();
    const pubkey64 = 'a'.repeat(64);
    const otherPubkey64 = 'b'.repeat(64);
    await repo.recordReception(makeReception({
      protocol: 'meshcore',
      receiverKind: 'local',
      receiverId: pubkey64,
      receiverNodeNum: null,
      senderId: otherPubkey64,
      senderNodeNum: null,
      packetKey: 'ABCDEF0123456789', // 16-hex MeshCore packet hash
      packetId: null,
      pathKey: 'h2:a1b2',
      hopStart: null,
      hopLimit: null,
      hopsAway: 2,
      relayNode: null,
      transportMechanism: null,
      channel: null,
      rxTime: null,
    }));

    const page = await repo.getReceptions({ sourceIds: ['src-a'], sinceMs: 0, untilMs: NOW + 1, pageSize: 10 });
    expect(page.items).toHaveLength(1);
    const row = page.items[0];
    expect(row.protocol).toBe('meshcore');
    expect(row.receiverId).toBe(pubkey64);
    expect(row.senderId).toBe(otherPubkey64);
    expect(row.receiverNodeNum).toBeNull();
    expect(row.senderNodeNum).toBeNull();
    expect(row.packetId).toBeNull();
    expect(row.pathKey).toBe('h2:a1b2');

    const receivers = await repo.getReceivers({ sourceIds: ['src-a'], sinceMs: 0 });
    const mcReceiver = receivers.find((r) => r.receiverId === pubkey64);
    expect(mcReceiver).toBeDefined();
    expect(mcReceiver?.protocol).toBe('meshcore');

    const senders = await repo.getSenderSummary({ sourceIds: ['src-a'], sinceMs: 0, untilMs: NOW + 1, limit: 10 });
    const mcSender = senders.find((s) => s.senderId === otherPubkey64);
    expect(mcSender).toBeDefined();
    expect(mcSender?.senderNodeNum).toBeNull();
  });

  it('deleteForSource removes only the target source', async () => {
    const { repo } = getCtx();
    await repo.recordReception(makeReception({ sourceId: 'src-a', pathKey: 'a1' }));
    await repo.recordReception(makeReception({ sourceId: 'src-b', pathKey: 'b1' }));

    const deleted = await repo.deleteForSource('src-a');
    expect(deleted).toBe(1);

    const aPage = await repo.getReceptions({ sourceIds: ['src-a'], sinceMs: 0, untilMs: NOW + 1, pageSize: 10 });
    const bPage = await repo.getReceptions({ sourceIds: ['src-b'], sinceMs: 0, untilMs: NOW + 1, pageSize: 10 });
    expect(aPage.items).toHaveLength(0);
    expect(bPage.items).toHaveLength(1);
  });

  it('purgeOlderThan with a survey exemption window: the not(or(and…)) SQL runs on this dialect (#5277 Phase 4b WP1)', async () => {
    const { repo } = getCtx();
    await repo.recordReception(makeReception({
      sourceId: 'src-a', senderId: '!survey01', pathKey: 'in-window', receivedAt: NOW - 100_000,
    }));
    await repo.recordReception(makeReception({
      sourceId: 'src-b', senderId: '!survey01', pathKey: 'in-window-other-source', receivedAt: NOW - 100_000,
    }));
    await repo.recordReception(makeReception({
      sourceId: 'src-a', senderId: '!other-sender', pathKey: 'wrong-sender', receivedAt: NOW - 100_000,
    }));
    await repo.recordReception(makeReception({
      sourceId: 'src-a', senderId: '!survey01', pathKey: 'before-window', receivedAt: NOW - 300_000,
    }));

    const deleted = await repo.purgeOlderThan(NOW - 1000, [
      { senderId: '!survey01', startAt: NOW - 200_000, endAt: NOW - 50_000 },
    ]);
    // Two rows fall outside the exemption ("wrong-sender" and "before-window").
    expect(deleted).toBe(2);

    const remaining = await repo.getReceptions({
      sourceIds: ['src-a', 'src-b'], sinceMs: 0, untilMs: NOW, pageSize: 100,
    });
    expect(remaining.items.map((r) => r.pathKey).sort()).toEqual(['in-window', 'in-window-other-source']);
  });

  it('exportSurveyReceptions returns in-window rows with id omitted, across sources', async () => {
    const { repo } = getCtx();
    await repo.recordReception(makeReception({
      sourceId: 'src-a', senderId: '!survey01', pathKey: 'in-a', receivedAt: NOW - 100_000,
    }));
    await repo.recordReception(makeReception({
      sourceId: 'src-b', senderId: '!survey01', pathKey: 'in-b', receivedAt: NOW - 100_000,
    }));
    await repo.recordReception(makeReception({
      sourceId: 'src-a', senderId: '!survey01', pathKey: 'out-of-window', receivedAt: NOW - 500_000,
    }));

    const rows = await repo.exportSurveyReceptions([
      { senderId: '!survey01', startAt: NOW - 200_000, endAt: NOW - 50_000 },
    ]);
    expect(rows.map((r) => r.pathKey).sort()).toEqual(['in-a', 'in-b']);
    for (const row of rows) {
      expect('id' in row).toBe(false);
    }
  });
}

describe.skipIf(!postgresAvailable)('CoverageReceptionsRepository — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanupDb: (() => Promise<void>) | undefined;
  let repo: CoverageReceptionsRepository;

  beforeAll(async () => {
    const isolated = await createIsolatedPostgresDatabase('covrx');
    pool = isolated.pool;
    cleanupDb = isolated.cleanup;

    const client = await pool.connect();
    try {
      await runMigration172Postgres(client);
    } finally {
      client.release();
    }

    const drizzleDb = drizzlePostgres(pool, { schema });
    repo = new CoverageReceptionsRepository(drizzleDb, 'postgres');
  });

  afterAll(async () => {
    await cleanupDb?.();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE coverage_receptions RESTART IDENTITY CASCADE');
  });

  runSharedTests(() => ({
    repo,
    clear: async () => {
      await pool.query('TRUNCATE TABLE coverage_receptions RESTART IDENTITY CASCADE');
    },
  }));
});

describe.skipIf(!mysqlAvailable)('CoverageReceptionsRepository — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanupDb: (() => Promise<void>) | undefined;
  let repo: CoverageReceptionsRepository;

  beforeAll(async () => {
    const isolated = await createIsolatedMysqlDatabase('covrx');
    pool = isolated.pool;
    cleanupDb = isolated.cleanup;

    await runMigration172Mysql(pool);

    const drizzleDb = drizzleMysql(pool, { schema, mode: 'default' });
    repo = new CoverageReceptionsRepository(drizzleDb, 'mysql');
  });

  afterAll(async () => {
    await cleanupDb?.();
  });

  beforeEach(async () => {
    await pool.query('SET FOREIGN_KEY_CHECKS = 0');
    await pool.query('TRUNCATE TABLE coverage_receptions');
    await pool.query('SET FOREIGN_KEY_CHECKS = 1');
  });

  runSharedTests(() => ({
    repo,
    clear: async () => {
      await pool.query('TRUNCATE TABLE coverage_receptions');
    },
  }));
});
