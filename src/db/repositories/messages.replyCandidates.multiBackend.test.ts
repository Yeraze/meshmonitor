/**
 * MessagesRepository.getReplyCandidates on SQLite, PostgreSQL and MySQL.
 *
 * This is the query the Auto-Acknowledge response cap counts with. On
 * PostgreSQL/MySQL `fromNodeNum` and `replyId` are BIGINT (the driver may hand
 * back strings), packet ids are unsigned 32-bit (so above 2^31 must work), and
 * `emoji` is an INT. Every backend must return plain numbers and must feed the
 * shared predicates (`utils/messageReplies`) to the same count.
 *
 * The PG/MySQL suites take a private database (isolation key) — see CLAUDE.md.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MessagesRepository } from './messages.js';
import { PortNum } from '../../server/constants/meshtastic.js';
import { countDistinctResponders, isReplyTo, isTapbackOf } from '../../utils/messageReplies.js';
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
  )
`;

const SRC_A = 'src-a';
const SRC_B = 'src-b';
const NOW = 1_760_000_000_000;
const CHANNEL = 2;
/** Above 2^31: does not fit a signed 32-bit INTEGER. */
const TRIGGER_PACKET = 0xdeadbeef;
const AUTHOR = 0xfedcba98;
const LOCAL = 0x80000001;
const N1 = 0xf0000001;
const N2 = 0xf0000002;
const N3 = 0x00000203;
const PARENT = { id: `${SRC_A}_${AUTHOR}_${TRIGGER_PACKET}` };

let seq = 0;
function row(sourceId: string, from: number, over: Record<string, unknown> = {}) {
  seq += 1;
  return {
    id: `${sourceId}_${from}_${0x90000000 + seq}`,
    fromNodeNum: from,
    toNodeNum: 0xffffffff,
    fromNodeId: `!${from.toString(16).padStart(8, '0')}`,
    toNodeId: '!ffffffff',
    text: 'hi',
    channel: CHANNEL,
    portnum: PortNum.TEXT_MESSAGE_APP,
    timestamp: NOW,
    createdAt: NOW,
    ...over,
  } as any;
}

function runReplyCandidateTests(getBackend: () => TestBackend) {
  const seed = async (repo: MessagesRepository) => {
    await repo.insertMessage(row(SRC_A, N1, { text: '👍', emoji: 1, replyId: TRIGGER_PACKET }), SRC_A);   // tapback
    await repo.insertMessage(row(SRC_A, N1, { text: 'Copy, 1 hops', replyId: TRIGGER_PACKET }), SRC_A);  // same node replies too
    await repo.insertMessage(row(SRC_A, N2, { text: 'Copy, 2 hops', replyId: TRIGGER_PACKET }), SRC_A);  // reply
    await repo.insertMessage(row(SRC_A, LOCAL, { text: '1️⃣', emoji: 1, replyId: TRIGGER_PACKET }), SRC_A); // our own send
    await repo.insertMessage(row(SRC_A, AUTHOR, { text: 'anyone?', replyId: TRIGGER_PACKET }), SRC_A);   // author follow-up
    await repo.insertMessage(row(SRC_A, N3, { text: '👍', emoji: 1, replyId: TRIGGER_PACKET - 1 }), SRC_A); // other parent
    await repo.insertMessage(row(SRC_A, N3, { text: 'plain' }), SRC_A);                                   // answers nothing
    await repo.insertMessage(row(SRC_A, N3, { text: 'Copy', replyId: TRIGGER_PACKET, channel: CHANNEL + 1 }), SRC_A); // other channel
    await repo.insertMessage(row(SRC_B, N3, { text: 'Copy', replyId: TRIGGER_PACKET }), SRC_B);           // other source
  };

  it('returns the tapback and replies to a packet id above 2^31, and nothing else', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new MessagesRepository(backend.drizzleDb, backend.dbType);
    await seed(repo);

    const rows = await repo.getReplyCandidates(SRC_A, TRIGGER_PACKET, CHANNEL);
    expect(rows.map((r) => r.fromNodeNum).sort((a, b) => a - b)).toEqual([N1, N1, N2, LOCAL, AUTHOR].sort((a, b) => a - b));

    // Other parent, other channel, other source: each asked for on its own terms.
    expect((await repo.getReplyCandidates(SRC_A, TRIGGER_PACKET - 1, CHANNEL)).map((r) => r.fromNodeNum)).toEqual([N3]);
    expect((await repo.getReplyCandidates(SRC_A, TRIGGER_PACKET, CHANNEL + 1)).map((r) => r.fromNodeNum)).toEqual([N3]);
    expect((await repo.getReplyCandidates(SRC_B, TRIGGER_PACKET, CHANNEL)).map((r) => r.fromNodeNum)).toEqual([N3]);
    expect(await repo.getReplyCandidates(SRC_A, 0x7fffffff, CHANNEL)).toEqual([]);
  });

  it('hands back plain numbers after the driver: fromNodeNum, replyId, emoji', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new MessagesRepository(backend.drizzleDb, backend.dbType);
    await seed(repo);

    const rows = await repo.getReplyCandidates(SRC_A, TRIGGER_PACKET, CHANNEL);
    for (const r of rows) {
      expect(typeof r.fromNodeNum).toBe('number');
      expect(typeof r.replyId).toBe('number');
      expect(r.replyId).toBe(TRIGGER_PACKET);
      expect(r.emoji === null || typeof r.emoji === 'number').toBe(true);
      expect(typeof r.id).toBe('string');
    }
    const tap = rows.find((r) => r.fromNodeNum === N1 && r.emoji === 1);
    expect(tap).toBeDefined();
    expect(tap!.text).toBe('👍');
    // An unset emoji is null, not 0 or false.
    expect(rows.find((r) => r.fromNodeNum === N2)!.emoji).toBeNull();
  });

  it('feeds the shared predicates to the same answer on every backend', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new MessagesRepository(backend.drizzleDb, backend.dbType);
    await seed(repo);

    const rows = await repo.getReplyCandidates(SRC_A, TRIGGER_PACKET, CHANNEL);
    expect(rows.filter((r) => isTapbackOf(r, PARENT)).map((r) => r.fromNodeNum).sort((a, b) => a - b))
      .toEqual([LOCAL, N1].sort((a, b) => a - b));
    expect(rows.filter((r) => isReplyTo(r, PARENT)).map((r) => r.fromNodeNum).sort((a, b) => a - b))
      .toEqual([N1, N2, AUTHOR].sort((a, b) => a - b));

    // N1 (tapback + reply = one) and N2. Our own node and the author are left out.
    expect(countDistinctResponders(PARENT, rows, [LOCAL, AUTHOR])).toBe(2);
    // Nothing excluded: N1, N2, LOCAL, AUTHOR.
    expect(countDistinctResponders(PARENT, rows)).toBe(4);
  });
}

describe('MessagesRepository.getReplyCandidates - SQLite Backend', () => {
  let backend: TestBackend;
  beforeAll(() => { backend = createSqliteBackend(SQLITE_CREATE); });
  afterAll(async () => { if (backend) await backend.close(); });
  beforeEach(async () => { await clearTable(backend, 'messages'); });
  runReplyCandidateTests(() => backend);
});

describe.skipIf(!postgresAvailable)('MessagesRepository.getReplyCandidates - PostgreSQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => { backend = await createPostgresBackend(POSTGRES_CREATE, 'r_messages_reply_candidates'); });
  afterAll(async () => { if (backend) await backend.close(); });
  beforeEach(async () => { await clearTable(backend, 'messages'); });
  runReplyCandidateTests(() => backend);
});

describe.skipIf(!mysqlAvailable)('MessagesRepository.getReplyCandidates - MySQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => { backend = await createMysqlBackend(MYSQL_CREATE, 'r_messages_reply_candidates'); });
  afterAll(async () => { if (backend) await backend.close(); });
  beforeEach(async () => { await clearTable(backend, 'messages'); });
  runReplyCandidateTests(() => backend);
});
