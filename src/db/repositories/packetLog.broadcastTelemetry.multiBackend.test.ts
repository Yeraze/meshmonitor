/**
 * Cross-dialect coverage for `PacketLogRepository.getBroadcastTelemetryTimestamps`
 * — Mesh Issues A5's telemetry-cadence clause (#4964, post-epic follow-up).
 * Same rationale as `packetLog.hopArrival.multiBackend.test.ts`: a two-level
 * aggregate (inner `GROUP BY (from_node, packet_id)` dedup subquery, taking
 * MIN(timestamp), joined into an outer ordered select) is dialect-compatibility
 * risk end to end, so it is exercised on all three backends.
 *
 * DDL below is hand-written per dialect from `src/db/schema/packets.ts`, same
 * convention as the hop-arrival sibling suite. Row insertion goes through
 * `PacketLogRepository.insertPacketLog` (pure Drizzle, no raw SQL).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PacketLogRepository } from './packetLog.js';
import { DbPacketLog } from '../types.js';
import { PortNum } from '../../server/constants/meshtastic.js';
import { BROADCAST_ADDR } from '../../utils/tracerouteSegments.js';
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
    to_node: BROADCAST_ADDR,
    portnum: PortNum.TELEMETRY_APP,
    portnum_name: 'TELEMETRY_APP',
    encrypted: false,
    direction: 'rx' as const,
    ...overrides,
  };
}

/** Behaviours that must hold identically on every dialect. */
function runBroadcastTelemetryTests(getBackend: () => TestBackend) {
  it('dedups by (from_node, packet_id), taking the EARLIEST observed timestamp', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new PacketLogRepository(backend.drizzleDb, backend.dbType);
    // Same originating packet logged twice (retransmission/relay copy) —
    // must count as one broadcast, at the earlier timestamp.
    await repo.insertPacketLog(makePacket({ packet_id: 1000, from_node: 1000, timestamp: NOW + 500 }) as any, SOURCE);
    await repo.insertPacketLog(makePacket({ packet_id: 1000, from_node: 1000, timestamp: NOW }) as any, SOURCE);

    const rows = await repo.getBroadcastTelemetryTimestamps({ nodeNums: [1000], since: 0 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ nodeNum: 1000, timestamp: NOW });
  });

  it('excludes rows whose portnum is not TELEMETRY_APP', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new PacketLogRepository(backend.drizzleDb, backend.dbType);
    await repo.insertPacketLog(
      makePacket({ packet_id: 1001, from_node: 1001, portnum: PortNum.POSITION_APP }) as any,
      SOURCE,
    );

    const rows = await repo.getBroadcastTelemetryTimestamps({ nodeNums: [1001], since: 0 });
    expect(rows).toEqual([]);
  });

  it('excludes rows whose to_node is not BROADCAST_ADDR (a directed reply, not a broadcast)', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new PacketLogRepository(backend.drizzleDb, backend.dbType);
    await repo.insertPacketLog(makePacket({ packet_id: 1002, from_node: 1002, to_node: 42 }) as any, SOURCE);

    const rows = await repo.getBroadcastTelemetryTimestamps({ nodeNums: [1002], since: 0 });
    expect(rows).toEqual([]);
  });

  it('excludes tx (non-arrival) rows via direction = rx', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new PacketLogRepository(backend.drizzleDb, backend.dbType);
    await repo.insertPacketLog(makePacket({ packet_id: 1003, from_node: 1003, direction: 'tx' }) as any, SOURCE);

    const rows = await repo.getBroadcastTelemetryTimestamps({ nodeNums: [1003], since: 0 });
    expect(rows).toEqual([]);
  });

  it('respects since — excludes rows before the cutoff', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new PacketLogRepository(backend.drizzleDb, backend.dbType);
    await repo.insertPacketLog(makePacket({ packet_id: 1004, from_node: 1004, timestamp: NOW - 10_000 }) as any, SOURCE);
    await repo.insertPacketLog(makePacket({ packet_id: 1005, from_node: 1004, timestamp: NOW }) as any, SOURCE);

    const rows = await repo.getBroadcastTelemetryTimestamps({ nodeNums: [1004], since: NOW - 1000 });
    expect(rows).toHaveLength(1);
    expect(rows[0].timestamp).toBe(NOW);
  });

  it('filters by nodeNums (from_node), excluding nodes not in the list', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new PacketLogRepository(backend.drizzleDb, backend.dbType);
    await repo.insertPacketLog(makePacket({ packet_id: 1006, from_node: 1006 }) as any, SOURCE);
    await repo.insertPacketLog(makePacket({ packet_id: 1007, from_node: 1007 }) as any, SOURCE);

    const rows = await repo.getBroadcastTelemetryTimestamps({ nodeNums: [1006], since: 0 });
    expect(rows.map((r) => r.nodeNum)).toEqual([1006]);
  });

  it('returns [] immediately for an empty nodeNums array', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new PacketLogRepository(backend.drizzleDb, backend.dbType);
    await repo.insertPacketLog(makePacket({ packet_id: 1008, from_node: 1008 }) as any, SOURCE);

    expect(await repo.getBroadcastTelemetryTimestamps({ nodeNums: [], since: 0 })).toEqual([]);
  });

  it('returns timestamps ascending within each node\'s own subsequence', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new PacketLogRepository(backend.drizzleDb, backend.dbType);
    await repo.insertPacketLog(makePacket({ packet_id: 1100, from_node: 1100, timestamp: NOW + 20_000 }) as any, SOURCE);
    await repo.insertPacketLog(makePacket({ packet_id: 1101, from_node: 1100, timestamp: NOW }) as any, SOURCE);
    await repo.insertPacketLog(makePacket({ packet_id: 1102, from_node: 1100, timestamp: NOW + 10_000 }) as any, SOURCE);

    const rows = await repo.getBroadcastTelemetryTimestamps({ nodeNums: [1100], since: 0 });
    expect(rows.map((r) => r.timestamp)).toEqual([NOW, NOW + 10_000, NOW + 20_000]);
  });

  it('caps at limit', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new PacketLogRepository(backend.drizzleDb, backend.dbType);
    for (let i = 0; i < 5; i++) {
      await repo.insertPacketLog(
        makePacket({ packet_id: 1200 + i, from_node: 1200, timestamp: NOW + i * 1000 }) as any,
        SOURCE,
      );
    }

    const rows = await repo.getBroadcastTelemetryTimestamps({ nodeNums: [1200], since: 0, limit: 2 });
    expect(rows).toHaveLength(2);
  });
}

describe('PacketLogRepository.getBroadcastTelemetryTimestamps - SQLite Backend', () => {
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
  runBroadcastTelemetryTests(() => backend);
});

describe.skipIf(!postgresAvailable)('PacketLogRepository.getBroadcastTelemetryTimestamps - PostgreSQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await createPostgresBackend(POSTGRES_CREATE, 'r_packetlog_broadcast_tel');
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    if (!backend.available) return;
    await clearTable(backend, 'packet_log');
  });
  runBroadcastTelemetryTests(() => backend);
});

describe.skipIf(!mysqlAvailable)('PacketLogRepository.getBroadcastTelemetryTimestamps - MySQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await createMysqlBackend(MYSQL_CREATE, 'r_packetlog_broadcast_tel');
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    if (!backend.available) return;
    await clearTable(backend, 'packet_log');
  });
  runBroadcastTelemetryTests(() => backend);
});
