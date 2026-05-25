/**
 * Regression tests for issue #3186: `NodesRepository` must guard against
 * out-of-range nodeNum inputs instead of forwarding them to the database
 * (which crashes with `invalid input syntax for type bigint` on PG and
 * silently mis-stores on SQLite). Repository methods return `null` /
 * filter out invalid values without ever issuing the broken query.
 *
 * Stand-alone SQLite scaffold — keeps the test focused on the guard
 * behavior rather than the full multi-backend integration matrix already
 * covered by `nodes.test.ts`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../schema/index.js';
import { NodesRepository } from './nodes.js';

// Mirrors the SQLite schema scaffold used by nodes.test.ts. Includes columns
// the repository touches even when this test only exercises the guards.
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS nodes (
    nodeNum INTEGER NOT NULL,
    nodeId TEXT NOT NULL,
    longName TEXT,
    shortName TEXT,
    hwModel INTEGER,
    role INTEGER,
    hopsAway INTEGER,
    lastMessageHops INTEGER,
    viaMqtt INTEGER DEFAULT 0,
    transportMechanism INTEGER,
    macaddr TEXT,
    latitude REAL,
    longitude REAL,
    altitude REAL,
    batteryLevel INTEGER,
    voltage REAL,
    channelUtilization REAL,
    airUtilTx REAL,
    lastHeard INTEGER,
    snr REAL,
    rssi INTEGER,
    lastTracerouteRequest INTEGER,
    firmwareVersion TEXT,
    channel INTEGER,
    isFavorite INTEGER DEFAULT 0,
    favoriteLocked INTEGER DEFAULT 0,
    isIgnored INTEGER DEFAULT 0,
    mobile INTEGER DEFAULT 0,
    rebootCount INTEGER,
    publicKey TEXT,
    lastMeshReceivedKey TEXT,
    hasPKC INTEGER,
    lastPKIPacket INTEGER,
    keyIsLowEntropy INTEGER,
    duplicateKeyDetected INTEGER,
    keyMismatchDetected INTEGER,
    keySecurityIssueDetails TEXT,
    isExcessivePackets INTEGER DEFAULT 0,
    packetRatePerHour INTEGER,
    packetRateLastChecked INTEGER,
    isTimeOffsetIssue INTEGER DEFAULT 0,
    timeOffsetSeconds INTEGER,
    welcomedAt INTEGER,
    positionChannel INTEGER,
    positionPrecisionBits INTEGER,
    positionGpsAccuracy REAL,
    positionHdop REAL,
    positionTimestamp INTEGER,
    positionOverrideEnabled INTEGER DEFAULT 0,
    latitudeOverride REAL,
    longitudeOverride REAL,
    altitudeOverride REAL,
    positionOverrideIsPrivate INTEGER DEFAULT 0,
    hasRemoteAdmin INTEGER DEFAULT 0,
    lastRemoteAdminCheck INTEGER,
    remoteAdminMetadata TEXT,
    lastTimeSync INTEGER,
    isStoreForwardServer INTEGER DEFAULT 0,
    createdAt INTEGER NOT NULL DEFAULT 0,
    updatedAt INTEGER NOT NULL DEFAULT 0,
    sourceId TEXT NOT NULL DEFAULT 'default',
    PRIMARY KEY (nodeNum, sourceId)
  )
`;

describe('NodesRepository — out-of-range nodeNum guards (#3186)', () => {
  let repo: NodesRepository;
  let raw: Database.Database;

  beforeEach(() => {
    raw = new Database(':memory:');
    raw.exec(SCHEMA_SQL);
    const db = drizzle(raw, { schema });
    repo = new NodesRepository(db as never, 'sqlite');
  });

  const insert = (nodeNum: number, sourceId = 'src-A', publicKey: string | null = null) => {
    raw
      .prepare(
        `INSERT INTO nodes (nodeNum, nodeId, sourceId, publicKey)
           VALUES (?, ?, ?, ?)`,
      )
      .run(nodeNum, `!${nodeNum.toString(16).padStart(8, '0')}`, sourceId, publicKey);
  };

  it('getNode returns null for an out-of-range float without querying', async () => {
    insert(123, 'src-A');
    const result = await repo.getNode(2.7130620829267897e+76, 'src-A');
    expect(result).toBeNull();
    // Sanity: known-good lookups still work after a bad call.
    const good = await repo.getNode(123, 'src-A');
    expect(good?.nodeNum).toBe(123);
  });

  it('getNode returns null for negative, fractional, and >uint32 values', async () => {
    expect(await repo.getNode(-1, 'src-A')).toBeNull();
    expect(await repo.getNode(1.5, 'src-A')).toBeNull();
    expect(await repo.getNode(0x100000000, 'src-A')).toBeNull(); // uint32 max + 1
  });

  it('getNode allows the broadcast address (uint32 max)', async () => {
    insert(0xFFFFFFFF, 'src-A');
    const result = await repo.getNode(0xFFFFFFFF, 'src-A');
    expect(result?.nodeNum).toBe(0xFFFFFFFF);
  });

  it('getNodesByNums filters out invalid entries and returns matches for the rest', async () => {
    insert(100, 'src-A');
    insert(200, 'src-A');
    const map = await repo.getNodesByNums([100, 2.7e+76, -5, 200]);
    expect(map.size).toBe(2);
    expect(map.get(100)?.nodeNum).toBe(100);
    expect(map.get(200)?.nodeNum).toBe(200);
  });

  it('getNodesByNums returns an empty map when every nodeNum is invalid', async () => {
    const map = await repo.getNodesByNums([2.7e+76, -1, NaN as unknown as number]);
    expect(map.size).toBe(0);
  });

  it('getNodeByPublicKey returns the matching node', async () => {
    insert(555, 'src-A', 'base64-pubkey-xxx');
    const node = await repo.getNodeByPublicKey('base64-pubkey-xxx', 'src-A');
    expect(node?.nodeNum).toBe(555);
  });

  it('getNodeByPublicKey returns null for unknown publicKey', async () => {
    expect(await repo.getNodeByPublicKey('no-such-key', 'src-A')).toBeNull();
  });

  it('getNodeByPublicKey returns null for empty input', async () => {
    expect(await repo.getNodeByPublicKey('', 'src-A')).toBeNull();
  });
});
