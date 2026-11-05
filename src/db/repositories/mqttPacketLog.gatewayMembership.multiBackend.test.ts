/**
 * Cross-dialect coverage for `MqttPacketLogRepository.getNodeGatewayMembership`
 * — the "colour nodes by gateway" read (#6175): which gateway(s) relayed each
 * originating node's packets, over any hop count, read-only over already-
 * ingested `mqtt_packet_log` rows.
 *
 * It is a GROUP BY aggregate with `MAX()` on BIGINT columns and a BIGINT `IN`
 * scope, so dialect compatibility (PostgreSQL BIGINT-string aggregates, MySQL
 * `ONLY_FULL_GROUP_BY`) is the entire risk — exercised on all three backends,
 * same pattern as `mqttPacketLog.rfEvidence.multiBackend.test.ts`.
 *
 * DDL is hand-written per dialect from `src/db/schema/mqttPacketLog.ts` (only
 * the SQLite suite builds its schema from the migration registry). Inserts go
 * through `insertPacket` (pure Drizzle), so no hand-rolled INSERT literal.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MqttPacketLogRepository, type DbMqttPacket } from './mqttPacketLog.js';
import {
  createSqliteBackend,
  createPostgresBackend,
  createMysqlBackend,
  clearTable,
  postgresAvailable,
  mysqlAvailable,
  type TestBackend,
} from './test-utils.js';

const SQLITE_CREATE = `
  CREATE TABLE mqtt_packet_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sourceId TEXT NOT NULL,
    packetId INTEGER,
    fromNode INTEGER,
    fromNodeId TEXT,
    toNode INTEGER,
    toNodeId TEXT,
    channel INTEGER,
    channelId TEXT,
    gatewayId TEXT,
    gatewayNodeNum INTEGER,
    timestamp INTEGER NOT NULL,
    rxTime INTEGER,
    rxSnr REAL,
    rxRssi INTEGER,
    hopLimit INTEGER,
    hopStart INTEGER,
    portnum INTEGER,
    portnumName TEXT,
    encrypted INTEGER NOT NULL DEFAULT 0,
    decryptedBy TEXT,
    ingestOutcome TEXT NOT NULL,
    payloadSize INTEGER,
    payloadPreview TEXT,
    bitfield INTEGER,
    okToMqttViolation INTEGER NOT NULL DEFAULT 0,
    topic TEXT,
    createdAt INTEGER NOT NULL
  )
`;

const POSTGRES_CREATE = `
  DROP TABLE IF EXISTS mqtt_packet_log CASCADE;
  CREATE TABLE mqtt_packet_log (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "sourceId" TEXT NOT NULL,
    "packetId" BIGINT,
    "fromNode" BIGINT,
    "fromNodeId" TEXT,
    "toNode" BIGINT,
    "toNodeId" TEXT,
    channel INTEGER,
    "channelId" TEXT,
    "gatewayId" TEXT,
    "gatewayNodeNum" BIGINT,
    timestamp BIGINT NOT NULL,
    "rxTime" BIGINT,
    "rxSnr" REAL,
    "rxRssi" INTEGER,
    "hopLimit" INTEGER,
    "hopStart" INTEGER,
    portnum INTEGER,
    "portnumName" TEXT,
    encrypted INTEGER NOT NULL DEFAULT 0,
    "decryptedBy" TEXT,
    "ingestOutcome" TEXT NOT NULL,
    "payloadSize" INTEGER,
    "payloadPreview" TEXT,
    bitfield INTEGER,
    "okToMqttViolation" INTEGER NOT NULL DEFAULT 0,
    topic TEXT,
    "createdAt" BIGINT NOT NULL
  )
`;

const MYSQL_CREATE = `
  DROP TABLE IF EXISTS mqtt_packet_log;
  CREATE TABLE mqtt_packet_log (
    id SERIAL PRIMARY KEY,
    sourceId VARCHAR(255) NOT NULL,
    packetId BIGINT,
    fromNode BIGINT,
    fromNodeId VARCHAR(16),
    toNode BIGINT,
    toNodeId VARCHAR(16),
    channel INT,
    channelId VARCHAR(64),
    gatewayId VARCHAR(32),
    gatewayNodeNum BIGINT,
    timestamp BIGINT NOT NULL,
    rxTime BIGINT,
    rxSnr DOUBLE,
    rxRssi INT,
    hopLimit INT,
    hopStart INT,
    portnum INT,
    portnumName VARCHAR(48),
    encrypted INT NOT NULL DEFAULT 0,
    decryptedBy VARCHAR(16),
    ingestOutcome VARCHAR(24) NOT NULL,
    payloadSize INT,
    payloadPreview VARCHAR(256),
    bitfield INT,
    okToMqttViolation INT NOT NULL DEFAULT 0,
    topic VARCHAR(512),
    createdAt BIGINT NOT NULL
  )
`;

const SOURCE = 'src-a';
const NOW = 1_760_000_000_000;

function makePacket(overrides: Partial<DbMqttPacket> = {}): DbMqttPacket {
  return {
    sourceId: SOURCE,
    packetId: 100,
    fromNode: 111,
    fromNodeId: '!0000006f',
    toNode: 0xffffffff,
    toNodeId: '!ffffffff',
    channel: 8,
    channelId: 'LongFast',
    gatewayId: '!aabbccdd',
    gatewayNodeNum: 0xaabbccdd,
    timestamp: NOW,
    rxTime: NOW,
    rxSnr: 5.5,
    rxRssi: -80,
    hopLimit: 3,
    hopStart: 3,
    portnum: 1,
    portnumName: 'TEXT_MESSAGE_APP',
    encrypted: 0,
    decryptedBy: null,
    ingestOutcome: 'ingested',
    payloadSize: 12,
    payloadPreview: 'hello',
    bitfield: null,
    okToMqttViolation: 0,
    topic: null,
    createdAt: NOW,
    ...overrides,
  };
}

/** Behaviours that must hold identically on every dialect. */
function runGatewayMembershipTests(getBackend: () => TestBackend) {
  describe('getNodeGatewayMembership', () => {
    it('dedups to one row per (sourceId, fromNode, gatewayId), counting receptions and taking MAX(timestamp)', async () => {
      const backend = getBackend();
      if (!backend.available) return;
      const repo = new MqttPacketLogRepository(backend.drizzleDb, backend.dbType);
      // Node 300 heard three times by one gateway.
      await repo.insertPacket(makePacket({ fromNode: 300, gatewayId: '!gw000001', gatewayNodeNum: 0x1, timestamp: NOW }));
      await repo.insertPacket(makePacket({ fromNode: 300, gatewayId: '!gw000001', gatewayNodeNum: 0x1, timestamp: NOW + 1000 }));
      await repo.insertPacket(makePacket({ fromNode: 300, gatewayId: '!gw000001', gatewayNodeNum: 0x1, timestamp: NOW + 2000 }));

      const rows = await repo.getNodeGatewayMembership({ sourceIds: [SOURCE], since: 0 });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        sourceId: SOURCE,
        fromNode: 300,
        fromNodeId: '!0000006f',
        gatewayId: '!gw000001',
        gatewayNodeNum: 0x1,
        receptionCount: 3,
        lastHeard: NOW + 2000,
      });
    });

    it('returns one row per gateway for a node heard by several gateways (multi-gateway node)', async () => {
      const backend = getBackend();
      if (!backend.available) return;
      const repo = new MqttPacketLogRepository(backend.drizzleDb, backend.dbType);
      await repo.insertPacket(makePacket({ fromNode: 400, gatewayId: '!gw000001', gatewayNodeNum: 0x1, timestamp: NOW }));
      await repo.insertPacket(makePacket({ fromNode: 400, gatewayId: '!gw000002', gatewayNodeNum: 0x2, timestamp: NOW + 500 }));

      const rows = (await repo.getNodeGatewayMembership({ sourceIds: [SOURCE], since: 0 }))
        .filter((r) => r.fromNode === 400)
        .sort((a, b) => a.gatewayId.localeCompare(b.gatewayId));
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.gatewayId)).toEqual(['!gw000001', '!gw000002']);
      expect(rows.find((r) => r.gatewayId === '!gw000002')?.lastHeard).toBe(NOW + 500);
    });

    it('includes multi-hop receptions (no direct/hop predicate, unlike getDirectReceptionsByGateway)', async () => {
      const backend = getBackend();
      if (!backend.available) return;
      const repo = new MqttPacketLogRepository(backend.drizzleDb, backend.dbType);
      // hopLimit < hopStart (a real multi-hop) and hopStart = 0 (unknown) both count.
      await repo.insertPacket(makePacket({ fromNode: 500, gatewayId: '!gw00000a', gatewayNodeNum: 0xa, hopLimit: 1, hopStart: 3 }));
      await repo.insertPacket(makePacket({ fromNode: 501, gatewayId: '!gw00000b', gatewayNodeNum: 0xb, hopLimit: 0, hopStart: 0 }));

      const rows = await repo.getNodeGatewayMembership({ sourceIds: [SOURCE], since: 0 });
      expect(rows.find((r) => r.fromNode === 500)).toBeDefined();
      expect(rows.find((r) => r.fromNode === 501)).toBeDefined();
    });

    it('honours the since window', async () => {
      const backend = getBackend();
      if (!backend.available) return;
      const repo = new MqttPacketLogRepository(backend.drizzleDb, backend.dbType);
      await repo.insertPacket(makePacket({ fromNode: 600, gatewayId: '!gw00000c', gatewayNodeNum: 0xc, timestamp: NOW }));
      await repo.insertPacket(makePacket({ fromNode: 601, gatewayId: '!gw00000d', gatewayNodeNum: 0xd, timestamp: NOW + 10_000 }));

      const rows = await repo.getNodeGatewayMembership({ sourceIds: [SOURCE], since: NOW + 5_000 });
      expect(rows.find((r) => r.fromNode === 601)).toBeDefined();
      expect(rows.find((r) => r.fromNode === 600)).toBeUndefined();
    });

    it('excludes rows with a null gatewayId or null fromNode', async () => {
      const backend = getBackend();
      if (!backend.available) return;
      const repo = new MqttPacketLogRepository(backend.drizzleDb, backend.dbType);
      await repo.insertPacket(makePacket({ fromNode: 700, gatewayId: null, gatewayNodeNum: null }));
      await repo.insertPacket(makePacket({ fromNode: null, gatewayId: '!gw00000e', gatewayNodeNum: 0xe }));
      await repo.insertPacket(makePacket({ fromNode: 701, gatewayId: '!gw00000f', gatewayNodeNum: 0xf }));

      const rows = await repo.getNodeGatewayMembership({ sourceIds: [SOURCE], since: 0 });
      expect(rows).toHaveLength(1);
      expect(rows[0].fromNode).toBe(701);
    });

    it('is scoped by sourceIds: an excluded source is never returned (per-source isolation)', async () => {
      const backend = getBackend();
      if (!backend.available) return;
      const repo = new MqttPacketLogRepository(backend.drizzleDb, backend.dbType);
      await repo.insertPacket(makePacket({ sourceId: SOURCE, fromNode: 800, gatewayId: '!gw000010', gatewayNodeNum: 0x10 }));
      await repo.insertPacket(makePacket({ sourceId: 'src-other', fromNode: 801, gatewayId: '!gw000011', gatewayNodeNum: 0x11 }));

      const rows = await repo.getNodeGatewayMembership({ sourceIds: [SOURCE], since: 0 });
      expect(rows.find((r) => r.fromNode === 800)).toBeDefined();
      expect(rows.find((r) => r.fromNode === 801)).toBeUndefined();
      expect(rows.every((r) => r.sourceId === SOURCE)).toBe(true);
    });

    it('returns rows for every listed source when more than one is permitted', async () => {
      const backend = getBackend();
      if (!backend.available) return;
      const repo = new MqttPacketLogRepository(backend.drizzleDb, backend.dbType);
      await repo.insertPacket(makePacket({ sourceId: SOURCE, fromNode: 900, gatewayId: '!gw000012', gatewayNodeNum: 0x12 }));
      await repo.insertPacket(makePacket({ sourceId: 'src-b', fromNode: 901, gatewayId: '!gw000013', gatewayNodeNum: 0x13 }));

      const rows = await repo.getNodeGatewayMembership({ sourceIds: [SOURCE, 'src-b'], since: 0 });
      expect(rows.find((r) => r.sourceId === SOURCE && r.fromNode === 900)).toBeDefined();
      expect(rows.find((r) => r.sourceId === 'src-b' && r.fromNode === 901)).toBeDefined();
    });

    it('caps at limit, keeping the highest-receptionCount memberships', async () => {
      const backend = getBackend();
      if (!backend.available) return;
      const repo = new MqttPacketLogRepository(backend.drizzleDb, backend.dbType);
      // Node 1000: 1 reception. Node 1001: 3. Node 1002: 2.
      await repo.insertPacket(makePacket({ fromNode: 1000, gatewayId: '!gw00001a', gatewayNodeNum: 0x1a, timestamp: NOW }));
      for (let i = 0; i < 3; i++) {
        await repo.insertPacket(makePacket({ fromNode: 1001, gatewayId: '!gw00001b', gatewayNodeNum: 0x1b, timestamp: NOW + i }));
      }
      for (let i = 0; i < 2; i++) {
        await repo.insertPacket(makePacket({ fromNode: 1002, gatewayId: '!gw00001c', gatewayNodeNum: 0x1c, timestamp: NOW + i }));
      }

      const rows = await repo.getNodeGatewayMembership({ sourceIds: [SOURCE], since: 0, limit: 2 });
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.fromNode)).toEqual([1001, 1002]);
    });

    it('returns [] immediately for an empty sourceIds array', async () => {
      const backend = getBackend();
      if (!backend.available) return;
      const repo = new MqttPacketLogRepository(backend.drizzleDb, backend.dbType);
      await repo.insertPacket(makePacket({ fromNode: 1100, gatewayId: '!gw00001d', gatewayNodeNum: 0x1d }));

      expect(await repo.getNodeGatewayMembership({ sourceIds: [], since: 0 })).toEqual([]);
    });
  });
}

describe('MqttPacketLogRepository gateway membership - SQLite Backend', () => {
  let backend: TestBackend;
  beforeAll(() => {
    backend = createSqliteBackend(SQLITE_CREATE);
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    await clearTable(backend, 'mqtt_packet_log');
  });
  runGatewayMembershipTests(() => backend);
});

describe.skipIf(!postgresAvailable)('MqttPacketLogRepository gateway membership - PostgreSQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await createPostgresBackend(POSTGRES_CREATE, 'r_mqttpacketlog_gwmembership');
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    if (!backend.available) return;
    await clearTable(backend, 'mqtt_packet_log');
  });
  runGatewayMembershipTests(() => backend);
});

describe.skipIf(!mysqlAvailable)('MqttPacketLogRepository gateway membership - MySQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await createMysqlBackend(MYSQL_CREATE, 'r_mqttpacketlog_gwmembership');
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    if (!backend.available) return;
    await clearTable(backend, 'mqtt_packet_log');
  });
  runGatewayMembershipTests(() => backend);
});
