/**
 * Cross-dialect regression coverage for `PacketLogRepository.clearPacketLogs`.
 *
 * The sourceId-scoped branch used to build its DELETE with a raw, unquoted
 * `sourceId` identifier (`sql\`DELETE FROM packet_log WHERE sourceId = ...\`).
 * SQLite folds unquoted identifiers case-insensitively, so the SQLite suite
 * passed even though the query was wrong: on PostgreSQL an unquoted
 * identifier is folded to lowercase, and the actual column is the
 * camelCase, quoted `"sourceId"` — so the query failed with
 * `column "sourceid" does not exist` (#5237), surfacing whenever a
 * per-source "Clear all packets" action ran against Postgres. Exercised on
 * all three backends so a case-folding regression like this can't hide
 * behind the SQLite-only suite again.
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

const SOURCE_A = 'src-a';
const SOURCE_B = 'src-b';
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
    ...overrides,
  };
}

/**
 * Behaviours that must hold identically on every dialect.
 */
function runClearPacketLogsTests(getBackend: () => TestBackend) {
  it('deletes only the rows for the given sourceId, leaving other sources untouched', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new PacketLogRepository(backend.drizzleDb, backend.dbType);
    await repo.insertPacketLog(makePacket({ packet_id: 1, from_node: 100 }) as any, SOURCE_A);
    await repo.insertPacketLog(makePacket({ packet_id: 2, from_node: 101 }) as any, SOURCE_A);
    await repo.insertPacketLog(makePacket({ packet_id: 3, from_node: 200 }) as any, SOURCE_B);

    const deleted = await repo.clearPacketLogs(SOURCE_A);
    expect(deleted).toBe(2);

    expect(await repo.getPacketLogCount({ sourceId: SOURCE_A })).toBe(0);
    expect(await repo.getPacketLogCount({ sourceId: SOURCE_B })).toBe(1);
  });

  it('deletes every row across all sources when sourceId is omitted', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new PacketLogRepository(backend.drizzleDb, backend.dbType);
    await repo.insertPacketLog(makePacket({ packet_id: 4, from_node: 100 }) as any, SOURCE_A);
    await repo.insertPacketLog(makePacket({ packet_id: 5, from_node: 200 }) as any, SOURCE_B);

    const deleted = await repo.clearPacketLogs();
    expect(deleted).toBe(2);

    expect(await repo.getPacketLogCount()).toBe(0);
  });

  it('returns 0 and leaves other rows in place for a sourceId with no matching rows', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new PacketLogRepository(backend.drizzleDb, backend.dbType);
    await repo.insertPacketLog(makePacket({ packet_id: 6, from_node: 100 }) as any, SOURCE_A);

    const deleted = await repo.clearPacketLogs('no-such-source');
    expect(deleted).toBe(0);

    expect(await repo.getPacketLogCount({ sourceId: SOURCE_A })).toBe(1);
  });
}

describe('PacketLogRepository.clearPacketLogs - SQLite Backend', () => {
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
  runClearPacketLogsTests(() => backend);
});

describe.skipIf(!postgresAvailable)('PacketLogRepository.clearPacketLogs - PostgreSQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await createPostgresBackend(POSTGRES_CREATE, 'r_packetlog_clear');
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    if (!backend.available) return;
    await clearTable(backend, 'packet_log');
  });
  runClearPacketLogsTests(() => backend);
});

describe.skipIf(!mysqlAvailable)('PacketLogRepository.clearPacketLogs - MySQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await createMysqlBackend(MYSQL_CREATE, 'r_packetlog_clear');
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    if (!backend.available) return;
    await clearTable(backend, 'packet_log');
  });
  runClearPacketLogsTests(() => backend);
});
