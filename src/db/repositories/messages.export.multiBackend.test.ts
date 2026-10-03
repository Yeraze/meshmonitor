/**
 * Cross-dialect coverage for the message export and search queries (#5517):
 * LIKE escaping of `%`/`_`, case-insensitive keyword match, the canonical-time
 * expression, and keyset paging, on SQLite, PostgreSQL and MySQL.
 *
 * DDL is hand-written per dialect (messages copied from
 * `messages.transportCounts.multiBackend.test.ts`, meshcore_messages from
 * `src/db/schema/meshcoreMessages.ts`), with no FK to `nodes`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MessagesRepository } from './messages.js';
import { MeshCoreRepository } from './meshcore.js';
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
    ackProofStatus INTEGER,
    transportMechanism INTEGER,
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
  );

  CREATE TABLE meshcore_messages (
    id TEXT PRIMARY KEY,
    fromPublicKey TEXT NOT NULL,
    fromName TEXT,
    toPublicKey TEXT,
    text TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    rssi INTEGER,
    snr REAL,
    hopCount INTEGER,
    routePath TEXT,
    scopeCode INTEGER,
    scopeName TEXT,
    senderTimestamp INTEGER,
    keySourceId TEXT,
    keyChannelIdx INTEGER,
    keyFingerprint TEXT,
    messageType TEXT DEFAULT 'text',
    delivered INTEGER DEFAULT 0,
    deliveredAt INTEGER,
    sourceId TEXT,
    createdAt INTEGER NOT NULL
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
    "ackProofStatus" SMALLINT,
    "transportMechanism" INTEGER,
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
  );

  DROP TABLE IF EXISTS meshcore_messages CASCADE;
  CREATE TABLE meshcore_messages (
    id TEXT PRIMARY KEY,
    "fromPublicKey" TEXT NOT NULL,
    "fromName" TEXT,
    "toPublicKey" TEXT,
    text TEXT NOT NULL,
    timestamp BIGINT NOT NULL,
    rssi INTEGER,
    snr REAL,
    "hopCount" INTEGER,
    "routePath" TEXT,
    "scopeCode" INTEGER,
    "scopeName" TEXT,
    "senderTimestamp" BIGINT,
    "keySourceId" TEXT,
    "keyChannelIdx" INTEGER,
    "keyFingerprint" TEXT,
    "messageType" TEXT DEFAULT 'text',
    delivered BOOLEAN DEFAULT false,
    "deliveredAt" BIGINT,
    "sourceId" TEXT,
    "createdAt" BIGINT NOT NULL
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
    ackProofStatus SMALLINT,
    transportMechanism INT,
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
  );

  DROP TABLE IF EXISTS meshcore_messages;
  CREATE TABLE meshcore_messages (
    id VARCHAR(64) PRIMARY KEY,
    fromPublicKey VARCHAR(64) NOT NULL,
    fromName VARCHAR(64),
    toPublicKey VARCHAR(64),
    text TEXT NOT NULL,
    timestamp BIGINT NOT NULL,
    rssi INT,
    snr DOUBLE,
    hopCount INT,
    routePath TEXT,
    scopeCode INT,
    scopeName TEXT,
    senderTimestamp BIGINT,
    keySourceId VARCHAR(64),
    keyChannelIdx INT,
    keyFingerprint VARCHAR(32),
    messageType VARCHAR(32) DEFAULT 'text',
    delivered BOOLEAN DEFAULT false,
    deliveredAt BIGINT,
    sourceId VARCHAR(64),
    createdAt BIGINT NOT NULL
  )
`;

const SRC = 'src-a';
const OTHER = 'src-b';
const T0 = 1_760_000_000_000;
let seq = 0;

async function addMsg(repo: MessagesRepository, overrides: Record<string, unknown> = {}, sourceId = SRC) {
  seq++;
  await repo.insertMessage({
    id: `${sourceId}_900_${seq}`,
    fromNodeNum: 900,
    toNodeNum: 0xffffffff,
    fromNodeId: '!00000384',
    toNodeId: '!ffffffff',
    text: `m${seq}`,
    channel: 0,
    portnum: 1,
    timestamp: T0 + seq,
    createdAt: T0 + seq,
    ...overrides,
  } as any, sourceId);
}

async function addMc(repo: MeshCoreRepository, overrides: Record<string, unknown> = {}, sourceId = SRC) {
  seq++;
  await repo.insertMessage({
    id: `mc-${seq}`,
    fromPublicKey: 'channel-0',
    fromName: 'Alice',
    toPublicKey: null,
    text: `m${seq}`,
    timestamp: T0 + seq,
    messageType: 'text',
    sourceId,
    createdAt: T0 + seq,
    ...overrides,
  } as any, sourceId);
}

function runExportTests(getBackend: () => TestBackend) {
  it('Meshtastic: keywords are case-insensitive substrings with literal % and _', async () => {
    const b = getBackend();
    if (!b.available) return;
    const repo = new MessagesRepository(b.drizzleDb, b.dbType);
    await addMsg(repo, { text: 'Net Control 100%' });
    await addMsg(repo, { text: 'net control 100 pct' });
    await addMsg(repo, { text: 'node_1 online' });
    await addMsg(repo, { text: 'nodeX1 online' });
    await addMsg(repo, { text: 'NET 100% elsewhere' }, OTHER);

    const pct = await repo.getMessagesForExport({ sourceId: SRC, channels: 'all', includeTerms: ['NET CONTROL 100%'] });
    expect(pct.map((r) => r.text)).toEqual(['Net Control 100%']);
    const und = await repo.getMessagesForExport({ sourceId: SRC, channels: 'all', includeTerms: ['node_1'] });
    expect(und.map((r) => r.text)).toEqual(['node_1 online']);
    const excl = await repo.getMessagesForExport({ sourceId: SRC, channels: 'all', excludeTerms: ['NET'] });
    expect(excl.map((r) => r.text)).toEqual(['node_1 online', 'nodeX1 online']);
  });

  it('Meshtastic: canonical time skips an implausible rxTime; keyset pages through ties', async () => {
    const b = getBackend();
    if (!b.available) return;
    const repo = new MessagesRepository(b.drizzleDb, b.dbType);
    await addMsg(repo, { text: 'zero-rx', rxTime: 0, timestamp: T0 + 500 });
    await addMsg(repo, { text: 'real-rx', rxTime: T0 + 100, timestamp: T0 + 900 });
    for (let i = 0; i < 3; i++) await addMsg(repo, { text: `tie${i}`, timestamp: T0 + 700 });

    const ranged = await repo.getMessagesForExport({ sourceId: SRC, channels: 'all', startMs: T0 + 400, endMs: T0 + 600 });
    expect(ranged.map((r) => r.text)).toEqual(['zero-rx']);

    const seen: string[] = [];
    let after: { time: number; id: string } | undefined;
    for (;;) {
      const page = await repo.getMessagesForExport({ sourceId: SRC, channels: 'all', after, limit: 2 });
      if (page.length === 0) break;
      seen.push(...page.map((r) => r.text));
      const last = page[page.length - 1];
      const rx = last.rxTime != null && Number(last.rxTime) > 1_577_836_800_000 ? Number(last.rxTime) : Number(last.timestamp);
      after = { time: rx, id: last.id };
    }
    expect(seen[0]).toBe('real-rx');
    expect(seen[1]).toBe('zero-rx');
    expect(seen.slice(2).sort()).toEqual(['tie0', 'tie1', 'tie2']);
  });

  it('Meshtastic: scoped search is case-insensitive, escaped and source-bound', async () => {
    const b = getBackend();
    if (!b.available) return;
    const repo = new MessagesRepository(b.drizzleDb, b.dbType);
    await addMsg(repo, { text: 'Hello 50%' });
    await addMsg(repo, { text: 'hello 50 pct' });
    await addMsg(repo, { text: 'hello 50%' }, OTHER);
    const res = await repo.searchMessages({ query: 'HELLO 50%', scopes: [{ sourceId: SRC, channels: [0] }] });
    expect(res.total).toBe(1);
    expect(res.messages[0].text).toBe('Hello 50%');
    const cs = await repo.searchMessages({ query: 'hello', caseSensitive: true, sourceId: SRC });
    expect(cs.total).toBe(1);
  });

  it('MeshCore: keywords, channel/DM split and keyset paging', async () => {
    const b = getBackend();
    if (!b.available) return;
    const repo = new MeshCoreRepository(b.drizzleDb, b.dbType);
    await addMc(repo, { text: 'Shelter_A 100%' });
    await addMc(repo, { text: 'shelterXA 100 pct' });
    await addMc(repo, { text: 'dm shelter_a', fromPublicKey: 'bb'.repeat(32), fromName: null, toPublicKey: 'aa'.repeat(32) });
    await addMc(repo, { text: 'shelter_a other', timestamp: T0 }, OTHER);

    const chans = await repo.getMessagesForExport({ sourceId: SRC, channels: [0], includeDms: false, includeTerms: ['SHELTER_A'] });
    expect(chans.map((r) => r.text)).toEqual(['Shelter_A 100%']);
    const dms = await repo.getMessagesForExport({ sourceId: SRC, channels: [], includeDms: true });
    expect(dms.map((r) => r.text)).toEqual(['dm shelter_a']);
    const search = await repo.searchMessages({ query: '100%', scopes: [{ sourceId: SRC, channels: 'all', includeDms: true }] });
    expect(search.total).toBe(1);

    const seen: string[] = [];
    let after: { time: number; id: string } | undefined;
    for (;;) {
      const page = await repo.getMessagesForExport({ sourceId: SRC, channels: 'all', includeDms: true, after, limit: 1 });
      if (page.length === 0) break;
      seen.push(page[0].text);
      after = { time: Number(page[0].timestamp), id: page[0].id };
    }
    expect(seen).toEqual(['Shelter_A 100%', 'shelterXA 100 pct', 'dm shelter_a']);
  });

  it('MeshCore: the keyed-message gate (#5551) filters every read by key fingerprint', async () => {
    const b = getBackend();
    if (!b.available) return;
    const repo = new MeshCoreRepository(b.drizzleDb, b.dbType);
    const keyed = { fromPublicKey: 'channel-1234', keySourceId: 'src-x', keyChannelIdx: 3, keyFingerprint: 'aaaaaaaaaaaaaaaa' };
    await addMc(repo, { text: 'plain' });
    await addMc(repo, { text: 'keyed one', ...keyed });
    await addMc(repo, { text: 'keyed two', ...keyed, keyFingerprint: 'bbbbbbbbbbbbbbbb', fromPublicKey: 'channel-2222' });

    const texts = async (keyAccess?: 'all' | string[]) =>
      (await repo.getRecentMessages(50, SRC, keyAccess)).map((r) => r.text).sort();
    expect(await texts()).toEqual(['keyed one', 'keyed two', 'plain']);
    expect(await texts('all')).toEqual(['keyed one', 'keyed two', 'plain']);
    expect(await texts([])).toEqual(['plain']);
    expect(await texts(['aaaaaaaaaaaaaaaa'])).toEqual(['keyed one', 'plain']);

    expect(await repo.getChannelMessages(1234, 10, SRC, 0, [])).toEqual([]);
    expect((await repo.getChannelMessages(1234, 10, SRC, 0, ['aaaaaaaaaaaaaaaa'])).map((r) => r.text)).toEqual(['keyed one']);
    expect(await repo.getChannelMessageCounts([1234, 2222], SRC, ['aaaaaaaaaaaaaaaa'])).toEqual({ 1234: 1, 2222: 0 });
    expect(Object.keys(await repo.getChannelLatestTimestamps([1234, 2222], SRC, ['aaaaaaaaaaaaaaaa']))).toEqual(['1234']);

    const scope = { sourceId: SRC, channels: 'all' as const, includeDms: true };
    expect((await repo.searchMessages({ query: 'keyed', scopes: [{ ...scope, keyAccess: [] }] })).total).toBe(0);
    expect((await repo.searchMessages({ query: 'keyed', scopes: [{ ...scope, keyAccess: ['bbbbbbbbbbbbbbbb'] }] })).total).toBe(1);
    expect((await repo.searchMessages({ query: 'keyed', scopes: [scope] })).total).toBe(2);
    const exported = await repo.getMessagesForExport({ ...scope, keyAccess: [] });
    expect(exported.map((r) => r.text)).toEqual(['plain']);

    const summaries = (await repo.getKeyedChannelSummaries(SRC)).sort((x, y) => x.channelKey.localeCompare(y.channelKey));
    expect(summaries).toEqual([
      { channelKey: 'channel-1234', keyFingerprint: 'aaaaaaaaaaaaaaaa', keySourceId: 'src-x', keyChannelIdx: 3 },
      { channelKey: 'channel-2222', keyFingerprint: 'bbbbbbbbbbbbbbbb', keySourceId: 'src-x', keyChannelIdx: 3 },
    ]);
    expect(await repo.getKeyedChannelSummaries(OTHER)).toEqual([]);
  });
}

function suite(name: string, make: () => Promise<TestBackend> | TestBackend) {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await make();
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    seq = 0;
    await clearTable(backend, 'messages');
    await clearTable(backend, 'meshcore_messages');
  });
  runExportTests(() => backend);
  return name;
}

describe('message export queries - SQLite Backend', () => {
  suite('sqlite', () => createSqliteBackend(SQLITE_CREATE));
});

describe.skipIf(!postgresAvailable)('message export queries - PostgreSQL Backend', () => {
  suite('postgres', () => createPostgresBackend(POSTGRES_CREATE, 'r_message_export'));
});

describe.skipIf(!mysqlAvailable)('message export queries - MySQL Backend', () => {
  suite('mysql', () => createMysqlBackend(MYSQL_CREATE, 'r_message_export'));
});
