/**
 * Cross-dialect coverage for `PacketLogRepository.getHopArrivalCountsSince`
 * (Mesh Issues B6 "hop horizon" evidence, §3.2 of
 * docs/internal/dev-notes/MESH_ISSUES_P2_SPEC.md). The query is a two-level
 * aggregate — an inner `GROUP BY (from_node, packet_id)` dedup subquery
 * joined into an outer `GROUP BY nodeNum` — so, same rationale as
 * `analysis.hopCounts.multiBackend.test.ts`, dialect compatibility is the
 * entire risk and is exercised on all three backends.
 *
 * The DDL below is hand-written per dialect from `src/db/schema/packets.ts`
 * (convention per `analysis.hopCounts.multiBackend.test.ts`: only the
 * SQLite suite builds its schema from the migration registry). Row
 * insertion goes through `PacketLogRepository.insertPacketLog`, which is
 * pure Drizzle (no raw SQL), so no hand-rolled INSERT literal is needed.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PacketLogRepository } from './packetLog.js';
import { DbPacketLog } from '../types.js';
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
  CREATE TABLE packet_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    packet_id INTEGER,
    timestamp INTEGER NOT NULL,
    from_node INTEGER NOT NULL,
    from_node_id TEXT,
    to_node INTEGER,
    to_node_id TEXT,
    channel INTEGER,
    portnum INTEGER NOT NULL,
    portnum_name TEXT,
    encrypted INTEGER NOT NULL,
    snr REAL,
    rssi REAL,
    hop_limit INTEGER,
    hop_start INTEGER,
    relay_node INTEGER,
    payload_size INTEGER,
    want_ack INTEGER,
    priority INTEGER,
    payload_preview TEXT,
    metadata TEXT,
    direction TEXT,
    created_at INTEGER,
    decrypted_by TEXT,
    decrypted_channel_id INTEGER,
    transport_mechanism INTEGER,
    xeddsa_signed INTEGER,
    sourceId TEXT,
    spoof_suspected INTEGER
  )
`;

const POSTGRES_CREATE = `
  DROP TABLE IF EXISTS packet_log CASCADE;
  CREATE TABLE packet_log (
    id SERIAL PRIMARY KEY,
    packet_id BIGINT,
    timestamp BIGINT NOT NULL,
    from_node BIGINT NOT NULL,
    from_node_id TEXT,
    to_node BIGINT,
    to_node_id TEXT,
    channel INTEGER,
    portnum INTEGER NOT NULL,
    portnum_name TEXT,
    encrypted BOOLEAN NOT NULL,
    snr REAL,
    rssi REAL,
    hop_limit INTEGER,
    hop_start INTEGER,
    relay_node BIGINT,
    payload_size INTEGER,
    want_ack BOOLEAN,
    priority INTEGER,
    payload_preview TEXT,
    metadata TEXT,
    direction TEXT,
    created_at BIGINT,
    decrypted_by TEXT,
    decrypted_channel_id INTEGER,
    transport_mechanism INTEGER,
    xeddsa_signed BOOLEAN,
    "sourceId" TEXT,
    spoof_suspected BOOLEAN
  )
`;

const MYSQL_CREATE = `
  DROP TABLE IF EXISTS packet_log;
  CREATE TABLE packet_log (
    id SERIAL PRIMARY KEY,
    packet_id BIGINT,
    timestamp BIGINT NOT NULL,
    from_node BIGINT NOT NULL,
    from_node_id VARCHAR(32),
    to_node BIGINT,
    to_node_id VARCHAR(32),
    channel INT,
    portnum INT NOT NULL,
    portnum_name VARCHAR(64),
    encrypted BOOLEAN NOT NULL,
    snr DOUBLE,
    rssi DOUBLE,
    hop_limit INT,
    hop_start INT,
    relay_node BIGINT,
    payload_size INT,
    want_ack BOOLEAN,
    priority INT,
    payload_preview TEXT,
    metadata TEXT,
    direction VARCHAR(8),
    created_at BIGINT,
    decrypted_by VARCHAR(16),
    decrypted_channel_id INT,
    transport_mechanism INT,
    xeddsa_signed BOOLEAN,
    sourceId VARCHAR(36),
    spoof_suspected BOOLEAN
  )
`;

const SOURCE = 'src-a';
const NOW = 1_760_000_000_000;

function makePacket(overrides: Partial<Omit<DbPacketLog, 'id' | 'created_at'>> = {}) {
  return {
    packet_id: 900,
    timestamp: NOW,
    from_node: 900,
    portnum: 1,
    portnum_name: 'TEXT_MESSAGE_APP',
    encrypted: false,
    direction: 'rx' as const,
    hop_limit: 3,
    hop_start: 3,
    ...overrides,
  };
}

/**
 * Behaviours that must hold identically on every dialect.
 */
function runHopArrivalTests(getBackend: () => TestBackend) {
  it('dedups by (from_node, packet_id) taking MAX(hop_limit): seen at hopLimit 0 and 2 (two vantages) is NOT exhausted', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new PacketLogRepository(backend.drizzleDb, backend.dbType);
    // Two rows for the same (from_node, packet_id) — the repo doesn't
    // de-dup on insert (this table is one-row-per-capture), so this
    // simulates the same originating packet logged at two different
    // hop-limit readings.
    await repo.insertPacketLog(makePacket({ packet_id: 1000, from_node: 1000, hop_limit: 0, hop_start: 3, timestamp: NOW }) as any, SOURCE);
    await repo.insertPacketLog(makePacket({ packet_id: 1000, from_node: 1000, hop_limit: 2, hop_start: 3, timestamp: NOW + 1 }) as any, SOURCE);

    const rows = await repo.getHopArrivalCountsSince({ since: 0, sourceIds: [SOURCE] });
    const row = rows.find((r) => r.nodeNum === 1000);
    expect(row).toBeDefined();
    expect(row?.totalPackets).toBe(1);
    expect(row?.exhaustedPackets).toBe(0);
  });

  it('counts a packet exhausted only when its best-observed hop_limit is 0', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new PacketLogRepository(backend.drizzleDb, backend.dbType);
    await repo.insertPacketLog(makePacket({ packet_id: 1001, from_node: 1001, hop_limit: 0, hop_start: 3 }) as any, SOURCE);

    const rows = await repo.getHopArrivalCountsSince({ since: 0, sourceIds: [SOURCE] });
    const row = rows.find((r) => r.nodeNum === 1001);
    expect(row).toBeDefined();
    expect(row?.totalPackets).toBe(1);
    expect(row?.exhaustedPackets).toBe(1);
  });

  it('excludes rows with hop_start = 0 (unknown hop budget, never a genuine reading)', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new PacketLogRepository(backend.drizzleDb, backend.dbType);
    await repo.insertPacketLog(makePacket({ packet_id: 1002, from_node: 1002, hop_limit: 0, hop_start: 0 }) as any, SOURCE);

    const rows = await repo.getHopArrivalCountsSince({ since: 0, sourceIds: [SOURCE] });
    expect(rows.find((r) => r.nodeNum === 1002)).toBeUndefined();
  });

  it('excludes tx (non-arrival) rows via direction = rx', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new PacketLogRepository(backend.drizzleDb, backend.dbType);
    await repo.insertPacketLog(makePacket({ packet_id: 1003, from_node: 1003, hop_limit: 0, hop_start: 3, direction: 'tx' }) as any, SOURCE);

    const rows = await repo.getHopArrivalCountsSince({ since: 0, sourceIds: [SOURCE] });
    expect(rows.find((r) => r.nodeNum === 1003)).toBeUndefined();
  });

  it('is scoped by sourceIds when provided', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new PacketLogRepository(backend.drizzleDb, backend.dbType);
    await repo.insertPacketLog(makePacket({ packet_id: 1004, from_node: 1004, hop_limit: 0, hop_start: 3 }) as any, SOURCE);
    await repo.insertPacketLog(makePacket({ packet_id: 1005, from_node: 1005, hop_limit: 0, hop_start: 3 }) as any, 'src-other');

    const rows = await repo.getHopArrivalCountsSince({ since: 0, sourceIds: [SOURCE] });
    expect(rows.find((r) => r.nodeNum === 1005)).toBeUndefined();
    expect(rows.find((r) => r.nodeNum === 1004)).toBeDefined();
  });

  it('runs unscoped (returns rows from every source) when sourceIds is omitted', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new PacketLogRepository(backend.drizzleDb, backend.dbType);
    await repo.insertPacketLog(makePacket({ packet_id: 1006, from_node: 1006, hop_limit: 0, hop_start: 3 }) as any, SOURCE);
    await repo.insertPacketLog(makePacket({ packet_id: 1007, from_node: 1007, hop_limit: 0, hop_start: 3 }) as any, 'src-other');

    const rows = await repo.getHopArrivalCountsSince({ since: 0 });
    expect(rows.find((r) => r.nodeNum === 1006)).toBeDefined();
    expect(rows.find((r) => r.nodeNum === 1007)).toBeDefined();
  });

  it('returns [] immediately for an explicitly empty sourceIds array', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new PacketLogRepository(backend.drizzleDb, backend.dbType);
    await repo.insertPacketLog(makePacket({ packet_id: 1008, from_node: 1008, hop_limit: 0, hop_start: 3 }) as any, SOURCE);

    expect(await repo.getHopArrivalCountsSince({ since: 0, sourceIds: [] })).toEqual([]);
  });

  it('caps at limit, keeping the highest-totalPackets nodes (strongest evidence survives)', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new PacketLogRepository(backend.drizzleDb, backend.dbType);
    // Node 1100: 1 packet. Node 1101: 3 packets. Node 1102: 2 packets.
    await repo.insertPacketLog(makePacket({ packet_id: 2000, from_node: 1100, hop_limit: 0, hop_start: 3, timestamp: NOW }) as any, SOURCE);
    for (let i = 0; i < 3; i++) {
      await repo.insertPacketLog(makePacket({ packet_id: 2001 + i, from_node: 1101, hop_limit: 0, hop_start: 3, timestamp: NOW + i }) as any, SOURCE);
    }
    for (let i = 0; i < 2; i++) {
      await repo.insertPacketLog(makePacket({ packet_id: 2010 + i, from_node: 1102, hop_limit: 0, hop_start: 3, timestamp: NOW + i }) as any, SOURCE);
    }

    const rows = await repo.getHopArrivalCountsSince({ since: 0, sourceIds: [SOURCE], limit: 2 });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.nodeNum)).toEqual([1101, 1102]);
  });
}

describe('PacketLogRepository.getHopArrivalCountsSince - SQLite Backend', () => {
  let backend: TestBackend;
  beforeAll(() => {
    backend = createSqliteBackend(SQLITE_CREATE);
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    await clearTable(backend, 'packet_log');
  });
  runHopArrivalTests(() => backend);
});

describe.skipIf(!postgresAvailable)('PacketLogRepository.getHopArrivalCountsSince - PostgreSQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await createPostgresBackend(POSTGRES_CREATE);
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    if (!backend.available) return;
    await clearTable(backend, 'packet_log');
  });
  runHopArrivalTests(() => backend);
});

describe.skipIf(!mysqlAvailable)('PacketLogRepository.getHopArrivalCountsSince - MySQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await createMysqlBackend(MYSQL_CREATE);
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    if (!backend.available) return;
    await clearTable(backend, 'packet_log');
  });
  runHopArrivalTests(() => backend);
});
