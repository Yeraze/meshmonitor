/**
 * Cross-dialect coverage for the Mesh Issues Phase 2 RF-evidence aggregates
 * on `mqtt_packet_log`:
 *
 *  - `MqttPacketLogRepository.getDirectReceptionsByGateway` (evidence class
 *    3 — a gateway hearing a node at zero consumed hops, §3.1 of
 *    docs/internal/dev-notes/MESH_ISSUES_P2_SPEC.md).
 *  - `MqttPacketLogRepository.getHopArrivalCountsSince` (B6 "hop horizon",
 *    §3.2, MQTT fallback path).
 *
 * Both are two-table-shape aggregates (GROUP BY + a subquery), so — same
 * rationale as `analysis.hopCounts.multiBackend.test.ts` — dialect
 * compatibility is the entire risk and is exercised on all three backends.
 *
 * The DDL below is hand-written per dialect from `src/db/schema/mqttPacketLog.ts`
 * (convention per `newsCache.test.ts` / `analysis.hopCounts.multiBackend.test.ts`:
 * only the SQLite suite builds its schema from the migration registry). Row
 * insertion goes through `MqttPacketLogRepository.insertPacket`, which is
 * pure Drizzle (no raw SQL), so no hand-rolled INSERT literal is needed.
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

/**
 * Behaviours that must hold identically on every dialect.
 */
function runRfEvidenceTests(getBackend: () => TestBackend) {
  describe('getDirectReceptionsByGateway', () => {
    it('accepts hopLimit === hopStart > 0 as direct', async () => {
      const backend = getBackend();
      if (!backend.available) return;
      const repo = new MqttPacketLogRepository(backend.drizzleDb, backend.dbType);
      await repo.insertPacket(makePacket({ gatewayNodeNum: 0x1000, fromNode: 200, hopLimit: 3, hopStart: 3 }));

      const rows = await repo.getDirectReceptionsByGateway({ sourceIds: [SOURCE], since: 0 });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ gatewayNodeNum: 0x1000, fromNode: 200, sourceId: SOURCE, receptionCount: 1 });
    });

    it('rejects hopStart = 0 (unknown hop budget, never direct)', async () => {
      const backend = getBackend();
      if (!backend.available) return;
      const repo = new MqttPacketLogRepository(backend.drizzleDb, backend.dbType);
      await repo.insertPacket(makePacket({ gatewayNodeNum: 0x1001, fromNode: 201, hopLimit: 0, hopStart: 0 }));

      const rows = await repo.getDirectReceptionsByGateway({ sourceIds: [SOURCE], since: 0 });
      expect(rows.find((r) => r.fromNode === 201)).toBeUndefined();
    });

    it('rejects hopLimit < hopStart (a real multi-hop reception)', async () => {
      const backend = getBackend();
      if (!backend.available) return;
      const repo = new MqttPacketLogRepository(backend.drizzleDb, backend.dbType);
      await repo.insertPacket(makePacket({ gatewayNodeNum: 0x1002, fromNode: 202, hopLimit: 1, hopStart: 3 }));

      const rows = await repo.getDirectReceptionsByGateway({ sourceIds: [SOURCE], since: 0 });
      expect(rows.find((r) => r.fromNode === 202)).toBeUndefined();
    });

    it('rejects gatewayNodeNum === fromNode (self-published, not a relay observation)', async () => {
      const backend = getBackend();
      if (!backend.available) return;
      const repo = new MqttPacketLogRepository(backend.drizzleDb, backend.dbType);
      await repo.insertPacket(makePacket({ gatewayNodeNum: 203, fromNode: 203, hopLimit: 3, hopStart: 3 }));

      const rows = await repo.getDirectReceptionsByGateway({ sourceIds: [SOURCE], since: 0 });
      expect(rows.find((r) => r.fromNode === 203)).toBeUndefined();
    });

    it('groups by (sourceId, gatewayNodeNum, fromNode) and computes COUNT/AVG(rxSnr)/MIN/MAX(timestamp) correctly', async () => {
      const backend = getBackend();
      if (!backend.available) return;
      const repo = new MqttPacketLogRepository(backend.drizzleDb, backend.dbType);
      await repo.insertPacket(makePacket({
        gatewayNodeNum: 0x2000, fromNode: 300, hopLimit: 3, hopStart: 3, rxSnr: 4.0, timestamp: NOW,
      }));
      await repo.insertPacket(makePacket({
        gatewayNodeNum: 0x2000, fromNode: 300, hopLimit: 3, hopStart: 3, rxSnr: 8.0, timestamp: NOW + 1000,
      }));
      await repo.insertPacket(makePacket({
        gatewayNodeNum: 0x2000, fromNode: 300, hopLimit: 3, hopStart: 3, rxSnr: 6.0, timestamp: NOW + 2000,
      }));

      const rows = await repo.getDirectReceptionsByGateway({ sourceIds: [SOURCE], since: 0 });
      const row = rows.find((r) => r.fromNode === 300);
      expect(row).toBeDefined();
      expect(row?.receptionCount).toBe(3);
      expect(row?.meanRxSnr).toBeCloseTo(6.0, 5);
      expect(row?.firstSeen).toBe(NOW);
      expect(row?.lastSeen).toBe(NOW + 2000);
    });

    it('caps at limit, keeping the highest-receptionCount rows (strongest evidence survives)', async () => {
      const backend = getBackend();
      if (!backend.available) return;
      const repo = new MqttPacketLogRepository(backend.drizzleDb, backend.dbType);
      // Node 400: 1 reception. Node 401: 3 receptions. Node 402: 2 receptions.
      await repo.insertPacket(makePacket({ gatewayNodeNum: 0x3000, fromNode: 400, hopLimit: 3, hopStart: 3, timestamp: NOW }));
      for (let i = 0; i < 3; i++) {
        await repo.insertPacket(makePacket({ gatewayNodeNum: 0x3000, fromNode: 401, hopLimit: 3, hopStart: 3, timestamp: NOW + i }));
      }
      for (let i = 0; i < 2; i++) {
        await repo.insertPacket(makePacket({ gatewayNodeNum: 0x3000, fromNode: 402, hopLimit: 3, hopStart: 3, timestamp: NOW + i }));
      }

      const rows = await repo.getDirectReceptionsByGateway({ sourceIds: [SOURCE], since: 0, limit: 2 });
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.fromNode)).toEqual([401, 402]);
    });

    it('is scoped by sourceIds: a row on an unlisted source never appears', async () => {
      const backend = getBackend();
      if (!backend.available) return;
      const repo = new MqttPacketLogRepository(backend.drizzleDb, backend.dbType);
      await repo.insertPacket(makePacket({ sourceId: SOURCE, gatewayNodeNum: 0x4000, fromNode: 500, hopLimit: 3, hopStart: 3 }));
      await repo.insertPacket(makePacket({ sourceId: 'src-other', gatewayNodeNum: 0x4001, fromNode: 501, hopLimit: 3, hopStart: 3 }));

      const rows = await repo.getDirectReceptionsByGateway({ sourceIds: [SOURCE], since: 0 });
      expect(rows.find((r) => r.fromNode === 501)).toBeUndefined();
      expect(rows.find((r) => r.fromNode === 500)).toBeDefined();
    });

    it('returns [] immediately for an empty sourceIds array', async () => {
      const backend = getBackend();
      if (!backend.available) return;
      const repo = new MqttPacketLogRepository(backend.drizzleDb, backend.dbType);
      await repo.insertPacket(makePacket({ gatewayNodeNum: 0x5000, fromNode: 600, hopLimit: 3, hopStart: 3 }));

      expect(await repo.getDirectReceptionsByGateway({ sourceIds: [], since: 0 })).toEqual([]);
    });
  });

  describe('getHopArrivalCountsSince (MQTT)', () => {
    it('dedups by (packetId, fromNode) taking MAX(hopLimit): seen at hopLimit 0 by one gateway and 1 by another is NOT exhausted', async () => {
      const backend = getBackend();
      if (!backend.available) return;
      const repo = new MqttPacketLogRepository(backend.drizzleDb, backend.dbType);
      // Same originating packet (packetId=700, fromNode=700), two gateway copies.
      await repo.insertPacket(makePacket({
        packetId: 700, fromNode: 700, gatewayId: '!gw000001', gatewayNodeNum: 0x111, hopLimit: 0, hopStart: 3, timestamp: NOW,
      }));
      await repo.insertPacket(makePacket({
        packetId: 700, fromNode: 700, gatewayId: '!gw000002', gatewayNodeNum: 0x222, hopLimit: 1, hopStart: 3, timestamp: NOW + 1,
      }));

      const rows = await repo.getHopArrivalCountsSince({ since: 0, sourceIds: [SOURCE] });
      const row = rows.find((r) => r.nodeNum === 700);
      expect(row).toBeDefined();
      expect(row?.totalPackets).toBe(1);
      expect(row?.exhaustedPackets).toBe(0);
    });

    it('counts a packet exhausted only when its best-observed hopLimit is 0', async () => {
      const backend = getBackend();
      if (!backend.available) return;
      const repo = new MqttPacketLogRepository(backend.drizzleDb, backend.dbType);
      await repo.insertPacket(makePacket({ packetId: 701, fromNode: 701, hopLimit: 0, hopStart: 3, timestamp: NOW }));

      const rows = await repo.getHopArrivalCountsSince({ since: 0, sourceIds: [SOURCE] });
      const row = rows.find((r) => r.nodeNum === 701);
      expect(row).toBeDefined();
      expect(row?.totalPackets).toBe(1);
      expect(row?.exhaustedPackets).toBe(1);
    });

    it('excludes rows with hopStart = 0 (unknown hop budget)', async () => {
      const backend = getBackend();
      if (!backend.available) return;
      const repo = new MqttPacketLogRepository(backend.drizzleDb, backend.dbType);
      await repo.insertPacket(makePacket({ packetId: 702, fromNode: 702, hopLimit: 0, hopStart: 0, timestamp: NOW }));

      const rows = await repo.getHopArrivalCountsSince({ since: 0, sourceIds: [SOURCE] });
      expect(rows.find((r) => r.nodeNum === 702)).toBeUndefined();
    });

    it('is scoped by sourceIds', async () => {
      const backend = getBackend();
      if (!backend.available) return;
      const repo = new MqttPacketLogRepository(backend.drizzleDb, backend.dbType);
      await repo.insertPacket(makePacket({ sourceId: SOURCE, packetId: 703, fromNode: 703, hopLimit: 0, hopStart: 3 }));
      await repo.insertPacket(makePacket({ sourceId: 'src-other', packetId: 704, fromNode: 704, hopLimit: 0, hopStart: 3 }));

      const rows = await repo.getHopArrivalCountsSince({ since: 0, sourceIds: [SOURCE] });
      expect(rows.find((r) => r.nodeNum === 704)).toBeUndefined();
      expect(rows.find((r) => r.nodeNum === 703)).toBeDefined();
    });

    it('returns [] immediately for an empty sourceIds array', async () => {
      const backend = getBackend();
      if (!backend.available) return;
      const repo = new MqttPacketLogRepository(backend.drizzleDb, backend.dbType);
      await repo.insertPacket(makePacket({ packetId: 705, fromNode: 705, hopLimit: 0, hopStart: 3 }));

      expect(await repo.getHopArrivalCountsSince({ since: 0, sourceIds: [] })).toEqual([]);
    });
  });
}

describe('MqttPacketLogRepository RF evidence aggregates - SQLite Backend', () => {
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
  runRfEvidenceTests(() => backend);
});

describe.skipIf(!postgresAvailable)('MqttPacketLogRepository RF evidence aggregates - PostgreSQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await createPostgresBackend(POSTGRES_CREATE);
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    if (!backend.available) return;
    await clearTable(backend, 'mqtt_packet_log');
  });
  runRfEvidenceTests(() => backend);
});

describe.skipIf(!mysqlAvailable)('MqttPacketLogRepository RF evidence aggregates - MySQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await createMysqlBackend(MYSQL_CREATE);
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    if (!backend.available) return;
    await clearTable(backend, 'mqtt_packet_log');
  });
  runRfEvidenceTests(() => backend);
});
