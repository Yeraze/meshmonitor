/**
 * MQTT `ok_to_mqtt` Violations Repository — correctness tests.
 *
 * `mqtt_ok_to_mqtt_violations` (migration 128) is a durable, retention-immune
 * history of confirmed ok_to_mqtt violations. See
 * MQTT_OK_TO_MQTT_PHASE1_SPEC.md §3.8/§4.8.
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

const SOURCE = 'src-a';

function makeViolation(overrides: Partial<DbMqttOkToMqttViolation> = {}): DbMqttOkToMqttViolation {
  const now = 1_700_000_000_000;
  return {
    sourceId: SOURCE,
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

describe('MqttOkToMqttViolationsRepository', () => {
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

  it('insertViolation throws without a sourceId', async () => {
    await expect(repo.insertViolation(makeViolation({ sourceId: '' }))).rejects.toThrow(/sourceId/);
  });

  it('inserts and round-trips a violation row', async () => {
    await repo.insertViolation(makeViolation());
    expect(await repo.getRowCount({ sourceId: SOURCE })).toBe(1);
  });

  it('duplicate insert (same sourceId/packetId/fromNode/gatewayNodeNum) is a no-op; first timestamp wins', async () => {
    await repo.insertViolation(makeViolation({ timestamp: 1000, createdAt: 1000 }));
    await repo.insertViolation(makeViolation({ timestamp: 2000, createdAt: 2000 }));

    expect(await repo.getRowCount({ sourceId: SOURCE })).toBe(1);
    const rows = await repo.getViolations({ sourceIds: [SOURCE], since: 0, until: Date.now() + 1_000_000 });
    expect(rows).toHaveLength(1);
    expect(rows[0].timestamp).toBe(1000);
  });

  it('a different gatewayNodeNum on an otherwise-identical row is NOT deduped', async () => {
    await repo.insertViolation(makeViolation({ gatewayNodeNum: 1 }));
    await repo.insertViolation(makeViolation({ gatewayNodeNum: 2 }));
    expect(await repo.getRowCount({ sourceId: SOURCE })).toBe(2);
  });

  describe('getGatewaySummary', () => {
    beforeEach(async () => {
      // Gateway 1: two violations, two distinct originators, seen 1000..3000.
      await repo.insertViolation(makeViolation({
        gatewayId: '!gw000001', gatewayNodeNum: 1, fromNode: 10, packetId: 1, timestamp: 1000, createdAt: 1000,
      }));
      await repo.insertViolation(makeViolation({
        gatewayId: '!gw000001', gatewayNodeNum: 1, fromNode: 11, packetId: 2, timestamp: 3000, createdAt: 3000,
      }));
      // Gateway 2: one violation, seen at 2000.
      await repo.insertViolation(makeViolation({
        gatewayId: '!gw000002', gatewayNodeNum: 2, fromNode: 10, packetId: 3, timestamp: 2000, createdAt: 2000,
      }));
    });

    it('counts violations, distinctOriginators, and firstSeen/lastSeen per gateway', async () => {
      const rows = await repo.getGatewaySummary({ sourceIds: [SOURCE], since: 0, until: Date.now() + 1_000_000 });
      expect(rows).toHaveLength(2);

      const gw1 = rows.find(r => r.gatewayId === '!gw000001');
      expect(gw1?.violationCount).toBe(2);
      expect(gw1?.distinctOriginators).toBe(2);
      expect(gw1?.firstSeen).toBe(1000);
      expect(gw1?.lastSeen).toBe(3000);

      const gw2 = rows.find(r => r.gatewayId === '!gw000002');
      expect(gw2?.violationCount).toBe(1);
      expect(gw2?.distinctOriginators).toBe(1);
    });

    it('sorts by violationCount desc by default', async () => {
      const rows = await repo.getGatewaySummary({ sourceIds: [SOURCE], since: 0, until: Date.now() + 1_000_000 });
      expect(rows.map(r => r.gatewayId)).toEqual(['!gw000001', '!gw000002']);
    });

    it('every sort field orders correctly in both directions', async () => {
      const byViolationCountAsc = await repo.getGatewaySummary({
        sourceIds: [SOURCE], since: 0, until: Date.now() + 1_000_000, sort: 'violationCount', dir: 'asc',
      });
      expect(byViolationCountAsc.map(r => r.gatewayId)).toEqual(['!gw000002', '!gw000001']);

      const byLastSeenAsc = await repo.getGatewaySummary({
        sourceIds: [SOURCE], since: 0, until: Date.now() + 1_000_000, sort: 'lastSeen', dir: 'asc',
      });
      expect(byLastSeenAsc.map(r => r.gatewayId)).toEqual(['!gw000002', '!gw000001']);

      const byLastSeenDesc = await repo.getGatewaySummary({
        sourceIds: [SOURCE], since: 0, until: Date.now() + 1_000_000, sort: 'lastSeen', dir: 'desc',
      });
      expect(byLastSeenDesc.map(r => r.gatewayId)).toEqual(['!gw000001', '!gw000002']);

      const byDistinctOriginatorsDesc = await repo.getGatewaySummary({
        sourceIds: [SOURCE], since: 0, until: Date.now() + 1_000_000, sort: 'distinctOriginators', dir: 'desc',
      });
      expect(byDistinctOriginatorsDesc.map(r => r.gatewayId)).toEqual(['!gw000001', '!gw000002']);

      const byGatewayIdAsc = await repo.getGatewaySummary({
        sourceIds: [SOURCE], since: 0, until: Date.now() + 1_000_000, sort: 'gatewayId', dir: 'asc',
      });
      expect(byGatewayIdAsc.map(r => r.gatewayId)).toEqual(['!gw000001', '!gw000002']);

      const byGatewayIdDesc = await repo.getGatewaySummary({
        sourceIds: [SOURCE], since: 0, until: Date.now() + 1_000_000, sort: 'gatewayId', dir: 'desc',
      });
      expect(byGatewayIdDesc.map(r => r.gatewayId)).toEqual(['!gw000002', '!gw000001']);
    });

    it('limit/offset paginate; getGatewaySummaryCount ignores pagination', async () => {
      const page1 = await repo.getGatewaySummary({
        sourceIds: [SOURCE], since: 0, until: Date.now() + 1_000_000, limit: 1, offset: 0,
      });
      expect(page1).toHaveLength(1);
      const page2 = await repo.getGatewaySummary({
        sourceIds: [SOURCE], since: 0, until: Date.now() + 1_000_000, limit: 1, offset: 1,
      });
      expect(page2).toHaveLength(1);
      expect(page1[0].gatewayId).not.toBe(page2[0].gatewayId);

      expect(await repo.getGatewaySummaryCount({ sourceIds: [SOURCE], since: 0, until: Date.now() + 1_000_000 })).toBe(2);
    });

    it('since/until range boundaries are inclusive', async () => {
      const exact = await repo.getGatewaySummary({ sourceIds: [SOURCE], since: 1000, until: 1000 });
      expect(exact).toHaveLength(1);
      expect(exact[0].gatewayId).toBe('!gw000001');
      expect(exact[0].violationCount).toBe(1);
    });

    it('getGatewaySourceIds pivots correctly for a gateway seen on two sources', async () => {
      await repo.insertViolation(makeViolation({
        sourceId: 'src-b', gatewayId: '!gw000001', gatewayNodeNum: 1, fromNode: 20, packetId: 4, timestamp: 1500, createdAt: 1500,
      }));

      const pivot = await repo.getGatewaySourceIds({
        sourceIds: [SOURCE, 'src-b'], since: 0, until: Date.now() + 1_000_000,
      });
      const gw1Sources = pivot.filter(p => p.gatewayId === '!gw000001').map(p => p.sourceId).sort();
      expect(gw1Sources).toEqual(['src-a', 'src-b']);
    });
  });

  describe('getViolations', () => {
    beforeEach(async () => {
      await repo.insertViolation(makeViolation({ gatewayId: '!gw000001', fromNode: 10, packetId: 1, timestamp: 1000, createdAt: 1000 }));
      await repo.insertViolation(makeViolation({ gatewayId: '!gw000002', fromNode: 20, packetId: 2, timestamp: 2000, createdAt: 2000 }));
    });

    it('filters by gatewayId', async () => {
      const rows = await repo.getViolations({
        sourceIds: [SOURCE], since: 0, until: Date.now() + 1_000_000, gatewayId: '!gw000001',
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].gatewayId).toBe('!gw000001');
    });

    it('orders newest-first by default', async () => {
      const rows = await repo.getViolations({ sourceIds: [SOURCE], since: 0, until: Date.now() + 1_000_000 });
      expect(rows.map(r => r.packetId)).toEqual([2, 1]);
    });
  });

  it('empty sourceIds short-circuits every cross-source method to [] / 0 with no query executed', async () => {
    await repo.insertViolation(makeViolation());
    const q = { sourceIds: [] as string[], since: 0, until: Date.now() + 1_000_000 };
    expect(await repo.getGatewaySummary(q)).toEqual([]);
    expect(await repo.getGatewaySummaryCount(q)).toBe(0);
    expect(await repo.getGatewaySourceIds(q)).toEqual([]);
    expect(await repo.getViolations(q)).toEqual([]);
    expect(await repo.getViolationCount(q)).toBe(0);
  });
});
