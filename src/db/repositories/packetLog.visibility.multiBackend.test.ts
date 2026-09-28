/**
 * Cross-dialect coverage for the non-admin packet visibility filter on the
 * aggregate counts behind GET /api/packets/stats/distribution. It is the SQL
 * twin of `filterPacketsByPermissions`: a row counts when it is encrypted, or
 * a text DM the caller can read, or a non-DM on a null or permitted channel.
 * DDL copied from `packetLog.transportClass.multiBackend.test.ts`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PacketLogRepository, type PacketVisibility } from './packetLog.js';
import { DbPacketLog } from '../types.js';
import { PortNum } from '../../server/constants/meshtastic.js';
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
    PRIMARY KEY (nodeNum, sourceId)
  )
`;

const SOURCE = 'src-a';
const NOW = 1_760_000_000_000;
const BROADCAST = 4294967295;

let seq = 0;
function pkt(o: { channel?: number | null; portnum?: number; to?: number; encrypted?: boolean }): Omit<DbPacketLog, 'id' | 'created_at'> {
  seq++;
  return {
    packet_id: 5000 + seq,
    timestamp: NOW + seq,
    from_node: 7000 + seq,
    from_node_id: `!${(7000 + seq).toString(16)}`,
    to_node: o.to ?? BROADCAST,
    channel: o.channel === undefined ? 0 : o.channel,
    portnum: o.portnum ?? PortNum.POSITION_APP,
    portnum_name: 'X',
    encrypted: o.encrypted ?? false,
    direction: 'rx' as const,
  } as Omit<DbPacketLog, 'id' | 'created_at'>;
}

async function seed(repo: PacketLogRepository): Promise<void> {
  // ch0 x2, ch3 x1, null channel x1, encrypted on ch5 x1, text DM on ch0 x1, broadcast text on ch3 x1
  await repo.insertPacketLog(pkt({ channel: 0 }), SOURCE);
  await repo.insertPacketLog(pkt({ channel: 0 }), SOURCE);
  await repo.insertPacketLog(pkt({ channel: 3 }), SOURCE);
  await repo.insertPacketLog(pkt({ channel: null }), SOURCE);
  await repo.insertPacketLog(pkt({ channel: 5, encrypted: true }), SOURCE);
  await repo.insertPacketLog(pkt({ channel: 0, portnum: PortNum.TEXT_MESSAGE_APP, to: 1234 }), SOURCE);
  await repo.insertPacketLog(pkt({ channel: 3, portnum: PortNum.TEXT_MESSAGE_APP, to: BROADCAST }), SOURCE);
}

async function counts(repo: PacketLogRepository, visibility?: PacketVisibility) {
  const total = await repo.getPacketLogCount({ sourceId: SOURCE, visibility });
  const byNode = (await repo.getPacketCountsByNode({ sourceId: SOURCE, limit: 100, visibility })).reduce((s, r) => s + r.count, 0);
  const byType = (await repo.getPacketCountsByPortnum({ sourceId: SOURCE, visibility })).reduce((s, r) => s + r.count, 0);
  return { total, byNode, byType };
}

function runVisibilityTests(getBackend: () => TestBackend) {
  it('no visibility (admin) counts everything', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new PacketLogRepository(backend.drizzleDb, backend.dbType);
    await seed(repo);
    expect(await counts(repo)).toEqual({ total: 7, byNode: 7, byType: 7 });
  });

  it('channel 0 only, no DMs: ch0 non-DM + null channel + encrypted', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new PacketLogRepository(backend.drizzleDb, backend.dbType);
    await seed(repo);
    // 2 (ch0) + 1 (null) + 1 (encrypted ch5) = 4
    expect(await counts(repo, { allowedChannels: [0], canReadMessages: false })).toEqual({ total: 4, byNode: 4, byType: 4 });
  });

  it('channel 0 with DMs adds the text DM', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new PacketLogRepository(backend.drizzleDb, backend.dbType);
    await seed(repo);
    expect(await counts(repo, { allowedChannels: [0], canReadMessages: true })).toEqual({ total: 5, byNode: 5, byType: 5 });
  });

  it('channels 0 and 3 include the broadcast text on 3', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new PacketLogRepository(backend.drizzleDb, backend.dbType);
    await seed(repo);
    // 2 + 1 (ch3) + 1 (text broadcast ch3) + 1 null + 1 encrypted = 6
    expect(await counts(repo, { allowedChannels: [0, 3], canReadMessages: false })).toEqual({ total: 6, byNode: 6, byType: 6 });
  });

  it('no channels at all: only null-channel and encrypted rows', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new PacketLogRepository(backend.drizzleDb, backend.dbType);
    await seed(repo);
    expect(await counts(repo, { allowedChannels: [], canReadMessages: false })).toEqual({ total: 2, byNode: 2, byType: 2 });
  });
}

describe('PacketLogRepository packet visibility - SQLite Backend', () => {
  let backend: TestBackend;
  beforeAll(() => { backend = createSqliteBackend(SQLITE_CREATE); });
  afterAll(async () => { if (backend) await backend.close(); });
  beforeEach(async () => { await clearTable(backend, 'packet_log'); });
  runVisibilityTests(() => backend);
});

describe.skipIf(!postgresAvailable)('PacketLogRepository packet visibility - PostgreSQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => { backend = await createPostgresBackend(POSTGRES_CREATE, 'r_packetlog_visibility'); });
  afterAll(async () => { if (backend) await backend.close(); });
  beforeEach(async () => { if (!backend.available) return; await clearTable(backend, 'packet_log'); });
  runVisibilityTests(() => backend);
});

describe.skipIf(!mysqlAvailable)('PacketLogRepository packet visibility - MySQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => { backend = await createMysqlBackend(MYSQL_CREATE, 'r_packetlog_visibility'); });
  afterAll(async () => { if (backend) await backend.close(); });
  beforeEach(async () => { if (!backend.available) return; await clearTable(backend, 'packet_log'); });
  runVisibilityTests(() => backend);
});
