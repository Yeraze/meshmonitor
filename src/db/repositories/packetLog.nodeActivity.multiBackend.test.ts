/**
 * Cross-dialect coverage for `PacketLogRepository.getNodeActivity` and
 * `getOldestPacketTimestamp` — the Live Mesh Activity widget (#5557).
 *
 * DDL is hand-written per dialect from `src/db/schema/packets.ts` (same
 * convention as `packetLog.transportClass.multiBackend.test.ts`), plus a
 * minimal `nodes` table for the short/long name scalar subqueries.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { PacketLogRepository } from './packetLog.js';
import { DbPacketLog } from '../types.js';
import { PortNum, TransportMechanism } from '../../server/constants/meshtastic.js';
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
  );
  CREATE TABLE nodes (
    nodeNum INTEGER NOT NULL,
    sourceId TEXT NOT NULL,
    longName TEXT,
    shortName TEXT,
    PRIMARY KEY (nodeNum, sourceId)
  )
`;

const POSTGRES_CREATE = `
  DROP TABLE IF EXISTS packet_log CASCADE;
  DROP TABLE IF EXISTS nodes CASCADE;
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
  );
  CREATE TABLE nodes (
    "nodeNum" BIGINT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "longName" TEXT,
    "shortName" TEXT,
    PRIMARY KEY ("nodeNum", "sourceId")
  )
`;

const MYSQL_CREATE = `
  DROP TABLE IF EXISTS packet_log;
  DROP TABLE IF EXISTS nodes;
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
  );
  CREATE TABLE nodes (
    nodeNum BIGINT NOT NULL,
    sourceId VARCHAR(36) NOT NULL,
    longName VARCHAR(255),
    shortName VARCHAR(32),
    PRIMARY KEY (nodeNum, sourceId)
  )
`;

const SOURCE = 'src-a';
const OTHER = 'src-b';
const NOW = 1_760_000_000_000;
const SINCE = NOW - 10 * 60_000;
const LOCAL = 0x11111111;
const BIG = 0xfedcba98; // unsigned 32-bit, above signed INTEGER's ceiling

let pid = 1;
function pkt(over: Partial<DbPacketLog> & { from_node: number }): Omit<DbPacketLog, 'id' | 'created_at'> {
  return {
    packet_id: pid++,
    timestamp: NOW,
    from_node_id: `!${over.from_node.toString(16).padStart(8, '0')}`,
    to_node: 4294967295,
    channel: 0,
    portnum: PortNum.POSITION_APP,
    portnum_name: 'POSITION_APP',
    encrypted: false,
    direction: 'rx',
    transport_mechanism: TransportMechanism.LORA,
    ...over,
  } as Omit<DbPacketLog, 'id' | 'created_at'>;
}

async function insertNode(backend: TestBackend, nodeNum: number, sourceId: string, shortName: string, longName: string) {
  const db = backend.drizzleDb as any;
  const q = backend.dbType === 'postgres'
    ? sql`INSERT INTO nodes ("nodeNum", "sourceId", "longName", "shortName") VALUES (${nodeNum}, ${sourceId}, ${longName}, ${shortName})`
    : sql`INSERT INTO nodes (nodeNum, sourceId, longName, shortName) VALUES (${nodeNum}, ${sourceId}, ${longName}, ${shortName})`;
  if (backend.dbType === 'sqlite') db.run(q);
  else await db.execute(q);
}

function runNodeActivityTests(getBackend: () => TestBackend) {
  it('aggregates packets, extra receptions, SNR and hops per remote node, newest first', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new PacketLogRepository(backend.drizzleDb, backend.dbType);

    // BIG: packet 900 heard twice (one extra reception), then packet 901.
    await repo.insertPacketLog(pkt({ from_node: BIG, packet_id: 900, timestamp: NOW - 3000, snr: 2, hop_start: 3, hop_limit: 1 }), SOURCE);
    await repo.insertPacketLog(pkt({ from_node: BIG, packet_id: 900, timestamp: NOW - 2000, snr: 4, hop_start: 3, hop_limit: 0, relay_node: 5 }), SOURCE);
    await repo.insertPacketLog(pkt({ from_node: BIG, packet_id: 901, timestamp: NOW - 1000, snr: 9, hop_start: 0, hop_limit: 0 }), SOURCE);
    // 0x222: one older packet with no SNR and unknown hops.
    await repo.insertPacketLog(pkt({ from_node: 0x222, timestamp: NOW - 5000 }), SOURCE);
    await insertNode(backend, BIG, SOURCE, 'BIG', 'Big Node');
    await insertNode(backend, BIG, OTHER, 'XXX', 'Wrong Source');

    const rows = await repo.getNodeActivity({ sourceId: SOURCE, since: SINCE });
    expect(rows.map((r) => r.nodeNum)).toEqual([BIG, 0x222]);

    const big = rows[0];
    expect(big.packets).toBe(3);
    expect(big.extraReceptions).toBe(1);
    expect(big.lastSnr).toBe(9);
    expect(big.avgSnr).toBeCloseTo(5, 5);
    expect(big.lastHops).toBeNull(); // hop_start 0 = unknown sentinel
    expect(big.minHops).toBe(2);
    expect(big.lastHeard).toBe(NOW - 1000);
    expect(big.shortName).toBe('BIG');
    expect(big.longName).toBe('Big Node');
    expect(big.nodeId).toBe('!fedcba98');

    const other = rows[1];
    expect(other.packets).toBe(1);
    expect(other.extraReceptions).toBe(0);
    expect(other.lastSnr).toBeNull();
    expect(other.minHops).toBeNull();
    expect(other.shortName).toBeNull();
  });

  it('excludes tx rows, our own node, other sources, and rows before the window', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new PacketLogRepository(backend.drizzleDb, backend.dbType);

    await repo.insertPacketLog(pkt({ from_node: 0x300 }), SOURCE);
    await repo.insertPacketLog(pkt({ from_node: 0x301, direction: 'tx' }), SOURCE);
    await repo.insertPacketLog(pkt({ from_node: LOCAL }), SOURCE);
    await repo.insertPacketLog(pkt({ from_node: 0x302 }), OTHER);
    await repo.insertPacketLog(pkt({ from_node: 0x303, timestamp: SINCE - 1 }), SOURCE);

    const rows = await repo.getNodeActivity({ sourceId: SOURCE, since: SINCE, localNodeNum: LOCAL });
    expect(rows.map((r) => r.nodeNum)).toEqual([0x300]);
    // Without a local node num, only the tx row is dropped.
    const noLocal = await repo.getNodeActivity({ sourceId: SOURCE, since: SINCE });
    expect(noLocal.map((r) => r.nodeNum).sort()).toEqual([0x300, LOCAL].sort());
  });

  it('applies the transport class and the non-admin visibility rule', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new PacketLogRepository(backend.drizzleDb, backend.dbType);

    await repo.insertPacketLog(pkt({ from_node: 0x400 }), SOURCE);
    await repo.insertPacketLog(pkt({ from_node: 0x401, transport_mechanism: TransportMechanism.MQTT }), SOURCE);
    await repo.insertPacketLog(pkt({ from_node: 0x402, channel: 2 }), SOURCE);

    const rf = await repo.getNodeActivity({ sourceId: SOURCE, since: SINCE, transportClass: 'rf' });
    expect(rf.map((r) => r.nodeNum).sort()).toEqual([0x400, 0x402]);
    const all = await repo.getNodeActivity({ sourceId: SOURCE, since: SINCE });
    expect(all).toHaveLength(3);
    const visible = await repo.getNodeActivity({
      sourceId: SOURCE,
      since: SINCE,
      visibility: { allowedChannels: [0], canReadMessages: false },
    });
    expect(visible.map((r) => r.nodeNum).sort()).toEqual([0x400, 0x401]);
  });

  it('getOldestPacketTimestamp returns the oldest row across all sources, or null', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new PacketLogRepository(backend.drizzleDb, backend.dbType);
    expect(await repo.getOldestPacketTimestamp()).toBeNull();
    await repo.insertPacketLog(pkt({ from_node: 0x500, timestamp: NOW }), SOURCE);
    await repo.insertPacketLog(pkt({ from_node: 0x501, timestamp: NOW - 777 }), OTHER);
    expect(await repo.getOldestPacketTimestamp()).toBe(NOW - 777);
  });
}

describe('PacketLogRepository.getNodeActivity - SQLite Backend', () => {
  let backend: TestBackend;
  beforeAll(() => {
    backend = createSqliteBackend(SQLITE_CREATE);
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    await clearTable(backend, 'packet_log');
    await clearTable(backend, 'nodes');
  });
  runNodeActivityTests(() => backend);
});

describe.skipIf(!postgresAvailable)('PacketLogRepository.getNodeActivity - PostgreSQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await createPostgresBackend(POSTGRES_CREATE, 'r_packetlog_node_activity');
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    if (!backend.available) return;
    await clearTable(backend, 'packet_log');
    await clearTable(backend, 'nodes');
  });
  runNodeActivityTests(() => backend);
});

describe.skipIf(!mysqlAvailable)('PacketLogRepository.getNodeActivity - MySQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await createMysqlBackend(MYSQL_CREATE, 'r_packetlog_node_activity');
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    if (!backend.available) return;
    await clearTable(backend, 'packet_log');
    await clearTable(backend, 'nodes');
  });
  runNodeActivityTests(() => backend);
});
