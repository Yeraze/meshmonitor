/**
 * Cross-dialect coverage for the `#5101` packet_log transport class filter
 * — the single `transportConditions` helper shared by `getPacketLogCount`
 * (via `buildPacketLogWhere`), `getPacketCountsByNode` and
 * `getPacketCountsByPortnum`. `packet_log` has no `viaMqtt` column, so the
 * class mapping mirrors `classifyNodeTransport` with `viaMqtt` absent:
 * MQTT(5)->mqtt, MULTICAST_UDP(6)->udp, everything else incl. NULL->rf.
 *
 * DDL below is hand-written per dialect from `src/db/schema/packets.ts`,
 * same convention as `packetLog.broadcastTelemetry.multiBackend.test.ts`,
 * plus a minimal `nodes` table (`nodeNum`, `sourceId`, `longName`) because
 * `getPacketCountsByNode` has a scalar subquery on `nodes`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PacketLogRepository } from './packetLog.js';
import { DbPacketLog } from '../types.js';
import { PortNum, TransportMechanism } from '../../server/constants/meshtastic.js';
import { classifyNodeTransport, type NodeTransportClass } from '../../utils/nodeTransport.js';
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

// One row per mechanism value, NULL plus every declared TransportMechanism
// enum member (0-7). Distinct from_node/packet_id per row so per-node and
// per-portnum aggregates line up 1:1 with the mechanism.
const MECHANISMS: Array<number | null> = [null, 0, 1, 2, 3, 4, 5, 6, 7];

function makePacket(mechanism: number | null, index: number): Omit<DbPacketLog, 'id' | 'created_at'> {
  return {
    packet_id: 2000 + index,
    timestamp: NOW + index,
    from_node: 2000 + index,
    from_node_id: `!${(2000 + index).toString(16)}`,
    to_node: 4294967295,
    portnum: PortNum.TEXT_MESSAGE_APP,
    portnum_name: 'TEXT_MESSAGE_APP',
    encrypted: false,
    direction: 'rx' as const,
    transport_mechanism: mechanism as any,
  } as Omit<DbPacketLog, 'id' | 'created_at'>;
}

function expectedCountFor(cls: NodeTransportClass): number {
  return MECHANISMS.filter((m) => classifyNodeTransport({ transportMechanism: m }) === cls).length;
}

/** Behaviours that must hold identically on every dialect. */
function runTransportClassTests(getBackend: () => TestBackend) {
  it('classifies every mechanism value the same way classifyNodeTransport does, across all three query methods', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new PacketLogRepository(backend.drizzleDb, backend.dbType);

    for (let i = 0; i < MECHANISMS.length; i++) {
      await repo.insertPacketLog(makePacket(MECHANISMS[i], i), SOURCE);
    }

    for (const cls of ['rf', 'udp', 'mqtt'] as const) {
      const expected = expectedCountFor(cls);

      const total = await repo.getPacketLogCount({ sourceId: SOURCE, transportClass: cls });
      expect(total).toBe(expected);

      const byNode = await repo.getPacketCountsByNode({ sourceId: SOURCE, transportClass: cls, limit: 100 });
      expect(byNode.reduce((sum, r) => sum + r.count, 0)).toBe(expected);

      const byPortnum = await repo.getPacketCountsByPortnum({ sourceId: SOURCE, transportClass: cls });
      expect(byPortnum.reduce((sum, r) => sum + r.count, 0)).toBe(expected);
    }
  });

  it('exact transport_mechanism filtering still works (regression for the transportConditions refactor)', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new PacketLogRepository(backend.drizzleDb, backend.dbType);

    for (let i = 0; i < MECHANISMS.length; i++) {
      await repo.insertPacketLog(makePacket(MECHANISMS[i], i), SOURCE);
    }

    // Every non-null mechanism value appears exactly once.
    for (const m of MECHANISMS.filter((v): v is number => v !== null)) {
      const total = await repo.getPacketLogCount({ sourceId: SOURCE, transport_mechanism: m });
      expect(total).toBe(1);
    }
  });

  it('NULL transport_mechanism classifies as rf (no viaMqtt column to fall back on)', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new PacketLogRepository(backend.drizzleDb, backend.dbType);
    await repo.insertPacketLog(makePacket(null, 0), SOURCE);

    const total = await repo.getPacketLogCount({ sourceId: SOURCE, transportClass: 'rf' });
    expect(total).toBe(1);
    const mqttTotal = await repo.getPacketLogCount({ sourceId: SOURCE, transportClass: 'mqtt' });
    expect(mqttTotal).toBe(0);
  });

  it('mechanism 5 (MQTT) classifies as mqtt', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new PacketLogRepository(backend.drizzleDb, backend.dbType);
    await repo.insertPacketLog(makePacket(TransportMechanism.MQTT, 0), SOURCE);

    expect(await repo.getPacketLogCount({ sourceId: SOURCE, transportClass: 'mqtt' })).toBe(1);
    expect(await repo.getPacketLogCount({ sourceId: SOURCE, transportClass: 'rf' })).toBe(0);
  });

  it('mechanism 6 (MULTICAST_UDP) classifies as udp', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new PacketLogRepository(backend.drizzleDb, backend.dbType);
    await repo.insertPacketLog(makePacket(TransportMechanism.MULTICAST_UDP, 0), SOURCE);

    expect(await repo.getPacketLogCount({ sourceId: SOURCE, transportClass: 'udp' })).toBe(1);
    expect(await repo.getPacketLogCount({ sourceId: SOURCE, transportClass: 'rf' })).toBe(0);
  });
}

describe('PacketLogRepository transport class filter - SQLite Backend', () => {
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
  runTransportClassTests(() => backend);
});

describe.skipIf(!postgresAvailable)('PacketLogRepository transport class filter - PostgreSQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await createPostgresBackend(POSTGRES_CREATE, 'r_packetlog_transport_class');
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    if (!backend.available) return;
    await clearTable(backend, 'packet_log');
  });
  runTransportClassTests(() => backend);
});

describe.skipIf(!mysqlAvailable)('PacketLogRepository transport class filter - MySQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await createMysqlBackend(MYSQL_CREATE, 'r_packetlog_transport_class');
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    if (!backend.available) return;
    await clearTable(backend, 'packet_log');
  });
  runTransportClassTests(() => backend);
});
