/**
 * Cross-dialect coverage for `NeighborsRepository.getDirectNeighborRssiAsync`
 * scoped to a LIST of sources.
 *
 * `GET /api/direct-neighbors` serves a caller who holds `nodes:read` on some
 * sources and not others, so it passes the permitted list down to the query
 * (`"sourceId" IN (...)`): packets a source the caller may not read has heard
 * never leave the database. An empty list is "no source": no rows.
 *
 * DDL is hand-written per dialect, as in
 * packetLog.clearPacketLogs.multiBackend.test.ts. PG/MySQL suites own a
 * private database via the isolationKey.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { NeighborsRepository } from './neighbors.js';
import { PacketLogRepository } from './packetLog.js';
import { ALL_SOURCES } from './base.js';
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

const SRC_A = 'src-a';
const SRC_B = 'src-b';
const SRC_C = 'src-c';
const NODE = 0xaabbccdd;
const OTHER = 0x0badf00d;

function runSourceListTests(getBackend: () => TestBackend) {
  const neighbors = () => new NeighborsRepository(getBackend().drizzleDb, getBackend().dbType);

  /** A zero-hop rx packet: hop_start === hop_limit is what "direct" means here. */
  const heard = async (sourceId: string, fromNode: number, rssi: number) => {
    const packets = new PacketLogRepository(getBackend().drizzleDb, getBackend().dbType);
    await packets.insertPacketLog(
      { timestamp: Date.now() - 60_000, from_node: fromNode, portnum: 1, encrypted: false, rssi, hop_limit: 3, hop_start: 3, direction: 'rx' } as never,
      sourceId,
    );
  };

  const seed = async () => {
    await heard(SRC_A, NODE, -40);
    await heard(SRC_B, NODE, -60);
    await heard(SRC_C, NODE, -80);
    await heard(SRC_C, OTHER, -90);
  };

  it('aggregates only the listed sources', async () => {
    if (!getBackend().available) return;
    await seed();

    const ab = await neighbors().getDirectNeighborRssiAsync(24, [SRC_A, SRC_B]);
    expect(ab.get(NODE)).toMatchObject({ nodeNum: NODE });
    expect(Number(ab.get(NODE)?.packetCount)).toBe(2);
    expect(Number(ab.get(NODE)?.avgRssi)).toBe(-50);
    // Only source C heard OTHER.
    expect(ab.has(OTHER)).toBe(false);

    const c = await neighbors().getDirectNeighborRssiAsync(24, [SRC_C]);
    expect(Number(c.get(NODE)?.avgRssi)).toBe(-80);
    expect(Number(c.get(OTHER)?.packetCount)).toBe(1);
  });

  it('returns nothing for an empty list', async () => {
    if (!getBackend().available) return;
    await seed();

    expect((await neighbors().getDirectNeighborRssiAsync(24, [])).size).toBe(0);
  });

  it('still reads one source by id, and every source with ALL_SOURCES or no argument', async () => {
    if (!getBackend().available) return;
    await seed();

    expect(Number((await neighbors().getDirectNeighborRssiAsync(24, SRC_B)).get(NODE)?.avgRssi)).toBe(-60);
    expect(Number((await neighbors().getDirectNeighborRssiAsync(24, ALL_SOURCES)).get(NODE)?.packetCount)).toBe(3);
    expect(Number((await neighbors().getDirectNeighborRssiAsync(24)).get(NODE)?.packetCount)).toBe(3);
  });

  it('binds a source id as a value and refuses a list holding an empty id', async () => {
    if (!getBackend().available) return;
    await seed();

    expect((await neighbors().getDirectNeighborRssiAsync(24, ["src-a') OR ('1'='1"])).size).toBe(0);
    await expect(neighbors().getDirectNeighborRssiAsync(24, [SRC_A, ''])).rejects.toThrow(/non-empty string/);
  });
}

describe('NeighborsRepository direct-neighbour source list - SQLite Backend', () => {
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
  runSourceListTests(() => backend);
});

describe.skipIf(!postgresAvailable)('NeighborsRepository direct-neighbour source list - PostgreSQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await createPostgresBackend(POSTGRES_CREATE, 'r_neighbors_srclist');
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    if (!backend.available) return;
    await clearTable(backend, 'packet_log');
  });
  runSourceListTests(() => backend);
});

describe.skipIf(!mysqlAvailable)('NeighborsRepository direct-neighbour source list - MySQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await createMysqlBackend(MYSQL_CREATE, 'r_neighbors_srclist');
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    if (!backend.available) return;
    await clearTable(backend, 'packet_log');
  });
  runSourceListTests(() => backend);
});
