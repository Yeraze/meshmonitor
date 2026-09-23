/**
 * Cross-dialect coverage for `MessagesRepository.getMessageCountsByChannelAndTransport`
 * (#5101 WP4) — backs `GET /api/messages/counts`, the Info tab's Total
 * Messages RF/MQTT breakdown.
 *
 * DDL below is hand-written per dialect from `src/db/schema/messages.ts`,
 * same convention as `packetLog.broadcastTelemetry.multiBackend.test.ts` —
 * no FK to `nodes` since this query never joins it. PG uses `BOOLEAN` and
 * MySQL `TINYINT(1)`-equivalent (`BOOLEAN`, which MySQL aliases to
 * TINYINT(1)) for `viaMqtt`, matching the real schema per dialect.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MessagesRepository } from './messages.js';
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
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    fromNodeNum INTEGER NOT NULL,
    toNodeNum INTEGER NOT NULL,
    fromNodeId TEXT NOT NULL,
    toNodeId TEXT NOT NULL,
    text TEXT NOT NULL,
    channel INTEGER NOT NULL DEFAULT 0,
    portnum INTEGER,
    requestId INTEGER,
    timestamp INTEGER NOT NULL,
    rxTime INTEGER,
    hopStart INTEGER,
    hopLimit INTEGER,
    relayNode INTEGER,
    replyId INTEGER,
    emoji INTEGER,
    viaMqtt INTEGER,
    viaStoreForward INTEGER,
    xeddsaSigned INTEGER,
    rxSnr REAL,
    rxRssi REAL,
    ackFailed INTEGER,
    routingErrorReceived INTEGER,
    deliveryState TEXT,
    wantAck INTEGER,
    ackFromNode INTEGER,
    routingErrorCode INTEGER,
    createdAt INTEGER NOT NULL,
    decrypted_by TEXT,
    sourceId TEXT,
    source_ip TEXT,
    source_path TEXT,
    spoofSuspected INTEGER
  )
`;

const POSTGRES_CREATE = `
  DROP TABLE IF EXISTS messages CASCADE;
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    "fromNodeNum" BIGINT NOT NULL,
    "toNodeNum" BIGINT NOT NULL,
    "fromNodeId" TEXT NOT NULL,
    "toNodeId" TEXT NOT NULL,
    text TEXT NOT NULL,
    channel INTEGER NOT NULL DEFAULT 0,
    portnum INTEGER,
    "requestId" BIGINT,
    timestamp BIGINT NOT NULL,
    "rxTime" BIGINT,
    "hopStart" INTEGER,
    "hopLimit" INTEGER,
    "relayNode" BIGINT,
    "replyId" BIGINT,
    emoji INTEGER,
    "viaMqtt" BOOLEAN,
    "viaStoreForward" BOOLEAN,
    "xeddsaSigned" BOOLEAN,
    "rxSnr" REAL,
    "rxRssi" REAL,
    "ackFailed" BOOLEAN,
    "routingErrorReceived" BOOLEAN,
    "deliveryState" TEXT,
    "wantAck" BOOLEAN,
    "ackFromNode" BIGINT,
    "routingErrorCode" INTEGER,
    "createdAt" BIGINT NOT NULL,
    decrypted_by TEXT,
    "sourceId" TEXT,
    source_ip TEXT,
    source_path TEXT,
    "spoofSuspected" BOOLEAN
  )
`;

const MYSQL_CREATE = `
  DROP TABLE IF EXISTS messages;
  CREATE TABLE messages (
    id VARCHAR(64) PRIMARY KEY,
    fromNodeNum BIGINT NOT NULL,
    toNodeNum BIGINT NOT NULL,
    fromNodeId VARCHAR(32) NOT NULL,
    toNodeId VARCHAR(32) NOT NULL,
    text TEXT NOT NULL,
    channel INT NOT NULL DEFAULT 0,
    portnum INT,
    requestId BIGINT,
    timestamp BIGINT NOT NULL,
    rxTime BIGINT,
    hopStart INT,
    hopLimit INT,
    relayNode BIGINT,
    replyId BIGINT,
    emoji INT,
    viaMqtt BOOLEAN,
    viaStoreForward BOOLEAN,
    xeddsaSigned BOOLEAN,
    rxSnr DOUBLE,
    rxRssi DOUBLE,
    ackFailed BOOLEAN,
    routingErrorReceived BOOLEAN,
    deliveryState VARCHAR(32),
    wantAck BOOLEAN,
    ackFromNode BIGINT,
    routingErrorCode INT,
    createdAt BIGINT NOT NULL,
    decrypted_by VARCHAR(16),
    sourceId VARCHAR(36),
    source_ip VARCHAR(64),
    source_path VARCHAR(16),
    spoofSuspected BOOLEAN
  )
`;

const SOURCE = 'src-a';
const NOW = 1_760_000_000_000;

function makeMessage(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    fromNodeNum: 900,
    toNodeNum: 0xffffffff,
    fromNodeId: '!00000384',
    toNodeId: '!ffffffff',
    text: 'hi',
    channel: 0,
    timestamp: NOW,
    createdAt: NOW,
    ...overrides,
  } as any;
}

/** Behaviours that must hold identically on every dialect. */
function runTransportCountsTests(getBackend: () => TestBackend) {
  it('merges NULL and false viaMqtt into the rf bucket', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new MessagesRepository(backend.drizzleDb, backend.dbType);
    await repo.insertMessage(makeMessage({ id: 'm1', viaMqtt: null, channel: 0 }), SOURCE);
    await repo.insertMessage(makeMessage({ id: 'm2', viaMqtt: false, channel: 0 }), SOURCE);
    await repo.insertMessage(makeMessage({ id: 'm3', viaMqtt: true, channel: 0 }), SOURCE);

    const rows = await repo.getMessageCountsByChannelAndTransport(SOURCE);
    const ch0 = rows.filter((r) => r.channel === 0);
    const rf = ch0.filter((r) => !r.viaMqtt).reduce((s, r) => s + r.count, 0);
    const mqtt = ch0.filter((r) => r.viaMqtt).reduce((s, r) => s + r.count, 0);
    expect(rf).toBe(2);
    expect(mqtt).toBe(1);
  });

  it('splits counts across two channels', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new MessagesRepository(backend.drizzleDb, backend.dbType);
    await repo.insertMessage(makeMessage({ id: 'm10', channel: 0, viaMqtt: false }), SOURCE);
    await repo.insertMessage(makeMessage({ id: 'm11', channel: 1, viaMqtt: false }), SOURCE);
    await repo.insertMessage(makeMessage({ id: 'm12', channel: 1, viaMqtt: false }), SOURCE);

    const rows = await repo.getMessageCountsByChannelAndTransport(SOURCE);
    const byChannel = new Map<number, number>();
    for (const r of rows) byChannel.set(r.channel, (byChannel.get(r.channel) ?? 0) + r.count);
    expect(byChannel.get(0)).toBe(1);
    expect(byChannel.get(1)).toBe(2);
  });

  it('excludes TRACEROUTE_APP rows when passed as excludePortnums', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new MessagesRepository(backend.drizzleDb, backend.dbType);
    await repo.insertMessage(makeMessage({ id: 'm20', channel: 0, portnum: PortNum.TEXT_MESSAGE_APP }), SOURCE);
    await repo.insertMessage(makeMessage({ id: 'm21', channel: 0, portnum: PortNum.TRACEROUTE_APP }), SOURCE);

    const rows = await repo.getMessageCountsByChannelAndTransport(SOURCE, [PortNum.TRACEROUTE_APP]);
    const total = rows.reduce((s, r) => s + r.count, 0);
    expect(total).toBe(1);
  });

  it('keeps NULL-portnum rows even when excludePortnums is set (legacy rows)', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new MessagesRepository(backend.drizzleDb, backend.dbType);
    await repo.insertMessage(makeMessage({ id: 'm30', channel: 0, portnum: null }), SOURCE);

    const rows = await repo.getMessageCountsByChannelAndTransport(SOURCE, [PortNum.TRACEROUTE_APP]);
    const total = rows.reduce((s, r) => s + r.count, 0);
    expect(total).toBe(1);
  });

  it('returns a plain JS number for count (BIGINT on PG)', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new MessagesRepository(backend.drizzleDb, backend.dbType);
    await repo.insertMessage(makeMessage({ id: 'm40', channel: 0 }), SOURCE);

    const rows = await repo.getMessageCountsByChannelAndTransport(SOURCE);
    for (const r of rows) {
      expect(typeof r.count).toBe('number');
      expect(typeof r.channel).toBe('number');
      expect(typeof r.viaMqtt).toBe('boolean');
    }
  });
}

describe('MessagesRepository.getMessageCountsByChannelAndTransport - SQLite Backend', () => {
  let backend: TestBackend;
  beforeAll(() => {
    backend = createSqliteBackend(SQLITE_CREATE);
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    await clearTable(backend, 'messages');
  });
  runTransportCountsTests(() => backend);
});

describe.skipIf(!postgresAvailable)('MessagesRepository.getMessageCountsByChannelAndTransport - PostgreSQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await createPostgresBackend(POSTGRES_CREATE, 'r_messages_transport_counts');
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    await clearTable(backend, 'messages');
  });
  runTransportCountsTests(() => backend);
});

describe.skipIf(!mysqlAvailable)('MessagesRepository.getMessageCountsByChannelAndTransport - MySQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await createMysqlBackend(MYSQL_CREATE, 'r_messages_transport_counts');
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    await clearTable(backend, 'messages');
  });
  runTransportCountsTests(() => backend);
});
