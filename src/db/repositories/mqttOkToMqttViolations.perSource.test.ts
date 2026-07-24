/**
 * MQTT `ok_to_mqtt` Violations Repository — per-source isolation tests.
 *
 * The `mqtt_ok_to_mqtt_violations` table (migration 128) carries a `sourceId`
 * on every row. These tests assert that every method — cross-source and
 * single-source alike — never leaks or deletes across sources. See
 * MQTT_OK_TO_MQTT_PHASE1_SPEC.md §3.8/§4.9.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  MqttOkToMqttViolationsRepository,
  type DbMqttOkToMqttViolation,
} from './mqttOkToMqttViolations.js';
import * as schema from '../schema/index.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

const SOURCE_A = 'source-a';
const SOURCE_B = 'source-b';

function makeViolation(sourceId: string, overrides: Partial<DbMqttOkToMqttViolation> = {}): DbMqttOkToMqttViolation {
  const now = 1_700_000_000_000;
  return {
    sourceId,
    packetId: 100,
    fromNode: 111,
    fromNodeId: '!0000006f',
    gatewayId: '!aabbccdd',
    gatewayNodeNum: 0xaabbccdd,
    channelId: 'LongFast',
    portnum: 1,
    portnumName: 'TEXT_MESSAGE_APP',
    bitfield: 0,
    topic: 'msh/US/2/e/LongFast/!aabbccdd',
    rxTime: now,
    timestamp: now,
    createdAt: now,
    ...overrides,
  };
}

describe('MqttOkToMqttViolationsRepository — per-source isolation', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: MqttOkToMqttViolationsRepository;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    repo = new MqttOkToMqttViolationsRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => {
    db.close();
  });

  /** Seed one identically-shaped violation under each source, differing only by identity fields to avoid dedupe collisions. */
  async function seedBothSources() {
    await repo.insertViolation(makeViolation(SOURCE_A, {
      packetId: 1, fromNode: 10, gatewayId: '!gwaaaaaa', gatewayNodeNum: 0xaaaaaaaa, timestamp: 1000, createdAt: 1000,
    }));
    await repo.insertViolation(makeViolation(SOURCE_A, {
      packetId: 2, fromNode: 11, gatewayId: '!gwaaaaaa', gatewayNodeNum: 0xaaaaaaaa, timestamp: 2000, createdAt: 2000,
    }));
    await repo.insertViolation(makeViolation(SOURCE_B, {
      packetId: 1, fromNode: 20, gatewayId: '!gwbbbbbb', gatewayNodeNum: 0xbbbbbbbb, timestamp: 1500, createdAt: 1500,
    }));
  }

  it('getGatewaySummary never leaks rows across sources', async () => {
    await seedBothSources();

    const aOnly = await repo.getGatewaySummary({ sourceIds: [SOURCE_A], since: 0, until: Date.now() + 1_000_000 });
    expect(aOnly).toHaveLength(1);
    expect(aOnly[0].gatewayId).toBe('!gwaaaaaa');
    expect(aOnly[0].violationCount).toBe(2);

    const bOnly = await repo.getGatewaySummary({ sourceIds: [SOURCE_B], since: 0, until: Date.now() + 1_000_000 });
    expect(bOnly).toHaveLength(1);
    expect(bOnly[0].gatewayId).toBe('!gwbbbbbb');
    expect(bOnly[0].violationCount).toBe(1);

    const both = await repo.getGatewaySummary({ sourceIds: [SOURCE_A, SOURCE_B], since: 0, until: Date.now() + 1_000_000 });
    expect(both).toHaveLength(2);
  });

  it('getGatewaySummaryCount never leaks rows across sources', async () => {
    await seedBothSources();
    expect(await repo.getGatewaySummaryCount({ sourceIds: [SOURCE_A], since: 0, until: Date.now() + 1_000_000 })).toBe(1);
    expect(await repo.getGatewaySummaryCount({ sourceIds: [SOURCE_B], since: 0, until: Date.now() + 1_000_000 })).toBe(1);
  });

  it('getGatewaySourceIds returns both sources when requested and neither in isolation', async () => {
    await seedBothSources();
    const both = await repo.getGatewaySourceIds({ sourceIds: [SOURCE_A, SOURCE_B], since: 0, until: Date.now() + 1_000_000 });
    expect(both.map(r => r.sourceId).sort()).toEqual([SOURCE_A, SOURCE_B]);

    const aOnly = await repo.getGatewaySourceIds({ sourceIds: [SOURCE_A], since: 0, until: Date.now() + 1_000_000 });
    expect(aOnly.every(r => r.sourceId === SOURCE_A)).toBe(true);
  });

  it('getViolations never leaks rows across sources', async () => {
    await seedBothSources();

    const aOnly = await repo.getViolations({ sourceIds: [SOURCE_A], since: 0, until: Date.now() + 1_000_000 });
    expect(aOnly).toHaveLength(2);
    expect(aOnly.every(r => r.sourceId === SOURCE_A)).toBe(true);

    const bOnly = await repo.getViolations({ sourceIds: [SOURCE_B], since: 0, until: Date.now() + 1_000_000 });
    expect(bOnly).toHaveLength(1);
    expect(bOnly.every(r => r.sourceId === SOURCE_B)).toBe(true);
  });

  it('getViolationCount never leaks rows across sources', async () => {
    await seedBothSources();
    expect(await repo.getViolationCount({ sourceIds: [SOURCE_A], since: 0, until: Date.now() + 1_000_000 })).toBe(2);
    expect(await repo.getViolationCount({ sourceIds: [SOURCE_B], since: 0, until: Date.now() + 1_000_000 })).toBe(1);
  });

  it('getRowCount is source-scoped', async () => {
    await seedBothSources();
    expect(await repo.getRowCount({ sourceId: SOURCE_A })).toBe(2);
    expect(await repo.getRowCount({ sourceId: SOURCE_B })).toBe(1);
    expect(await repo.getRowCount()).toBe(3);
  });

  it('deleteViolationsOlderThan is source-scoped when a sourceId is given', async () => {
    await repo.insertViolation(makeViolation(SOURCE_A, { packetId: 1, timestamp: 100, createdAt: 100 }));
    await repo.insertViolation(makeViolation(SOURCE_A, { packetId: 2, timestamp: 500, createdAt: 500 }));
    await repo.insertViolation(makeViolation(SOURCE_B, { packetId: 1, timestamp: 100, createdAt: 100 }));

    const removed = await repo.deleteViolationsOlderThan(300, SOURCE_A);
    expect(removed).toBe(1);
    expect(await repo.getRowCount({ sourceId: SOURCE_A })).toBe(1);
    // src-b untouched despite being older than the cutoff.
    expect(await repo.getRowCount({ sourceId: SOURCE_B })).toBe(1);
  });

  it('trimViolationsToCount keeps the newest N rows for a source only', async () => {
    for (let i = 0; i < 10; i++) {
      await repo.insertViolation(makeViolation(SOURCE_A, { packetId: i + 1, timestamp: 100 + i, createdAt: 100 + i }));
    }
    await repo.insertViolation(makeViolation(SOURCE_B, { packetId: 999, timestamp: 999, createdAt: 999 }));

    const removed = await repo.trimViolationsToCount(SOURCE_A, 3);
    expect(removed).toBe(7);

    expect(await repo.getRowCount({ sourceId: SOURCE_A })).toBe(3);
    // src-b untouched.
    expect(await repo.getRowCount({ sourceId: SOURCE_B })).toBe(1);
  });

  it('deleteAllViolations is source-scoped', async () => {
    await seedBothSources();

    const removed = await repo.deleteAllViolations(SOURCE_A);
    expect(removed).toBe(2);
    expect(await repo.getRowCount({ sourceId: SOURCE_A })).toBe(0);
    expect(await repo.getRowCount({ sourceId: SOURCE_B })).toBe(1);
  });

  it('getViolationSourceIds returns both sources', async () => {
    await seedBothSources();
    const ids = (await repo.getViolationSourceIds()).sort();
    expect(ids).toEqual([SOURCE_A, SOURCE_B]);
  });

  it('?sources cannot be widened: requesting a source not in sourceIds never returns its rows', async () => {
    await seedBothSources();
    // Only SOURCE_A requested — SOURCE_B rows must never appear regardless of range.
    const rows = await repo.getViolations({ sourceIds: [SOURCE_A], since: 0, until: Date.now() + 10_000_000 });
    expect(rows.some(r => r.sourceId === SOURCE_B)).toBe(false);
  });
});
