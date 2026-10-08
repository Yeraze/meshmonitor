/**
 * Cross-dialect coverage for `PacketLogRepository.scanForTrafficReplay`, the
 * keyset range scan behind the Traffic Management replay (#5670).
 *
 * DDL is hand-written per dialect from `src/db/schema/packets.ts` (same
 * convention as `packetLog.nodeActivity.multiBackend.test.ts`), with the
 * `(sourceId, timestamp)` index migration 190 adds. Each container suite owns
 * a private database.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PacketLogRepository, type TrafficReplayScanRow } from './packetLog.js';
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
  CREATE INDEX idx_packet_log_source_timestamp ON packet_log(sourceId, timestamp)
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
  );
  CREATE INDEX idx_packet_log_source_timestamp ON packet_log("sourceId", timestamp)
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
    spoof_suspected BOOLEAN,
    INDEX idx_packet_log_source_timestamp (sourceId, timestamp)
  )
`;

const SOURCE = 'src-a';
const OTHER = 'src-b';
const NOW = 1_760_000_000_000;
const BIG = 0xfedcba98; // unsigned 32-bit, above signed INTEGER's ceiling
const POSITION_META = JSON.stringify({ decoded_payload: { latitudeI: 407000000, longitudeI: -740000000 } });

let pid = 1;
function pkt(over: Partial<DbPacketLog> & { from_node: number }): Omit<DbPacketLog, 'id' | 'created_at'> {
  return {
    packet_id: pid++,
    timestamp: NOW,
    from_node_id: `!${over.from_node.toString(16).padStart(8, '0')}`,
    to_node: 4294967295,
    channel: 0,
    portnum: PortNum.TEXT_MESSAGE_APP,
    portnum_name: 'TEXT_MESSAGE_APP',
    encrypted: false,
    direction: 'rx',
    transport_mechanism: TransportMechanism.LORA,
    ...over,
  } as Omit<DbPacketLog, 'id' | 'created_at'>;
}

/** Page through the whole source the way the service does. */
async function scanAll(repo: PacketLogRepository, sourceId: string, pageSize: number, cap = Infinity) {
  const out: TrafficReplayScanRow[] = [];
  let before: { timestamp: number; id: number } | undefined;
  let pages = 0;
  while (out.length < cap) {
    const page = await repo.scanForTrafficReplay({ sourceId, limit: Math.min(pageSize, cap - out.length), before });
    pages++;
    if (page.length === 0) break;
    out.push(...page);
    const last = page[page.length - 1];
    before = { timestamp: last.timestamp, id: last.id };
    if (page.length < pageSize) break;
  }
  return { rows: out, pages };
}

function runScanTests(getBackend: () => TestBackend) {
  it('returns only the named source, newest first', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new PacketLogRepository(backend.drizzleDb, backend.dbType);
    await repo.insertPacketLog(pkt({ from_node: 1, timestamp: NOW - 3000 }), SOURCE);
    await repo.insertPacketLog(pkt({ from_node: 2, timestamp: NOW - 1000 }), SOURCE);
    await repo.insertPacketLog(pkt({ from_node: 3, timestamp: NOW - 2000 }), SOURCE);
    await repo.insertPacketLog(pkt({ from_node: 99, timestamp: NOW - 1500 }), OTHER);

    const rows = await repo.scanForTrafficReplay({ sourceId: SOURCE, limit: 100 });
    expect(rows.map((r) => r.from_node)).toEqual([2, 3, 1]);
    expect(rows.map((r) => r.timestamp)).toEqual([NOW - 1000, NOW - 2000, NOW - 3000]);
  });

  it('pages by keyset without skipping or repeating rows that share a timestamp', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new PacketLogRepository(backend.drizzleDb, backend.dbType);
    // 11 rows, in three groups of equal timestamps that straddle page edges.
    for (let i = 0; i < 11; i++) {
      await repo.insertPacketLog(pkt({ from_node: 100 + i, timestamp: NOW - Math.floor(i / 4) * 1000 }), SOURCE);
    }
    const { rows, pages } = await scanAll(repo, SOURCE, 3);
    expect(pages).toBe(4);
    expect(rows).toHaveLength(11);
    expect(new Set(rows.map((r) => r.id)).size).toBe(11);
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1];
      const cur = rows[i];
      expect(prev.timestamp > cur.timestamp || (prev.timestamp === cur.timestamp && prev.id > cur.id)).toBe(true);
    }
  });

  it('stops at the caller cap and keeps the newest rows', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new PacketLogRepository(backend.drizzleDb, backend.dbType);
    for (let i = 0; i < 10; i++) {
      await repo.insertPacketLog(pkt({ from_node: 200 + i, timestamp: NOW - i * 1000 }), SOURCE);
    }
    const { rows } = await scanAll(repo, SOURCE, 4, 6);
    expect(rows.map((r) => r.from_node)).toEqual([200, 201, 202, 203, 204, 205]);
  });

  it('returns metadata for POSITION rows only', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new PacketLogRepository(backend.drizzleDb, backend.dbType);
    await repo.insertPacketLog(
      pkt({ from_node: 1, timestamp: NOW - 2000, portnum: PortNum.POSITION_APP, metadata: POSITION_META }),
      SOURCE,
    );
    await repo.insertPacketLog(
      pkt({ from_node: 2, timestamp: NOW - 1000, portnum: PortNum.TELEMETRY_APP, metadata: '{"decoded_payload":{"big":"blob"}}' }),
      SOURCE,
    );
    const rows = await repo.scanForTrafficReplay({ sourceId: SOURCE, limit: 10 });
    expect(rows[0].portnum).toBe(PortNum.TELEMETRY_APP);
    expect(rows[0].position_metadata).toBeNull();
    expect(rows[1].position_metadata).toBe(POSITION_META);
  });

  it('normalises numbers, booleans and nulls the same way on every backend', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new PacketLogRepository(backend.drizzleDb, backend.dbType);
    await repo.insertPacketLog(
      pkt({ from_node: BIG, to_node: BIG - 1, channel: 3, timestamp: NOW - 2000, decrypted_by: 'server' }),
      SOURCE,
    );
    await repo.insertPacketLog(
      pkt({ from_node: 7, to_node: undefined, channel: undefined, timestamp: NOW - 1000, encrypted: true, direction: 'tx', portnum: 0 }),
      SOURCE,
    );
    const [tx, big] = await repo.scanForTrafficReplay({ sourceId: SOURCE, limit: 10 });
    expect(big).toMatchObject({
      from_node: BIG,
      to_node: BIG - 1,
      channel: 3,
      timestamp: NOW - 2000,
      encrypted: false,
      direction: 'rx',
      decrypted_by: 'server',
      position_metadata: null,
    });
    expect(typeof big.id).toBe('number');
    expect(tx).toMatchObject({ from_node: 7, to_node: null, channel: null, encrypted: true, direction: 'tx', decrypted_by: null });
  });

  it('returns an empty page for a source with no rows', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new PacketLogRepository(backend.drizzleDb, backend.dbType);
    await repo.insertPacketLog(pkt({ from_node: 1 }), OTHER);
    expect(await repo.scanForTrafficReplay({ sourceId: SOURCE, limit: 10 })).toEqual([]);
  });
}

describe('PacketLogRepository.scanForTrafficReplay - SQLite Backend', () => {
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
  runScanTests(() => backend);
});

describe.skipIf(!postgresAvailable)('PacketLogRepository.scanForTrafficReplay - PostgreSQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await createPostgresBackend(POSTGRES_CREATE, 'r_packetlog_traffic_replay');
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    if (!backend?.available) return;
    await clearTable(backend, 'packet_log');
  });
  runScanTests(() => backend);
});

describe.skipIf(!mysqlAvailable)('PacketLogRepository.scanForTrafficReplay - MySQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await createMysqlBackend(MYSQL_CREATE, 'r_packetlog_traffic_replay');
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    if (!backend?.available) return;
    await clearTable(backend, 'packet_log');
  });
  runScanTests(() => backend);
});
